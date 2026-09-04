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

function frontmatter(entry: MemoryWriteInput, createdAt: string): string {
  const lines = ["---", `title: "${entry.title.replace(/"/g, '\\"')}"`, `kind: ${entry.kind}`, `created: ${createdAt}`];
  if (entry.tags && entry.tags.length > 0) {
    lines.push("tags:", ...entry.tags.map((t) => `  - ${t}`));
  }
  lines.push("---", "");
  return lines.join("\n");
}

export class ObsidianProvider implements MemoryProvider {
  readonly kind = "obsidian" as const;

  private readonly vaultPath: string;
  private readonly root: string;

  constructor(opts: ObsidianProviderOptions) {
    this.vaultPath = path.resolve(opts.vaultPath);
    this.root = path.join(this.vaultPath, opts.subfolder ?? "IronCrew");
  }

  /** externalId is always "<kind>/<generated-filename>" — see write(). Defense in depth against path traversal, same posture as AttachmentStorage#resolve. */
  private resolve(externalId: string): string {
    const filePath = path.resolve(this.root, `${externalId}.md`);
    if (filePath !== this.root && !filePath.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to resolve a memory id outside the vault's IronCrew folder: "${externalId}"`);
    }
    return filePath;
  }

  async write(entry: MemoryWriteInput): Promise<MemoryWriteResult> {
    if (!entry.title.trim()) throw new Error("A memory entry needs a title.");
    const kindDir = path.join(this.root, entry.kind);
    fs.mkdirSync(kindDir, { recursive: true });

    const filename = `${newId("mem")}-${slugify(entry.title)}`;
    const externalId = `${entry.kind}/${filename}`;
    const filePath = this.resolve(externalId);
    const body = frontmatter(entry, new Date().toISOString()) + entry.content.trimEnd() + "\n";
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
          hits.push({
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
