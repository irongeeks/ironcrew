import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { z } from "zod";
import { CHARACTER_SKIN_IDS } from "../../../src/shared/character-skins.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export const MAX_CHARACTER_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_COMPANY_ASSET_BYTES = 200 * 1024 * 1024;
const ASSET_ID = /^char_[a-f0-9]{32}$/;
const ASSET_URL = /^\/api\/crew\/character-assets\/(char_[a-f0-9]{32})$/;
export const characterAppearanceSchema = z
  .object({
    character_id: z.enum(CHARACTER_SKIN_IDS).nullable(),
    portrait: z.string().regex(ASSET_URL).nullable(),
    full_body: z.string().regex(ASSET_URL).nullable(),
  })
  .strict();
export const characterUploadSchema = z
  .object({
    kind: z.enum(["portrait", "full_body"]),
    contentType: z.enum(["image/png", "image/webp", "image/jpeg"]),
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
  kind: "portrait" | "full_body";
  content_type: "image/webp";
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  created_by: string;
  created_at: number;
}
interface AppearanceRow {
  character_id: string | null;
  portrait_asset_id: string | null;
  full_body_asset_id: string | null;
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
});
const presentAsset = (row: AssetRow) => ({
  id: row.id,
  url: urlFor(row.id)!,
  kind: row.kind,
  contentType: row.content_type,
  width: row.width,
  height: row.height,
  sizeBytes: row.size_bytes,
});

/** Private decoded raster files. Shared talents, professional roles and policies never change here. */
export class CharacterStore {
  private root: string | null = null;
  constructor(
    private readonly db: DatabaseSync,
    private readonly configuredRoot: string,
  ) {}

  private assetPath(id: string): string {
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
    return path.join(this.root, `${id}.webp`);
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
    return (
      this.db
        .prepare("SELECT * FROM crew_character_assets WHERE company_id = ? ORDER BY created_at DESC")
        .all(companyId) as unknown as AssetRow[]
    ).map(presentAsset);
  }

  async upload(companyId: string, raw: unknown, actor: Actor) {
    const input = characterUploadSchema.parse(raw);
    if (!this.db.prepare("SELECT id FROM crew_companies WHERE id = ?").get(companyId))
      throw new CharacterAssetError("Firma nicht gefunden.", 404);
    const source = Buffer.from(input.dataBase64, "base64");
    if (source.length > MAX_CHARACTER_UPLOAD_BYTES) throw new CharacterAssetError("Maximal 5 MiB pro Bild.", 413);
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
    let decoded: { data: Buffer; info: sharp.OutputInfo };
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
    const id = `char_${randomUUID().replace(/-/g, "")}`;
    const filePath = this.assetPath(id);
    const row: AssetRow = {
      id,
      company_id: companyId,
      kind: input.kind,
      content_type: "image/webp",
      width: decoded.info.width,
      height: decoded.info.height,
      size_bytes: decoded.data.length,
      sha256: createHash("sha256").update(decoded.data).digest("hex"),
      created_by: actor.actorId,
      created_at: Date.now(),
    };
    let written = false;
    try {
      return this.atomic(() => {
        const used = this.db
          .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS used FROM crew_character_assets WHERE company_id = ?")
          .get(companyId) as { used: number };
        if (used.used + row.size_bytes > MAX_COMPANY_ASSET_BYTES)
          throw new CharacterAssetError("Der private Bildspeicher dieser Firma ist voll (200 MiB).", 409);
        const fd = fs.openSync(
          filePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        written = true;
        try {
          fs.writeFileSync(fd, decoded.data);
        } finally {
          fs.closeSync(fd);
        }
        this.db
          .prepare(
            `INSERT INTO crew_character_assets (id,company_id,kind,content_type,width,height,size_bytes,sha256,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
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

  read(companyId: string, id: string): { buffer: Buffer; contentType: "image/webp" } {
    const row = this.db
      .prepare("SELECT * FROM crew_character_assets WHERE id = ? AND company_id = ?")
      .get(id, companyId) as unknown as AssetRow | undefined;
    if (!row) throw new CharacterAssetError("Figurdatei nicht gefunden.", 404);
    const filePath = this.assetPath(id);
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

  assign(companyId: string, agentId: string, raw: unknown, actor: Actor): CharacterAppearance {
    const input = characterAppearanceSchema.parse(raw);
    return this.atomic(() => {
      if (!this.db.prepare("SELECT id FROM crew_agents WHERE id = ? AND company_id = ?").get(agentId, companyId))
        throw new CharacterAssetError("Agent nicht gefunden.", 404);
      const ids = {
        portrait: input.portrait?.match(ASSET_URL)?.[1] ?? null,
        full_body: input.full_body?.match(ASSET_URL)?.[1] ?? null,
      };
      for (const kind of ["portrait", "full_body"] as const) {
        if (!ids[kind]) continue;
        if (
          !this.db
            .prepare("SELECT id FROM crew_character_assets WHERE id = ? AND company_id = ? AND kind = ?")
            .get(ids[kind], companyId, kind)
        ) {
          throw new CharacterAssetError("Das Bild gehört nicht zu dieser Firma oder zum gewählten Bildtyp.");
        }
      }
      const previous = this.db
        .prepare("SELECT * FROM crew_agent_appearances WHERE agent_id = ? AND company_id = ?")
        .get(agentId, companyId) as unknown as AppearanceRow | undefined;
      this.db
        .prepare(
          `INSERT INTO crew_agent_appearances (agent_id,company_id,character_id,portrait_asset_id,full_body_asset_id,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET character_id=excluded.character_id,portrait_asset_id=excluded.portrait_asset_id,full_body_asset_id=excluded.full_body_asset_id,updated_at=excluded.updated_at`,
        )
        .run(agentId, companyId, input.character_id, ids.portrait, ids.full_body, Date.now());
      this.db
        .prepare("UPDATE crew_agents SET updated_at = ? WHERE id = ? AND company_id = ?")
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
