import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  normalizeNoteTitle,
  toWikilink,
  wikilinkTargetToPath,
  pathToWikilinkTarget,
  extractWikilinks,
  extractTags,
  titleFromPath,
  buildSnippet,
  upsertTags,
} from "../../../modules/routes/docs/wikilinks.ts";

// ---------------------------------------------------------------------------
// Re-implementations of path safety helpers from obsidian-local-connector.ts
// (these are file-scoped in the source; tested via re-implementation)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: path safety
// ---------------------------------------------------------------------------

describe("normalizeRelPath", () => {
  it("normalizes forward slashes", () => {
    expect(normalizeRelPath("notes/daily/today.md")).toBe("notes/daily/today.md");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeRelPath("notes\\daily\\today.md")).toBe("notes/daily/today.md");
  });

  it("strips leading slashes", () => {
    expect(normalizeRelPath("/notes/today.md")).toBe("notes/today.md");
    expect(normalizeRelPath("///notes/today.md")).toBe("notes/today.md");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeRelPath("")).toBe("");
    expect(normalizeRelPath("  ")).toBe("");
  });

  it("throws on path traversal with ../", () => {
    expect(() => normalizeRelPath("../etc/passwd")).toThrow("invalid_relative_path");
    expect(() => normalizeRelPath("notes/../../etc/passwd")).toThrow("invalid_relative_path");
  });

  it("throws on bare .. traversal", () => {
    expect(() => normalizeRelPath("..")).toThrow("invalid_relative_path");
  });

  it("normalizes redundant segments", () => {
    expect(normalizeRelPath("notes/./daily/./today.md")).toBe("notes/daily/today.md");
  });

  it("handles null/undefined input gracefully", () => {
    expect(normalizeRelPath(null as unknown as string)).toBe("");
    expect(normalizeRelPath(undefined as unknown as string)).toBe("");
  });
});

describe("ensureInsideRoot", () => {
  const root = "/home/user/vault";

  it("accepts paths inside root", () => {
    const result = ensureInsideRoot(root, "/home/user/vault/notes/today.md");
    expect(result).toBe(path.resolve("/home/user/vault/notes/today.md"));
  });

  it("accepts root itself", () => {
    const result = ensureInsideRoot(root, "/home/user/vault");
    expect(result).toBe(path.resolve("/home/user/vault"));
  });

  it("throws for paths outside root via traversal", () => {
    expect(() => ensureInsideRoot(root, "/home/user/vault/../secret")).toThrow("path_outside_vault");
    expect(() => ensureInsideRoot(root, "/etc/passwd")).toThrow("path_outside_vault");
    expect(() => ensureInsideRoot(root, "/home/user/other")).toThrow("path_outside_vault");
  });
});

// ---------------------------------------------------------------------------
// Tests: wikilink utilities (exported from wikilinks.ts)
// ---------------------------------------------------------------------------

describe("normalizeNoteTitle", () => {
  it("removes .md extension", () => {
    expect(normalizeNoteTitle("My Note.md")).toBe("My Note");
    expect(normalizeNoteTitle("note.MD")).toBe("note");
  });

  it("replaces path separators with spaces", () => {
    expect(normalizeNoteTitle("folder/subfolder/note")).toBe("folder subfolder note");
    expect(normalizeNoteTitle("folder\\note")).toBe("folder note");
  });

  it("trims and normalizes whitespace", () => {
    expect(normalizeNoteTitle("  My  Note  ")).toBe("My Note");
  });

  it("handles empty input", () => {
    expect(normalizeNoteTitle("")).toBe("");
    expect(normalizeNoteTitle(null as unknown as string)).toBe("");
  });
});

describe("toWikilink", () => {
  it("creates simple wikilink", () => {
    expect(toWikilink("My Note")).toBe("[[My Note]]");
  });

  it("creates aliased wikilink", () => {
    expect(toWikilink("Long Note Title", "Short")).toBe("[[Long Note Title|Short]]");
  });

  it("strips .md extension from target", () => {
    expect(toWikilink("Note.md")).toBe("[[Note]]");
  });

  it("returns Untitled for empty target", () => {
    expect(toWikilink("")).toBe("[[Untitled]]");
  });
});

describe("wikilinkTargetToPath", () => {
  it("adds .md extension", () => {
    expect(wikilinkTargetToPath("My Note")).toBe("My Note.md");
  });

  it("does not double .md extension", () => {
    expect(wikilinkTargetToPath("My Note.md")).toBe("My Note.md");
  });

  it("normalizes path separators", () => {
    expect(wikilinkTargetToPath("folder/note")).toBe("folder/note.md");
  });
});

describe("pathToWikilinkTarget", () => {
  it("strips .md extension", () => {
    expect(pathToWikilinkTarget("notes/daily.md")).toBe("notes/daily");
  });

  it("normalizes backslashes", () => {
    expect(pathToWikilinkTarget("notes\\daily.md")).toBe("notes/daily");
  });

  it("handles empty input", () => {
    expect(pathToWikilinkTarget("")).toBe("");
  });
});

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    expect(extractWikilinks("See [[My Note]] and [[Other]]")).toEqual(["My Note", "Other"]);
  });

  it("handles aliased wikilinks", () => {
    expect(extractWikilinks("See [[Long Title|Short]]")).toEqual(["Long Title"]);
  });

  it("handles wikilinks with headings", () => {
    expect(extractWikilinks("See [[Note#Section]]")).toEqual(["Note"]);
  });

  it("deduplicates", () => {
    expect(extractWikilinks("[[A]] then [[A]] again")).toEqual(["A"]);
  });

  it("returns empty for no wikilinks", () => {
    expect(extractWikilinks("No links here")).toEqual([]);
    expect(extractWikilinks("")).toEqual([]);
  });
});

describe("extractTags", () => {
  it("extracts hashtag tags", () => {
    const result = extractTags("Some text #project #review");
    expect(result).toContain("project");
    expect(result).toContain("review");
  });

  it("extracts tag at start of line", () => {
    expect(extractTags("#daily note")).toContain("daily");
  });

  it("handles nested tags with slashes", () => {
    expect(extractTags("Text #project/frontend")).toContain("project/frontend");
  });

  it("returns empty for no tags", () => {
    expect(extractTags("No tags here")).toEqual([]);
    expect(extractTags("")).toEqual([]);
  });

  it("lowercases tags", () => {
    expect(extractTags("#ProjectX")).toContain("projectx");
  });

  it("deduplicates tags", () => {
    expect(extractTags("#dev and #dev again")).toEqual(["dev"]);
  });
});

describe("titleFromPath", () => {
  it("extracts filename without extension", () => {
    expect(titleFromPath("notes/daily/2024-01-01.md")).toBe("2024-01-01");
  });

  it("returns Untitled for empty input", () => {
    expect(titleFromPath("")).toBe("Untitled");
  });

  it("handles backslashes", () => {
    expect(titleFromPath("notes\\daily\\today.md")).toBe("today");
  });
});

describe("buildSnippet", () => {
  it("returns empty for empty input", () => {
    expect(buildSnippet("", "query")).toBe("");
  });

  it("returns truncated content when no query match", () => {
    const long = "a".repeat(300);
    const snippet = buildSnippet(long, "xyz");
    expect(snippet.length).toBeLessThanOrEqual(224); // 220 + "..."
    expect(snippet).toContain("...");
  });

  it("returns full content when short and no query", () => {
    expect(buildSnippet("Short text", "")).toBe("Short text");
  });

  it("centers snippet around query match", () => {
    const content = "A".repeat(100) + "FINDME" + "B".repeat(100);
    const snippet = buildSnippet(content, "FINDME");
    expect(snippet).toContain("FINDME");
  });

  it("adds ellipsis prefix when match is deep in content", () => {
    const content = "X".repeat(200) + "MATCH" + "Y".repeat(200);
    const snippet = buildSnippet(content, "MATCH");
    expect(snippet.startsWith("...")).toBe(true);
  });
});

describe("upsertTags", () => {
  it("adds YAML frontmatter when none exists", () => {
    const result = upsertTags("Some content", ["project", "dev"]);
    expect(result).toContain("---");
    expect(result).toContain("tags: [project, dev]");
    expect(result).toContain("Some content");
  });

  it("updates existing tags in frontmatter", () => {
    const content = "---\ntags: [old-tag]\ntitle: Test\n---\nBody";
    const result = upsertTags(content, ["new-tag"]);
    expect(result).toContain("tags: [new-tag]");
    expect(result).not.toContain("old-tag");
  });

  it("adds tags to existing frontmatter without tags", () => {
    const content = "---\ntitle: Test\n---\nBody";
    const result = upsertTags(content, ["added"]);
    expect(result).toContain("tags: [added]");
    expect(result).toContain("title: Test");
  });

  it("returns content unchanged when tags array is empty", () => {
    const content = "Some content";
    expect(upsertTags(content, [])).toBe(content);
  });

  it("strips # prefix and lowercases tags", () => {
    const result = upsertTags("Content", ["#Project", "#Dev"]);
    expect(result).toContain("tags: [project, dev]");
  });

  it("deduplicates tags", () => {
    const result = upsertTags("Content", ["dev", "Dev", "DEV"]);
    expect(result).toContain("tags: [dev]");
  });
});
