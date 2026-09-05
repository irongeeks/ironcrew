import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { CharacterStore, MAX_CHARACTER_UPLOAD_BYTES } from "./character-store.ts";
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
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("private character appearances", () => {
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
