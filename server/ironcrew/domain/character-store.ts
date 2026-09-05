import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp, { type OutputInfo } from "sharp";
import { z } from "zod";
import { CHARACTER_SKIN_IDS } from "../../../src/shared/character-skins.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { validateCharacterGlb } from "./character-glb.ts";

export const MAX_CHARACTER_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_COMPANY_ASSET_BYTES = 200 * 1024 * 1024;
const ASSET_ID = /^char_[a-f0-9]{32}$/;
const ASSET_URL = /^\/api\/crew\/character-assets\/(char_[a-f0-9]{32})$/;
export const characterAnimationSchema = z
  .object({
    url: z.string().regex(ASSET_URL),
    frameWidth: z.number().int().min(1).max(4096),
    frameHeight: z.number().int().min(1).max(4096),
    columns: z.number().int().min(1).max(64),
    states: z.partialRecord(
      z.enum([
        "offline",
        "idle",
        "thinking",
        "working",
        "in_meeting",
        "waiting_for_input",
        "waiting_for_approval",
        "rate_limited",
        "paused",
        "error",
      ]),
      z
        .object({
          row: z.number().int().min(0).max(255),
          frames: z.number().int().min(1).max(64),
          fps: z.number().min(1).max(30),
          loop: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.states).length > 0 &&
      Object.values(value.states).reduce((n, clip) => n + (clip?.frames ?? 0), 0) <= 256,
  );
export const characterAppearanceSchema = z
  .object({
    character_id: z.enum(CHARACTER_SKIN_IDS).nullable(),
    portrait: z.string().regex(ASSET_URL).nullable(),
    full_body: z.string().regex(ASSET_URL).nullable(),
    model_3d: z.string().regex(ASSET_URL).nullable().optional(),
    animation_config: characterAnimationSchema.nullable().optional(),
  })
  .strict();
export const characterUploadSchema = z
  .object({
    kind: z.enum(["portrait", "full_body", "animation", "model_3d"]),
    contentType: z.enum(["image/png", "image/webp", "image/jpeg", "model/gltf-binary"]),
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_CHARACTER_UPLOAD_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export type CharacterAppearance = z.infer<typeof characterAppearanceSchema>;
type Actor = { actorId: string; actorType: ActorType };
interface AssetRow {
  id: string;
  company_id: string;
  kind: "portrait" | "full_body" | "animation" | "model_3d";
  content_type: "image/webp" | "model/gltf-binary";
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  created_by: string;
  created_at: number;
  status: "active" | "deleting";
  metadata_json: string;
  deletion_actor_id: string | null;
  deletion_actor_type: ActorType | null;
}
interface AppearanceRow {
  character_id: string | null;
  portrait_asset_id: string | null;
  full_body_asset_id: string | null;
  model_asset_id: string | null;
  animation_asset_id: string | null;
  animation_config_json: string | null;
}
export class CharacterAssetError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
const urlFor = (id: string | null) => (id ? `/api/crew/character-assets/${id}` : null);
const presentAppearance = (row: AppearanceRow): CharacterAppearance => ({
  character_id: row.character_id as CharacterAppearance["character_id"],
  portrait: urlFor(row.portrait_asset_id),
  full_body: urlFor(row.full_body_asset_id),
  model_3d: urlFor(row.model_asset_id),
  animation_config: row.animation_config_json
    ? characterAnimationSchema.parse(JSON.parse(row.animation_config_json))
    : null,
});
const presentAsset = (row: AssetRow) => ({
  id: row.id,
  url: urlFor(row.id)!,
  kind: row.kind,
  contentType: row.content_type,
  width: row.width,
  height: row.height,
  sizeBytes: row.size_bytes,
  status: row.status,
  metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
});

/** Private validated media. Shared talents, professional roles and policies never change here. */
export class CharacterStore {
  private root: string | null = null;
  constructor(
    private readonly db: DatabaseSync,
    private readonly configuredRoot: string,
  ) {}

  private assetPath(id: string, contentType: AssetRow["content_type"] = "image/webp"): string {
    if (!ASSET_ID.test(id)) throw new CharacterAssetError("Figurdatei nicht gefunden.", 404);
    const configured = path.resolve(this.configuredRoot);
    if (!this.root) {
      if (fs.existsSync(configured) && fs.lstatSync(configured).isSymbolicLink()) {
        throw new CharacterAssetError("Der private Figurenordner darf kein Symlink sein.", 409);
      }
      fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
      this.root = fs.realpathSync(configured);
    }
    if (
      fs.lstatSync(this.root).isSymbolicLink() ||
      fs.realpathSync(this.root) !== this.root ||
      fs.realpathSync(configured) !== this.root
    ) {
      throw new CharacterAssetError("Der private Figurenordner wurde verändert.", 409);
    }
    return path.join(this.root, `${id}.${contentType === "model/gltf-binary" ? "glb" : "webp"}`);
  }

  private atomic<T>(action: () => T): T {
    this.db.exec("SAVEPOINT character_mutation");
    try {
      const result = action();
      this.db.exec("RELEASE character_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO character_mutation; RELEASE character_mutation");
      throw error;
    }
  }

  list(companyId: string) {
    this.recoverPending(companyId);
    return (
      this.db
        .prepare("SELECT * FROM crew_character_assets WHERE company_id = ? ORDER BY created_at DESC")
        .all(companyId) as unknown as AssetRow[]
    ).map((row) => ({
      ...presentAsset(row),
      inUseBy: this.usingAgents(companyId, row.id).map((agent) => agent.agent_id),
    }));
  }

  async upload(companyId: string, raw: unknown, actor: Actor) {
    const input = characterUploadSchema.parse(raw);
    this.recoverPending(companyId);
    if (!this.db.prepare("SELECT id FROM crew_companies WHERE id = ?").get(companyId))
      throw new CharacterAssetError("Firma nicht gefunden.", 404);
    const source = Buffer.from(input.dataBase64, "base64");
    if (source.length > MAX_CHARACTER_UPLOAD_BYTES) throw new CharacterAssetError("Maximal 5 MiB pro Bild.", 413);
    if (input.kind === "model_3d") {
      if (input.contentType !== "model/gltf-binary")
        throw new CharacterAssetError("Für 3D-Modelle bitte eine GLB-Datei verwenden.");
      let model: ReturnType<typeof validateCharacterGlb>;
      try {
        model = validateCharacterGlb(source);
      } catch {
        throw new CharacterAssetError(
          "Ungültiges GLB: nur eingebettete, unkomprimierte Geometrie ohne Texturen, externe Dateien oder Erweiterungen ist erlaubt.",
        );
      }
      return this.persist(companyId, input.kind, "model/gltf-binary", model.buffer, 0, 0, model.metadata, actor);
    }
    const format =
      input.contentType === "image/png" && source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "png"
        : input.contentType === "image/jpeg" && source[0] === 255 && source[1] === 216 && source[2] === 255
          ? "jpeg"
          : input.contentType === "image/webp" &&
              source.toString("ascii", 0, 4) === "RIFF" &&
              source.toString("ascii", 8, 12) === "WEBP"
            ? "webp"
            : null;
    if (!format) throw new CharacterAssetError("Bitte eine echte PNG-, JPEG- oder WebP-Datei hochladen.");
    let decoded: { data: Buffer; info: OutputInfo };
    try {
      const image = sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", animated: false });
      const meta = await image.metadata();
      if (
        meta.format !== format ||
        !meta.width ||
        !meta.height ||
        meta.width > 4096 ||
        meta.height > 4096 ||
        (meta.pages ?? 1) > 1
      ) {
        throw new Error("Unsupported image dimensions or animation");
      }
      // Re-encoding is mandatory: filenames, EXIF, profiles and appended payloads never enter storage.
      decoded = await image.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    } catch {
      throw new CharacterAssetError(
        "Das Bild ist beschädigt, animiert oder überschreitet 4096 Pixel bzw. 16 Megapixel.",
      );
    }
    return this.persist(
      companyId,
      input.kind,
      "image/webp",
      decoded.data,
      decoded.info.width,
      decoded.info.height,
      {},
      actor,
    );
  }

  private persist(
    companyId: string,
    kind: AssetRow["kind"],
    contentType: AssetRow["content_type"],
    buffer: Buffer,
    width: number,
    height: number,
    metadata: Record<string, unknown>,
    actor: Actor,
  ) {
    const id = `char_${randomUUID().replace(/-/g, "")}`;
    const filePath = this.assetPath(id, contentType);
    const row: AssetRow = {
      id,
      company_id: companyId,
      kind,
      content_type: contentType,
      width,
      height,
      size_bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      created_by: actor.actorId,
      created_at: Date.now(),
      status: "active",
      metadata_json: JSON.stringify(metadata),
      deletion_actor_id: null,
      deletion_actor_type: null,
    };
    let written = false;
    try {
      return this.atomic(() => {
        const used = this.db
          .prepare(
            "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS used FROM crew_character_assets WHERE company_id = ?",
          )
          .get(companyId) as { used: number; count: number };
        if (used.used + row.size_bytes > MAX_COMPANY_ASSET_BYTES || used.count >= 1000)
          throw new CharacterAssetError(
            "Der private Figurenspeicher dieser Firma ist voll (200 MiB / 1000 Dateien).",
            409,
          );
        const fd = fs.openSync(
          filePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        written = true;
        try {
          fs.writeFileSync(fd, buffer);
        } finally {
          fs.closeSync(fd);
        }
        this.db
          .prepare(
            `INSERT INTO crew_character_assets (id,company_id,kind,content_type,width,height,size_bytes,sha256,created_by,created_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            row.id,
            companyId,
            row.kind,
            row.content_type,
            row.width,
            row.height,
            row.size_bytes,
            row.sha256,
            row.created_by,
            row.created_at,
            row.metadata_json,
          );
        appendAuditEvent(this.db, {
          companyId,
          ...actor,
          action: "character_asset.uploaded",
          entityType: "character_asset",
          entityId: id,
          details: {
            kind: row.kind,
            width: row.width,
            height: row.height,
            sizeBytes: row.size_bytes,
            sha256: row.sha256,
          },
        });
        return presentAsset(row);
      });
    } catch (error) {
      if (written) fs.unlinkSync(filePath);
      throw error;
    }
  }

  read(companyId: string, id: string): { buffer: Buffer; contentType: AssetRow["content_type"] } {
    const row = this.db
      .prepare("SELECT * FROM crew_character_assets WHERE id = ? AND company_id = ?")
      .get(id, companyId) as unknown as AssetRow | undefined;
    if (!row || row.status !== "active") throw new CharacterAssetError("Figurdatei nicht gefunden.", 404);
    const filePath = this.assetPath(id, row.content_type);
    let fd: number;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      throw new CharacterAssetError("Figurdatei fehlt oder ist nicht sicher lesbar.", 404);
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== row.size_bytes)
        throw new CharacterAssetError("Figurdatei wurde verändert.", 409);
      const buffer = fs.readFileSync(fd);
      if (createHash("sha256").update(buffer).digest("hex") !== row.sha256)
        throw new CharacterAssetError("Figurdatei wurde verändert.", 409);
      return { buffer, contentType: row.content_type };
    } finally {
      fs.closeSync(fd);
    }
  }

  private usingAgents(companyId: string, assetId: string): Array<AppearanceRow & { agent_id: string }> {
    return this.db
      .prepare(
        `SELECT * FROM crew_agent_appearances WHERE company_id = ? AND
      (portrait_asset_id=? OR full_body_asset_id=? OR model_asset_id=? OR animation_asset_id=?)`,
      )
      .all(companyId, assetId, assetId, assetId, assetId) as unknown as Array<AppearanceRow & { agent_id: string }>;
  }

  /** A committed tombstone makes interrupted deletion private and recoverable. */
  private finishDeletion(row: AssetRow): boolean {
    if (row.status !== "deleting") return false;
    try {
      fs.unlinkSync(this.assetPath(row.id, row.content_type));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    this.atomic(() => {
      this.db
        .prepare("DELETE FROM crew_character_assets WHERE id=? AND company_id=? AND status='deleting'")
        .run(row.id, row.company_id);
      appendAuditEvent(this.db, {
        companyId: row.company_id,
        actorType: row.deletion_actor_type ?? "system",
        actorId: row.deletion_actor_id ?? "asset-recovery",
        action: "character_asset.deleted",
        entityType: "character_asset",
        entityId: row.id,
        details: { sha256: row.sha256 },
      });
    });
    return true;
  }

  recoverPending(companyId: string): { deleted: number; pending: number } {
    const rows = this.db
      .prepare("SELECT * FROM crew_character_assets WHERE company_id=? AND status='deleting'")
      .all(companyId) as unknown as AssetRow[];
    let deleted = 0;
    for (const row of rows) {
      try {
        if (this.finishDeletion(row)) deleted++;
      } catch {
        /* Tombstone remains; a later management request retries without exposing the file. */
      }
    }
    return { deleted, pending: rows.length - deleted };
  }

  delete(companyId: string, assetId: string, detach: boolean, actor: Actor) {
    const result = this.atomic(() => {
      const asset = this.db
        .prepare("SELECT * FROM crew_character_assets WHERE id=? AND company_id=?")
        .get(assetId, companyId) as unknown as AssetRow | undefined;
      if (!asset) throw new CharacterAssetError("Figurdatei nicht gefunden.", 404);
      const agents = this.usingAgents(companyId, assetId);
      if (agents.length && !detach)
        throw new CharacterAssetError(
          "Dieses Asset wird verwendet. Zum Löschen die Zuordnung ausdrücklich lösen.",
          409,
        );
      for (const agent of agents) {
        const before = presentAppearance(agent);
        this.db
          .prepare(
            `UPDATE crew_agent_appearances SET portrait_asset_id=CASE WHEN portrait_asset_id=? THEN NULL ELSE portrait_asset_id END,
          full_body_asset_id=CASE WHEN full_body_asset_id=? THEN NULL ELSE full_body_asset_id END,
          model_asset_id=CASE WHEN model_asset_id=? THEN NULL ELSE model_asset_id END,
          animation_config_json=CASE WHEN animation_asset_id=? THEN NULL ELSE animation_config_json END,
          animation_asset_id=CASE WHEN animation_asset_id=? THEN NULL ELSE animation_asset_id END,updated_at=? WHERE agent_id=? AND company_id=?`,
          )
          .run(assetId, assetId, assetId, assetId, assetId, Date.now(), agent.agent_id, companyId);
        this.db
          .prepare("UPDATE crew_agents SET updated_at=? WHERE id=? AND company_id=?")
          .run(Date.now(), agent.agent_id, companyId);
        appendAuditEvent(this.db, {
          companyId,
          ...actor,
          action: "agent.appearance_detached",
          entityType: "agent",
          entityId: agent.agent_id,
          details: { assetId, previous: before },
        });
      }
      if (asset.status !== "deleting") {
        this.db
          .prepare(
            "UPDATE crew_character_assets SET status='deleting',deletion_actor_id=?,deletion_actor_type=? WHERE id=? AND company_id=?",
          )
          .run(actor.actorId, actor.actorType, assetId, companyId);
        appendAuditEvent(this.db, {
          companyId,
          ...actor,
          action: "character_asset.deletion_requested",
          entityType: "character_asset",
          entityId: assetId,
          details: { detachedAgentIds: agents.map((a) => a.agent_id) },
        });
      }
      return {
        row: {
          ...asset,
          status: "deleting" as const,
          deletion_actor_id: asset.deletion_actor_id ?? actor.actorId,
          deletion_actor_type: asset.deletion_actor_type ?? actor.actorType,
        },
        detachedAgentIds: agents.map((a) => a.agent_id),
      };
    });
    let deleted = false;
    try {
      deleted = this.finishDeletion(result.row);
    } catch {
      /* A durable tombstone is returned as pending rather than claiming deletion. */
    }
    return { deleted, pending: !deleted, detachedAgentIds: result.detachedAgentIds };
  }

  assign(companyId: string, agentId: string, raw: unknown, actor: Actor): CharacterAppearance {
    const parsed = characterAppearanceSchema.parse(raw);
    return this.atomic(() => {
      if (!this.db.prepare("SELECT id FROM crew_agents WHERE id=? AND company_id=?").get(agentId, companyId))
        throw new CharacterAssetError("Agent nicht gefunden.", 404);
      const previous = this.db
        .prepare("SELECT * FROM crew_agent_appearances WHERE agent_id=? AND company_id=?")
        .get(agentId, companyId) as unknown as AppearanceRow | undefined;
      const input = {
        ...parsed,
        model_3d: parsed.model_3d === undefined ? urlFor(previous?.model_asset_id ?? null) : parsed.model_3d,
        animation_config:
          parsed.animation_config === undefined
            ? previous?.animation_config_json
              ? characterAnimationSchema.parse(JSON.parse(previous.animation_config_json))
              : null
            : parsed.animation_config,
      };
      const urls = {
        portrait: input.portrait,
        full_body: input.full_body,
        model_3d: input.model_3d,
        animation: input.animation_config?.url ?? null,
      };
      const ids = { portrait: null, full_body: null, model_3d: null, animation: null } as Record<
        AssetRow["kind"],
        string | null
      >;
      for (const kind of ["portrait", "full_body", "model_3d", "animation"] as const) {
        const assetId = urls[kind]?.match(ASSET_URL)?.[1];
        if (!assetId) continue;
        const asset = this.db
          .prepare("SELECT * FROM crew_character_assets WHERE id=? AND company_id=? AND kind=? AND status='active'")
          .get(assetId, companyId, kind) as unknown as AssetRow | undefined;
        if (!asset)
          throw new CharacterAssetError(
            "Das Bild gehört nicht zu dieser Firma oder zum gewählten Bildtyp, oder wird gelöscht.",
          );
        ids[kind] = assetId;
        if (kind === "animation" && input.animation_config) {
          const config = input.animation_config;
          if (config.frameWidth * config.columns > asset.width)
            throw new CharacterAssetError("Die Animationsspalten passen nicht in das Bild.");
          for (const clip of Object.values(config.states))
            if (clip && (clip.frames > config.columns || (clip.row + 1) * config.frameHeight > asset.height))
              throw new CharacterAssetError("Animationsframes liegen außerhalb des Bildes.");
        }
      }
      this.db
        .prepare(
          `INSERT INTO crew_agent_appearances (agent_id,company_id,character_id,portrait_asset_id,full_body_asset_id,model_asset_id,animation_asset_id,animation_config_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET character_id=excluded.character_id,portrait_asset_id=excluded.portrait_asset_id,full_body_asset_id=excluded.full_body_asset_id,
        model_asset_id=excluded.model_asset_id,animation_asset_id=excluded.animation_asset_id,animation_config_json=excluded.animation_config_json,updated_at=excluded.updated_at`,
        )
        .run(
          agentId,
          companyId,
          input.character_id,
          ids.portrait,
          ids.full_body,
          ids.model_3d,
          ids.animation,
          input.animation_config ? JSON.stringify(input.animation_config) : null,
          Date.now(),
        );
      this.db
        .prepare("UPDATE crew_agents SET updated_at=? WHERE id=? AND company_id=?")
        .run(Date.now(), agentId, companyId);
      appendAuditEvent(this.db, {
        companyId,
        ...actor,
        action: "agent.appearance_updated",
        entityType: "agent",
        entityId: agentId,
        details: { previous: previous ? presentAppearance(previous) : null, appearance: input },
      });
      return input;
    });
  }
}
