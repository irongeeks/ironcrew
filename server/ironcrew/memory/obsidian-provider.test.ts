import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { EventEmitter } from "node:events";
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
  vi.restoreAllMocks();
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
  it("rejects symlink escapes and out-of-vault subfolders", async () => {
    expect(() => new ObsidianProvider({ vaultPath: vaultDir, subfolder: "../escape" })).toThrow("within");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crew-outside-"));
    try {
      fs.mkdirSync(path.join(vaultDir, "IronCrew"));
      fs.symlinkSync(outside, path.join(vaultDir, "IronCrew", "note"), "dir");
      await expect(provider.write({ kind: "note", title: "x", content: "secret" })).rejects.toThrow("symlinks");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it("encodes multiline titles and provenance without injecting frontmatter fields", async () => {
    const result = await provider.write({
      kind: "note",
      title: "Safe\nsensitivity: public",
      content: "body",
      provenance: { companyId: "company", sensitivity: "restricted" },
    });
    const raw = (await provider.read(result.externalId))!;
    expect(raw).toContain("sensitivity: restricted");
    expect(raw).not.toContain("\nsensitivity: public\n");
    expect(raw).toContain(`id: ${result.externalId}`);
  });
  it("emits file watcher events for externally edited markdown", async () => {
    const written = await provider.write({ kind: "note", title: "watched", content: "before" });
    let notify!: (id: string) => void;
    let fail!: (error: Error) => void;
    const changed = new Promise<string>((resolve, reject) => {
      notify = resolve;
      fail = reject;
    });
    const close = provider.watch(
      (id) => notify(id),
      (error) => fail(error),
    );
    try {
      fs.appendFileSync(path.join(vaultDir, written.path!), "\nExternal edit");
      expect(await changed).toBe(written.externalId);
      expect(await provider.search("External edit")).toHaveLength(1);
      // The registration reconciliation already ran. A subsequent edit must now
      // arrive through a real native event, not only that one startup scan.
      const laterChange = new Promise<string>((resolve, reject) => {
        notify = resolve;
        fail = reject;
      });
      fs.appendFileSync(path.join(vaultDir, written.path!), "\nLater native edit");
      expect(await laterChange).toBe(written.externalId);
      expect(await provider.search("Later native edit")).toHaveLength(1);
    } finally {
      close();
    }
  });
});

describe("Obsidian watcher reconciliation", () => {
  function controlledWatch() {
    const handles: Array<{
      target: string;
      callback: (event: string, filename: string | null) => void;
      close: ReturnType<typeof vi.fn>;
      emitter: EventEmitter;
    }> = [];
    vi.spyOn(fs, "watch").mockImplementation(((target: fs.PathLike, options: unknown, listener?: unknown) => {
      const callback = (typeof options === "function" ? options : listener) as (
        event: string,
        filename: string | null,
      ) => void;
      const emitter = new EventEmitter();
      const close = vi.fn();
      handles.push({ target: String(target), callback, close, emitter });
      return Object.assign(emitter, {
        close,
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      }) as unknown as fs.FSWatcher;
    }) as typeof fs.watch);
    return handles;
  }

  it("reconciles directory-only and null events, detects deletions, and deduplicates unchanged notifications", async () => {
    const written = await provider.write({ kind: "note", title: "coarse", content: "before" });
    const handles = controlledWatch();
    const changed = vi.fn();
    const failed = vi.fn();
    const close = provider.watch(changed, failed);
    try {
      await Promise.resolve(); // Drain the one registration-boundary reconciliation.
      fs.appendFileSync(path.join(vaultDir, written.path!), "after");
      handles[0].callback("change", "note");
      handles[0].callback("change", null);
      await Promise.resolve();
      expect(changed.mock.calls).toEqual([[written.externalId]]);
      handles[0].callback("change", null);
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(1);
      fs.unlinkSync(path.join(vaultDir, written.path!));
      handles[0].callback("rename", "note");
      await Promise.resolve();
      expect(changed.mock.calls).toEqual([[written.externalId], [written.externalId]]);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      close();
    }
    expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true);
  });

  it("rebinds an atomically replaced inode and subsequently receives its direct file events", async () => {
    const written = await provider.write({ kind: "note", title: "replacement", content: "before" });
    const full = path.join(vaultDir, written.path!);
    const handles = controlledWatch();
    const changed = vi.fn();
    const close = provider.watch(changed, (error) => {
      throw error;
    });
    try {
      await Promise.resolve();
      const original = handles.find((handle) => handle.target === full)!;
      fs.writeFileSync(`${full}.tmp`, "replacement");
      fs.renameSync(`${full}.tmp`, full);
      handles[0].callback("rename", null);
      await Promise.resolve();
      const replacement = handles.filter((handle) => handle.target === full).at(-1)!;
      expect(replacement).not.toBe(original);
      expect(original.close).toHaveBeenCalledOnce();
      fs.appendFileSync(full, "second edit");
      replacement.callback("change", null);
      await Promise.resolve();
      expect(changed.mock.calls).toEqual([[written.externalId], [written.externalId]]);
    } finally {
      close();
    }
    expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true);
  });

  it("does not watch symlink targets and closes every handle on failure before queued work runs", async () => {
    const written = await provider.write({ kind: "note", title: "safe", content: "before" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crew-watch-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "outside");
      fs.symlinkSync(outside, path.join(vaultDir, "IronCrew", "linked"), "dir");
      const handles = controlledWatch();
      const changed = vi.fn();
      const failed = vi.fn();
      const close = provider.watch(changed, failed);
      expect(handles.map((handle) => handle.target)).toEqual([
        path.join(vaultDir, "IronCrew"),
        path.join(vaultDir, written.path!),
      ]);
      const failure = new Error("watch backend unavailable");
      handles[0].emitter.emit("error", failure);
      close();
      await Promise.resolve();
      expect(changed).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith(failure);
      expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
