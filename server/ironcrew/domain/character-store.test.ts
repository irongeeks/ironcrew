import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { CharacterStore, MAX_CHARACTER_UPLOAD_BYTES } from "./character-store.ts";
import { packGlb, triangleDocument } from "./character-glb.fixture.ts";
import { RESOLVED_AGENT_SELECT } from "./agent-resolution.ts";
import { verifyAuditChain } from "./audit.ts";
import { CHARACTER_SKINS } from "../../../src/shared/character-skins.ts";

const actor = { actorType: "owner" as const, actorId: "owner-test" };
let db: DatabaseSync;
let directory: string;
let companyId: string;
let agentId: string;
let store: CharacterStore;
const appearance = { character_id: "android", portrait: null, full_body: null };
const png = () =>
  sharp({ create: { width: 48, height: 64, channels: 4, background: { r: 40, g: 100, b: 120, alpha: 0.5 } } })
    .png()
    .toBuffer();
const input = async () => ({
  kind: "full_body",
  contentType: "image/png",
  dataBase64: (await png()).toString("base64"),
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-characters-"));
  db = createTestDb(path.join(directory, "crew.sqlite"));
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  store = new CharacterStore(db, path.join(directory, "assets"));
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("private character appearances", () => {
  it("stores real GLB and sprite geometry, persists both appearances and preserves omitted new fields", async () => {
    const model = await store.upload(
      companyId,
      {
        kind: "model_3d",
        contentType: "model/gltf-binary",
        dataBase64: packGlb().toString("base64"),
      },
      actor,
    );
    const sprite = await store.upload(companyId, { ...(await input()), kind: "animation" }, actor);
    const animation = {
      url: sprite.url,
      frameWidth: 24,
      frameHeight: 32,
      columns: 2,
      states: { working: { row: 1, frames: 2, fps: 12, loop: true } },
    };
    store.assign(companyId, agentId, { ...appearance, model_3d: model.url, animation_config: animation }, actor);
    expect(store.read(companyId, model.id).contentType).toBe("model/gltf-binary");
    expect(store.read(companyId, model.id).buffer.includes(Buffer.from("discard-me"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "assets", `${model.id}.glb`))).toBe(true);
    db.close();
    db = new DatabaseSync(path.join(directory, "crew.sqlite"));
    store = new CharacterStore(db, path.join(directory, "assets"));
    const preserved = store.assign(companyId, agentId, { ...appearance, character_id: "navigator" }, actor);
    expect(preserved).toMatchObject({ model_3d: model.url, animation_config: animation });
    const resolved = db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id=?`).get(agentId) as { persona_json: string };
    expect(JSON.parse(resolved.persona_json)).toMatchObject({ model_3d: model.url, animation_config: animation });
    expect(store.list(companyId).every((asset) => asset.inUseBy.includes(agentId))).toBe(true);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("rejects unsafe model uploads and sprite frames outside the decoded sheet", async () => {
    await expect(
      store.upload(
        companyId,
        {
          kind: "model_3d",
          contentType: "model/gltf-binary",
          dataBase64: packGlb({
            ...triangleDocument(),
            buffers: [{ byteLength: 36, uri: "https://example.invalid/model" }],
          }).toString("base64"),
        },
        actor,
      ),
    ).rejects.toThrow("Ungültiges GLB");
    await expect(store.upload(companyId, { ...(await input()), kind: "model_3d" }, actor)).rejects.toThrow("GLB-Datei");
    const sprite = await store.upload(companyId, { ...(await input()), kind: "animation" }, actor);
    const valid = {
      url: sprite.url,
      frameWidth: 24,
      frameHeight: 32,
      columns: 2,
      states: { idle: { row: 0, frames: 2, fps: 12, loop: true } },
    };
    for (const animation of [
      { ...valid, frameWidth: 25 },
      { ...valid, states: { idle: { row: 2, frames: 2, fps: 12, loop: true } } },
      { ...valid, states: { idle: { row: 0, frames: 3, fps: 12, loop: true } } },
      { ...valid, states: { unknown: { row: 0, frames: 1, fps: 12, loop: true } } },
      { ...valid, states: {} },
    ])
      expect(() => store.assign(companyId, agentId, { ...appearance, animation_config: animation }, actor)).toThrow();
    const otherCompany = seedCompany(db);
    const otherAgent = seedAgent(db, otherCompany);
    expect(() => store.assign(otherCompany, otherAgent, { ...appearance, animation_config: valid }, actor)).toThrow(
      "gehört nicht",
    );
    expect(() => store.assign(companyId, agentId, { ...appearance, model_3d: sprite.url }, actor)).toThrow("Bildtyp");
    expect(db.prepare("SELECT * FROM crew_agent_appearances").all()).toEqual([]);
  });

  it("requires explicit detach, deletes the real file and only clears references to that asset", async () => {
    const body = await store.upload(companyId, await input(), actor);
    const sprite = await store.upload(companyId, { ...(await input()), kind: "animation" }, actor);
    const animation = {
      url: sprite.url,
      frameWidth: 24,
      frameHeight: 32,
      columns: 2,
      states: { idle: { row: 0, frames: 2, fps: 12, loop: true } },
    };
    store.assign(companyId, agentId, { ...appearance, full_body: body.url, animation_config: animation }, actor);
    const before = db.prepare("SELECT * FROM crew_talents").all();
    expect(() => store.delete(companyId, sprite.id, false, actor)).toThrow("ausdrücklich");
    expect(() => store.delete(seedCompany(db), sprite.id, true, actor)).toThrow("nicht gefunden");
    expect(store.read(companyId, sprite.id).buffer.length).toBeGreaterThan(0);
    expect(store.delete(companyId, sprite.id, true, actor)).toEqual({
      deleted: true,
      pending: false,
      detachedAgentIds: [agentId],
    });
    expect(fs.existsSync(path.join(directory, "assets", `${sprite.id}.webp`))).toBe(false);
    expect(() => store.read(companyId, sprite.id)).toThrow("nicht gefunden");
    const resolved = db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id=?`).get(agentId) as { persona_json: string };
    expect(JSON.parse(resolved.persona_json)).toMatchObject({
      character_id: "android",
      full_body: body.url,
      animation_config: null,
    });
    expect(db.prepare("SELECT * FROM crew_talents").all()).toEqual(before);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const actions = db.prepare("SELECT action FROM crew_audit_events ORDER BY seq DESC LIMIT 3").all();
    expect(actions).toEqual([
      { action: "character_asset.deleted" },
      { action: "character_asset.deletion_requested" },
      { action: "agent.appearance_detached" },
    ]);
  });

  it("recovers a durable deletion after unlink fails, without serving or reassigning pending files", async () => {
    const asset = await store.upload(companyId, await input(), actor);
    const file = path.join(directory, "assets", `${asset.id}.webp`);
    const original = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (target === file) throw Object.assign(new Error("file busy"), { code: "EACCES" });
      original(target);
    });
    expect(store.delete(companyId, asset.id, false, actor)).toMatchObject({ deleted: false, pending: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(() => store.read(companyId, asset.id)).toThrow("nicht gefunden");
    expect(() => store.assign(companyId, agentId, { ...appearance, full_body: asset.url }, actor)).toThrow("gelöscht");
    expect(store.list(companyId)[0].status).toBe("deleting");
    vi.restoreAllMocks();
    db.close();
    db = new DatabaseSync(path.join(directory, "crew.sqlite"));
    store = new CharacterStore(db, path.join(directory, "assets"));
    expect(store.recoverPending(companyId)).toEqual({ deleted: 1, pending: 0 });
    expect(fs.existsSync(file)).toBe(false);
    expect(store.list(companyId)).toEqual([]);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("recovers when unlink succeeded but the final database/audit transaction failed", async () => {
    const asset = await store.upload(companyId, await input(), actor);
    db.exec(`CREATE TRIGGER reject_delete_audit BEFORE INSERT ON crew_audit_events
      WHEN NEW.action = 'character_asset.deleted' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(store.delete(companyId, asset.id, false, actor).pending).toBe(true);
    expect(fs.existsSync(path.join(directory, "assets", `${asset.id}.webp`))).toBe(false);
    expect(db.prepare("SELECT status FROM crew_character_assets WHERE id=?").get(asset.id)).toEqual({
      status: "deleting",
    });
    db.exec("DROP TRIGGER reject_delete_audit");
    expect(store.recoverPending(companyId)).toEqual({ deleted: 1, pending: 0 });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("offers twenty unique original skin IDs and rejects unknown presets or role mutation", () => {
    expect(CHARACTER_SKINS).toHaveLength(20);
    expect(new Set(CHARACTER_SKINS.map((skin) => skin.id)).size).toBe(20);
    expect(() => store.assign(companyId, agentId, { ...appearance, character_id: "arbitrary" }, actor)).toThrow();
    expect(() => store.assign(companyId, agentId, { ...appearance, policy: { may_approve: true } }, actor)).toThrow();
    expect(() =>
      store.assign(companyId, agentId, { ...appearance, full_body: "https://example.com/picture.png" }, actor),
    ).toThrow();
    expect(() => store.assign(companyId, agentId, { ...appearance, portrait: "../../etc/passwd" }, actor)).toThrow();
  });

  it("persists appearance across reopening, without changing a shared talent or another agent", async () => {
    const colleague = seedAgent(db, companyId, "colleague");
    db.prepare("UPDATE crew_agents SET talent_id = (SELECT talent_id FROM crew_agents WHERE id = ?) WHERE id = ?").run(
      agentId,
      colleague,
    );
    const before = db.prepare("SELECT * FROM crew_talents ORDER BY id").all();
    const asset = await store.upload(companyId, await input(), actor);
    store.assign(companyId, agentId, { ...appearance, full_body: asset.url }, actor);
    db.close();
    db = new DatabaseSync(path.join(directory, "crew.sqlite"));
    store = new CharacterStore(db, path.join(directory, "assets"));
    const assigned = db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as {
      persona_json: string;
      professional_role: string;
    };
    const other = db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(colleague) as { persona_json: string };
    expect(JSON.parse(assigned.persona_json)).toMatchObject({ character_id: "android", full_body: asset.url });
    expect(JSON.parse(other.persona_json).character_id).toBeUndefined();
    expect(db.prepare("SELECT * FROM crew_talents ORDER BY id").all()).toEqual(before);
    expect(store.read(companyId, asset.id).buffer.length).toBe(asset.sizeBytes);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const audit = db
      .prepare("SELECT action, actor_id, details_json FROM crew_audit_events WHERE company_id = ? ORDER BY seq")
      .all(companyId) as Array<{ action: string; actor_id: string; details_json: string }>;
    expect(audit.map((row) => row.action)).toEqual(["character_asset.uploaded", "agent.appearance_updated"]);
    expect(audit.every((row) => row.actor_id === actor.actorId)).toBe(true);
    expect(audit[1].details_json).toContain(asset.url);
  });

  it("rolls back appearance and uploaded files if the audit record cannot be committed", async () => {
    db.exec(`CREATE TRIGGER reject_character_audit BEFORE INSERT ON crew_audit_events
      WHEN NEW.action IN ('agent.appearance_updated', 'character_asset.uploaded')
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(() => store.assign(companyId, agentId, appearance, actor)).toThrow("audit unavailable");
    expect(db.prepare("SELECT * FROM crew_agent_appearances").all()).toEqual([]);
    await expect(store.upload(companyId, await input(), actor)).rejects.toThrow("audit unavailable");
    expect(store.list(companyId)).toEqual([]);
    expect(fs.readdirSync(path.join(directory, "assets"))).toEqual([]);
  });

  it("enforces company and image-kind boundaries for reads and assignments", async () => {
    const asset = await store.upload(companyId, await input(), actor);
    const otherCompany = seedCompany(db, "Other company");
    const otherAgent = seedAgent(db, otherCompany);
    expect(store.list(otherCompany)).toEqual([]);
    expect(() => store.read(otherCompany, asset.id)).toThrow("nicht gefunden");
    expect(() => store.assign(otherCompany, otherAgent, { ...appearance, full_body: asset.url }, actor)).toThrow(
      "gehört nicht",
    );
    expect(() => store.assign(otherCompany, agentId, appearance, actor)).toThrow("Agent nicht gefunden");
    expect(() => store.assign(companyId, agentId, { ...appearance, portrait: asset.url }, actor)).toThrow("Bildtyp");
  });

  it("decodes and re-encodes images, strips appended data, and stores owner-only files", async () => {
    const bytes = Buffer.concat([await png(), Buffer.from("PRIVATE-TRAILER-MUST-NOT-BE-STORED")]);
    const asset = await store.upload(companyId, { ...(await input()), dataBase64: bytes.toString("base64") }, actor);
    const { buffer } = store.read(companyId, asset.id);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(48);
    expect(metadata.height).toBe(64);
    expect(metadata.exif).toBeUndefined();
    expect(buffer.includes(Buffer.from("PRIVATE-TRAILER"))).toBe(false);
    expect(fs.statSync(path.join(directory, "assets", `${asset.id}.webp`)).mode & 0o777).toBe(0o600);
  });

  it("rejects scripts, mismatched types, malformed rasters, oversized images and excessive input", async () => {
    await expect(
      store.upload(
        companyId,
        { ...(await input()), dataBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64") },
        actor,
      ),
    ).rejects.toThrow("echte PNG");
    await expect(store.upload(companyId, { ...(await input()), contentType: "image/jpeg" }, actor)).rejects.toThrow(
      "echte PNG",
    );
    await expect(
      store.upload(
        companyId,
        { ...(await input()), dataBase64: (await png()).subarray(0, 30).toString("base64") },
        actor,
      ),
    ).rejects.toThrow("beschädigt");
    const tooWide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    await expect(
      store.upload(companyId, { ...(await input()), dataBase64: tooWide.toString("base64") }, actor),
    ).rejects.toThrow("4096");
    await expect(
      store.upload(
        companyId,
        { ...(await input()), dataBase64: Buffer.alloc(MAX_CHARACTER_UPLOAD_BYTES + 3).toString("base64") },
        actor,
      ),
    ).rejects.toThrow();
    expect(store.list(companyId)).toEqual([]);
  });

  it("refuses symlink roots and replaced image files, and detects tampering", async () => {
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    const alias = path.join(directory, "alias");
    fs.symlinkSync(outside, alias);
    await expect(new CharacterStore(db, alias).upload(companyId, await input(), actor)).rejects.toThrow("Symlink");
    const asset = await store.upload(companyId, await input(), actor);
    const assetPath = path.join(directory, "assets", `${asset.id}.webp`);
    const original = fs.readFileSync(assetPath);
    fs.unlinkSync(assetPath);
    fs.writeFileSync(path.join(outside, "private.webp"), original);
    fs.symlinkSync(path.join(outside, "private.webp"), assetPath);
    expect(() => store.read(companyId, asset.id)).toThrow("nicht sicher");
    fs.unlinkSync(assetPath);
    fs.writeFileSync(assetPath, Buffer.alloc(original.length));
    expect(() => store.read(companyId, asset.id)).toThrow("verändert");
  });
});
