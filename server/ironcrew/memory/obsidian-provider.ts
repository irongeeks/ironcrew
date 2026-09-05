/**
 * IronCrew — Obsidian vault MemoryProvider.
 *
 * An Obsidian vault is just a folder of Markdown files — no daemon, no API,
 * nothing to shell out to. Writing a memory entry here writes a real .md
 * file with YAML frontmatter under "<vaultPath>/<subfolder>/<kind>/", which
 * a human can open directly in Obsidian, complete with the wikilink-style
 * cross-references Obsidian expects; reading, deleting and searching walk
 * the same files back. This is deliberately the simplest possible correct
 * implementation — no fake success, no placeholder content: every method
 * here does real filesystem I/O, same posture as attachment-storage.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { dump } from "js-yaml";
import { readCurrentProvenance } from "./current-provenance.ts";
import { newId } from "../domain/ids.ts";
import type {
  MemoryConnectionStatus,
  MemoryProvider,
  MemorySearchHit,
  MemoryWriteInput,
  MemoryWriteResult,
} from "./memory-provider.ts";

export interface ObsidianProviderOptions {
  /** Root of the Obsidian vault on disk. Must already exist. */
  vaultPath: string;
  /** Subfolder within the vault IronCrew writes to and searches under. Defaults to "IronCrew". */
  subfolder?: string;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritical marks left by NFKD normalization
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "note";
}

function frontmatter(entry: MemoryWriteInput, createdAt: string, id: string): string {
  const meta = {
    id,
    kind: entry.kind,
    created: createdAt,
    updated: createdAt,
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
    ...(entry.provenance ?? {}),
  };
  return `---\ntitle: ${JSON.stringify(entry.title)}\n${dump(meta)}---\n\n`;
}

export class ObsidianProvider implements MemoryProvider {
  readonly kind = "obsidian" as const;

  private readonly vaultPath: string;
  private readonly root: string;

  constructor(opts: ObsidianProviderOptions) {
    this.vaultPath = path.resolve(opts.vaultPath);
    this.root = path.resolve(this.vaultPath, opts.subfolder ?? "IronCrew");
    if (this.root !== this.vaultPath && !this.root.startsWith(this.vaultPath + path.sep)) {
      throw new Error("Memory subfolder must stay within the vault.");
    }
    this.assertNoSymlink(this.root);
  }

  private assertNoSymlink(target: string): void {
    let current = this.vaultPath;
    const relative = path.relative(this.vaultPath, target);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Memory paths must not follow symlinks.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /**
   * Observe edits without polling. macOS uses kqueue for files, FSEvents for
   * directories; filenames may be missing and watches remain on replaced inodes.
   * https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats
   */
  watch(onChange: (externalId: string) => void, onError: (error: Error) => void): () => void {
    this.assertNoSymlink(this.root);
    fs.mkdirSync(this.root, { recursive: true });
    const files = new Map<string, { signature: string; inode: string; watcher: fs.FSWatcher }>();
    let directoryWatcher: fs.FSWatcher | undefined;
    let closed = false;
    let queued = false;
    const close = () => {
      if (closed) return;
      closed = true;
      directoryWatcher?.close();
      for (const file of files.values()) file.watcher.close();
      files.clear();
    };
    const fail = (error: unknown) => {
      if (closed) return;
      close();
      onError(error instanceof Error ? error : new Error("Memory watcher failed."));
    };
    const reconcile = (notify: boolean) => {
      if (closed) return;
      const found = new Map<string, { signature: string; inode: string; full: string }>();
      const walk = (directory: string) => {
        this.assertNoSymlink(directory);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          this.assertNoSymlink(full);
          let stat: fs.BigIntStats;
          try {
            stat = fs.lstatSync(full, { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (!stat.isFile()) continue;
          const id = path.relative(this.root, full).slice(0, -3).split(path.sep).join("/");
          found.set(id, {
            full,
            inode: `${stat.dev}:${stat.ino}`,
            signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
          });
        }
      };
      walk(this.root);
      const changed: string[] = [];
      for (const [id, next] of found) {
        const previous = files.get(id);
        const differs = !previous || previous.signature !== next.signature;
        if (!previous || previous.inode !== next.inode) {
          previous?.watcher.close();
          // Direct file watches are registered before watch() returns; do not rely
          // solely on the asynchronous directory stream for existing-file edits.
          let watcher: fs.FSWatcher;
          try {
            watcher = fs.watch(next.full, schedule);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              schedule();
              continue;
            }
            throw error;
          }
          watcher.on("error", fail);
          files.set(id, { ...next, watcher });
        } else previous.signature = next.signature;
        if (notify && differs) changed.push(id);
      }
      for (const [id, previous] of files) {
        if (found.has(id)) continue;
        previous.watcher.close();
        files.delete(id);
        if (notify) changed.push(id);
      }
      for (const id of changed) if (!closed) onChange(id);
    };
    function schedule() {
      if (closed || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        try {
          reconcile(true);
        } catch (error) {
          fail(error);
        }
      });
    }
    try {
      // Reconcile on every event, including directory-only and missing filenames.
      directoryWatcher = fs.watch(this.root, { recursive: true }, schedule);
      directoryWatcher.on("error", fail);
      reconcile(false);
      // One registration-boundary reconciliation, not an interval/readiness sleep.
      schedule();
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }

  /** externalId is always "<kind>/<generated-filename>" — see write(). Defense in depth against path traversal, same posture as AttachmentStorage#resolve. */
  private resolve(externalId: string): string {
    const filePath = path.resolve(this.root, `${externalId}.md`);
    if (filePath !== this.root && !filePath.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to resolve a memory id outside the vault's IronCrew folder: "${externalId}"`);
    }
    this.assertNoSymlink(filePath);
    return filePath;
  }

  async write(entry: MemoryWriteInput): Promise<MemoryWriteResult> {
    if (!entry.title.trim()) throw new Error("A memory entry needs a title.");
    const kindDir = path.join(this.root, entry.kind);
    this.assertNoSymlink(kindDir);
    fs.mkdirSync(kindDir, { recursive: true });

    const filename = `${newId("mem")}-${slugify(entry.title)}`;
    const externalId = `${entry.kind}/${filename}`;
    const filePath = this.resolve(externalId);
    const body = frontmatter(entry, new Date().toISOString(), externalId) + entry.content.trimEnd() + "\n";
    fs.writeFileSync(filePath, body, "utf8");

    return { externalId, path: path.relative(this.vaultPath, filePath) };
  }

  async read(externalId: string): Promise<string | null> {
    try {
      return fs.readFileSync(this.resolve(externalId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(externalId: string): Promise<void> {
    try {
      fs.unlinkSync(this.resolve(externalId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async search(query: string, limit = 20): Promise<MemorySearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: MemorySearchHit[] = [];

    const walk = (dir: string): void => {
      this.assertNoSymlink(dir);
      if (hits.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // Vault folder not created yet — an empty vault has no hits, not an error.
      }
      for (const dirEntry of entries) {
        if (hits.length >= limit) return;
        const full = path.join(dir, dirEntry.name);
        if (dirEntry.isDirectory()) {
          walk(full);
        } else if (dirEntry.isFile() && dirEntry.name.endsWith(".md")) {
          const content = fs.readFileSync(full, "utf8");
          const idx = content.toLowerCase().indexOf(needle);
          if (idx === -1) continue;
          const externalId = path.relative(this.root, full).replace(/\.md$/, "").split(path.sep).join("/");
          const titleMatch = content.match(/title:\s*"(.*)"/);
          const snippetStart = Math.max(0, idx - 40);
          const provenance = readCurrentProvenance(content);
          hits.push({
            ...(provenance ? { provenance } : {}),
            externalId,
            title: titleMatch ? titleMatch[1] : externalId,
            snippet: content
              .slice(snippetStart, idx + needle.length + 40)
              .replace(/\s+/g, " ")
              .trim(),
            path: path.relative(this.vaultPath, full),
          });
        }
      }
    };
    walk(this.root);
    return hits;
  }

  async testConnection(): Promise<MemoryConnectionStatus> {
    try {
      fs.accessSync(this.vaultPath, fs.constants.F_OK);
    } catch {
      return { ok: false, message: `Vault-Pfad existiert nicht: "${this.vaultPath}"` };
    }
    try {
      this.assertNoSymlink(this.root);
      fs.mkdirSync(this.root, { recursive: true });
      const probe = path.join(this.root, `.ironcrew-probe-${Date.now()}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return { ok: true, message: `Vault erreichbar unter "${this.vaultPath}".` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
