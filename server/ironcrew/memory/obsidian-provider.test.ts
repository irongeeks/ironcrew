import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ObsidianProvider } from "./obsidian-provider.ts";

let vaultDir: string;
let provider: ObsidianProvider;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-vault-"));
  provider = new ObsidianProvider({ vaultPath: vaultDir });
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe("ObsidianProvider", () => {
  it("writes a real markdown file with YAML frontmatter under IronCrew/<kind>/", async () => {
    const result = await provider.write({ kind: "note", title: "Hello world", content: "Some content." });
    expect(result.externalId).toMatch(/^note\/mem_.+/);
    expect(result.path).toMatch(/^IronCrew[/\\]note[/\\]mem_.+\.md$/);

    const filePath = path.join(vaultDir, result.path!);
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain('title: "Hello world"');
    expect(raw).toContain("kind: note");
    expect(raw).toContain("Some content.");
  });

  it("includes tags in the frontmatter when given", async () => {
    const result = await provider.write({
      kind: "fact",
      title: "Deploy window",
      content: "x",
      tags: ["ops", "deploy"],
    });
    const raw = fs.readFileSync(path.join(vaultDir, result.path!), "utf8");
    expect(raw).toContain("tags:");
    expect(raw).toContain("- ops");
    expect(raw).toContain("- deploy");
  });

  it("reads a written entry back, and returns null for a nonexistent one", async () => {
    const result = await provider.write({ kind: "note", title: "Readable", content: "the body" });
    const content = await provider.read(result.externalId);
    expect(content).toContain("the body");
    expect(await provider.read("note/mem_does_not_exist")).toBeNull();
  });

  it("deletes an entry; a second delete is a no-op", async () => {
    const result = await provider.write({ kind: "note", title: "Temp", content: "x" });
    await provider.delete(result.externalId);
    expect(await provider.read(result.externalId)).toBeNull();
    await expect(provider.delete(result.externalId)).resolves.not.toThrow();
  });

  it("searches written content and returns a snippet", async () => {
    await provider.write({ kind: "note", title: "Backup policy", content: "Nightly backups run at 02:00 UTC." });
    await provider.write({ kind: "fact", title: "Unrelated", content: "Something else entirely." });

    const hits = await provider.search("nightly backups");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Backup policy");
    expect(hits[0].snippet.toLowerCase()).toContain("nightly backups");
  });

  it("returns no hits for an empty query or an empty vault", async () => {
    expect(await provider.search("")).toEqual([]);
    expect(await provider.search("anything")).toEqual([]);
  });

  it("refuses to resolve an id that would escape the IronCrew folder", async () => {
    await expect(provider.read("../../etc/passwd")).rejects.toThrow(/outside the vault/);
  });

  it("testConnection reports ok once the vault path exists and is writable", async () => {
    const status = await provider.testConnection();
    expect(status.ok).toBe(true);
  });

  it("testConnection reports not-ok when the vault path does not exist", async () => {
    const missing = new ObsidianProvider({ vaultPath: path.join(vaultDir, "does-not-exist") });
    const status = await missing.testConnection();
    expect(status.ok).toBe(false);
  });
});
