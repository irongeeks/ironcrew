import fs from "node:fs";
import path from "node:path";
import {
  buildSnippet,
  extractTags,
  extractWikilinks,
  normalizeNoteTitle,
  pathToWikilinkTarget,
  titleFromPath,
  wikilinkTargetToPath,
} from "./wikilinks.ts";
import type { DocsNoteSummary, DocsSearchResult, DocsProviderView } from "./types.ts";

type SearchInput = {
  query: string;
  limit?: number;
  tags?: string[];
};

function normalizeRelPath(input: string): string {
  const value = String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!value) return "";
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error("invalid_relative_path");
  }
  return normalized;
}

function ensureInsideRoot(root: string, candidate: string): string {
  const absRoot = path.resolve(root);
  const absCandidate = path.resolve(candidate);
  const rel = path.relative(absRoot, absCandidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path_outside_vault");
  }
  return absCandidate;
}

function collectMarkdownFiles(root: string, dir: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.name === ".obsidian") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(root, abs, out, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    out.push(path.relative(root, abs).replace(/\\/g, "/"));
  }
}

function readUtf8Safe(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

export class ObsidianLocalConnector {
  readonly provider: DocsProviderView;

  constructor(provider: DocsProviderView) {
    this.provider = provider;
  }

  private get vaultRoot(): string {
    return path.resolve(this.provider.vaultPath);
  }

  assertVaultReady(): void {
    if (!fs.existsSync(this.vaultRoot)) {
      throw new Error("vault_not_found");
    }
    const stat = fs.statSync(this.vaultRoot);
    if (!stat.isDirectory()) {
      throw new Error("vault_not_directory");
    }
  }

  private resolveNotePath(notePathOrTarget: string): { relPath: string; absPath: string } {
    const raw = String(notePathOrTarget || "").trim();
    if (!raw) throw new Error("note_path_required");

    let rel = raw;
    if (!rel.toLowerCase().endsWith(".md")) {
      const asTitle = normalizeNoteTitle(rel);
      rel = wikilinkTargetToPath(asTitle || rel);
    }

    const relPath = normalizeRelPath(rel);
    const absPath = ensureInsideRoot(this.vaultRoot, path.join(this.vaultRoot, relPath));
    return { relPath, absPath };
  }

  listNotes(limit = 300): DocsNoteSummary[] {
    this.assertVaultReady();
    const maxFiles = Math.max(1, Math.min(2000, Math.floor(limit) || 300));
    const files: string[] = [];
    collectMarkdownFiles(this.vaultRoot, this.vaultRoot, files, maxFiles);

    return files
      .map((relPath) => {
        const absPath = path.join(this.vaultRoot, relPath);
        try {
          const content = readUtf8Safe(absPath);
          const stat = fs.statSync(absPath);
          return {
            path: relPath,
            title: titleFromPath(relPath),
            tags: extractTags(content),
            links: extractWikilinks(content),
            modifiedAt: Math.floor(stat.mtimeMs),
            size: stat.size,
          } satisfies DocsNoteSummary;
        } catch {
          return null;
        }
      })
      .filter((item): item is DocsNoteSummary => Boolean(item));
  }

  readNote(notePathOrTarget: string): { path: string; content: string; title: string } {
    this.assertVaultReady();
    const { relPath, absPath } = this.resolveNotePath(notePathOrTarget);
    if (!fs.existsSync(absPath)) throw new Error("note_not_found");
    const content = readUtf8Safe(absPath);
    return {
      path: relPath,
      title: titleFromPath(relPath),
      content,
    };
  }

  writeNote(notePathOrTarget: string, content: string): { path: string; title: string; bytes: number } {
    this.assertVaultReady();
    if (this.provider.readOnly) throw new Error("provider_read_only");

    const { relPath, absPath } = this.resolveNotePath(notePathOrTarget);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, String(content || ""), "utf8");
    const size = fs.statSync(absPath).size;
    return {
      path: relPath,
      title: titleFromPath(relPath),
      bytes: size,
    };
  }

  createNote(titleOrTarget: string, content = "", folder = ""): { path: string; title: string; bytes: number } {
    this.assertVaultReady();
    if (this.provider.readOnly) throw new Error("provider_read_only");

    const title = normalizeNoteTitle(titleOrTarget) || "Untitled";
    const folderRel = normalizeRelPath(folder || "");
    const relPath = normalizeRelPath(path.posix.join(folderRel, `${title}.md`));
    const absPath = ensureInsideRoot(this.vaultRoot, path.join(this.vaultRoot, relPath));
    if (fs.existsSync(absPath)) throw new Error("note_exists");

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, String(content || ""), "utf8");
    const size = fs.statSync(absPath).size;
    return {
      path: relPath,
      title,
      bytes: size,
    };
  }

  search(input: SearchInput): DocsSearchResult[] {
    const query = String(input.query || "").trim();
    if (!query) return [];

    const requestedLimit = Math.floor(Number(input.limit ?? 20));
    const limit = Math.max(1, Math.min(200, Number.isFinite(requestedLimit) ? requestedLimit : 20));
    const includeTags = Array.isArray(input.tags)
      ? input.tags
          .map((tag) =>
            String(tag || "")
              .trim()
              .replace(/^#/, "")
              .toLowerCase(),
          )
          .filter(Boolean)
      : [];

    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const notes = this.listNotes(2000);

    const ranked = notes
      .map((note) => {
        const absPath = path.join(this.vaultRoot, note.path);
        const content = readUtf8Safe(absPath);
        const titleLower = note.title.toLowerCase();
        const contentLower = content.toLowerCase();
        const tagsLower = note.tags.map((tag) => tag.toLowerCase());
        const linksLower = note.links.map((link) => link.toLowerCase());

        if (includeTags.length > 0 && includeTags.some((tag) => !tagsLower.includes(tag))) {
          return null;
        }

        let score = 0;
        if (titleLower.includes(q)) score += 90;
        if (linksLower.some((entry) => entry.includes(q))) score += 45;
        if (tagsLower.some((entry) => entry.includes(q))) score += 30;
        if (contentLower.includes(q)) score += 20;
        for (const word of words) {
          if (titleLower.includes(word)) score += 12;
          if (contentLower.includes(word)) score += 4;
        }

        if (score <= 0) return null;
        const snippet = buildSnippet(content, query);
        return {
          path: note.path,
          title: note.title,
          score,
          snippet,
          tags: note.tags,
          links: note.links,
        } satisfies DocsSearchResult;
      })
      .filter((item): item is DocsSearchResult => Boolean(item))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    return ranked.slice(0, limit);
  }

  backlinks(targetPathOrTitle: string): DocsNoteSummary[] {
    const target = pathToWikilinkTarget(targetPathOrTitle).toLowerCase();
    const targetTitle = normalizeNoteTitle(targetPathOrTitle).toLowerCase();
    return this.listNotes(2000).filter((note) => {
      const links = note.links.map((link) => String(link || "").toLowerCase());
      return links.some((entry) => {
        const normalized = pathToWikilinkTarget(entry).toLowerCase();
        const title = normalizeNoteTitle(entry).toLowerCase();
        return normalized === target || title === targetTitle;
      });
    });
  }
}
