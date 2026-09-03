import path from "node:path";

const WIKILINK_REGEX = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const TAG_REGEX = /(^|\s)#([A-Za-z0-9_/-]+)/g;

export function normalizeNoteTitle(input: string): string {
  return String(input || "")
    .replace(/\.md$/i, "")
    .replace(/[\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toWikilink(target: string, alias?: string): string {
  const core = String(target || "")
    .replace(/\.md$/i, "")
    .trim();
  if (!core) return "[[Untitled]]";
  const safeAlias = String(alias || "").trim();
  return safeAlias ? `[[${core}|${safeAlias}]]` : `[[${core}]]`;
}

export function wikilinkTargetToPath(target: string): string {
  const trimmed = String(target || "").trim();
  const noExt = trimmed.replace(/\.md$/i, "");
  const normalized = noExt
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
  return `${normalized}.md`;
}

export function pathToWikilinkTarget(notePath: string): string {
  return String(notePath || "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "");
}

export function extractWikilinks(markdown: string): string[] {
  const input = String(markdown || "");
  const out = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = WIKILINK_REGEX.exec(input))) {
    const raw = normalizeNoteTitle(match[1] || "");
    if (!raw) continue;
    out.add(raw);
  }
  return Array.from(out);
}

export function extractTags(markdown: string): string[] {
  const input = String(markdown || "");
  const out = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = TAG_REGEX.exec(input))) {
    const tag = (match[2] || "").trim().toLowerCase();
    if (!tag) continue;
    out.add(tag);
  }
  return Array.from(out);
}

export function titleFromPath(notePath: string): string {
  const base = path.basename(String(notePath || "").replace(/\\/g, "/"), ".md");
  return base || "Untitled";
}

export function buildSnippet(markdown: string, query: string, maxLen = 220): string {
  const flat = String(markdown || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;

  const idx = flat.toLowerCase().indexOf(q);
  if (idx < 0) return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;

  const start = Math.max(0, idx - Math.floor(maxLen / 3));
  const end = Math.min(flat.length, start + maxLen);
  const snippet = flat.slice(start, end);
  return `${start > 0 ? "..." : ""}${snippet}${end < flat.length ? "..." : ""}`;
}

export function upsertTags(content: string, tags: string[]): string {
  const cleanTags = Array.from(
    new Set(
      tags
        .map((t) =>
          String(t || "")
            .trim()
            .replace(/^#/, "")
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
  if (cleanTags.length === 0) return content;

  const lines = String(content || "").split(/\r?\n/);
  const tagLine = `tags: [${cleanTags.join(", ")}]`;

  const yamlStart = lines[0]?.trim() === "---";
  if (yamlStart) {
    const yamlEndIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (yamlEndIndex > 0) {
      const yamlLines = lines.slice(1, yamlEndIndex);
      const hasTagLine = yamlLines.some((line) => /^tags\s*:/i.test(line));
      if (hasTagLine) {
        for (let i = 1; i < yamlEndIndex; i++) {
          if (/^tags\s*:/i.test(lines[i])) lines[i] = tagLine;
        }
      } else {
        lines.splice(yamlEndIndex, 0, tagLine);
      }
      return lines.join("\n");
    }
  }

  return ["---", tagLine, "---", "", String(content || "")].join("\n");
}
