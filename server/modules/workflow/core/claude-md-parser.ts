export const SECTION_KEYS = ["overview", "architecture", "conventions", "decisions", "status"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export type ClaudeMdSections = Record<SectionKey, string>;

export const SECTION_CHAR_LIMITS: Record<SectionKey, number> = {
  overview: 2000,
  architecture: 3000,
  conventions: 2000,
  decisions: 1500,
  status: 1000,
};

const SECTION_HEADERS: Record<SectionKey, string> = {
  overview: "Overview",
  architecture: "Architecture",
  conventions: "Conventions",
  decisions: "Decisions",
  status: "Status",
};

export interface ParsedClaudeMd {
  title: string;
  sections: ClaudeMdSections;
  raw: string;
}

/**
 * Parse a CLAUDE.md into its title and structured sections.
 * If the file lacks structured `## Section` headers, all content after the title
 * is placed into the `overview` section (legacy fallback).
 */
export function parseClaudeMd(content: string): ParsedClaudeMd {
  const empty: ClaudeMdSections = { overview: "", architecture: "", conventions: "", decisions: "", status: "" };
  if (!content.trim()) return { title: "", sections: empty, raw: content };

  const lines = content.split("\n");
  let title = "";

  // Extract title from first H1
  const titleLine = lines.find((l) => /^#\s+/.test(l));
  if (titleLine) title = titleLine.replace(/^#\s+/, "").trim();

  // Find section boundaries
  const sectionPattern = /^##\s+(.+)$/;
  const headerToKey = new Map<string, SectionKey>();
  for (const key of SECTION_KEYS) {
    headerToKey.set(SECTION_HEADERS[key].toLowerCase(), key);
  }

  const sectionRanges: Array<{ key: SectionKey; startLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sectionPattern);
    if (match) {
      const key = headerToKey.get(match[1].trim().toLowerCase());
      if (key) sectionRanges.push({ key, startLine: i + 1 });
    }
  }

  if (sectionRanges.length === 0) {
    // Legacy: no structured sections — put everything after title into overview
    const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
    const body = lines
      .slice(titleIdx >= 0 ? titleIdx + 1 : 0)
      .join("\n")
      .trim();
    return { title, sections: { ...empty, overview: body }, raw: content };
  }

  const sections = { ...empty };
  for (let i = 0; i < sectionRanges.length; i++) {
    const { key, startLine } = sectionRanges[i];
    const endLine = i + 1 < sectionRanges.length ? sectionRanges[i + 1].startLine - 1 : lines.length;
    const sectionLines: string[] = [];
    for (let j = startLine; j < endLine; j++) {
      const line = lines[j];
      if (/^##\s+/.test(line) && j !== startLine - 1) break;
      sectionLines.push(line);
    }
    sections[key] = sectionLines.join("\n").trim();
  }

  return { title, sections, raw: content };
}

/**
 * Assemble a CLAUDE.md from title and sections.
 * Sections exceeding their char limit are truncated.
 * Empty sections are omitted.
 */
export function writeClaudeMd(title: string, sections: ClaudeMdSections): string {
  const parts: string[] = [`# ${title}`, ""];

  for (const key of SECTION_KEYS) {
    let content = sections[key]?.trim() ?? "";
    if (!content) continue;
    const limit = SECTION_CHAR_LIMITS[key];
    if (content.length > limit) {
      content = content.slice(0, limit);
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline > limit * 0.8) content = content.slice(0, lastNewline);
    }
    parts.push(`## ${SECTION_HEADERS[key]}`, content, "");
  }

  return parts.join("\n").trimEnd() + "\n";
}

/**
 * Select sections relevant to a given department.
 */
export function selectSectionsForDepartment(
  sections: ClaudeMdSections,
  department: string | null,
): Partial<ClaudeMdSections> {
  if (!department) return sections;
  switch (department) {
    case "planning":
      return { overview: sections.overview, architecture: sections.architecture, conventions: sections.conventions };
    case "dev":
      return { architecture: sections.architecture, conventions: sections.conventions, status: sections.status };
    case "qa":
      return { overview: sections.overview, architecture: sections.architecture, decisions: sections.decisions };
    case "design":
      return { overview: sections.overview, architecture: sections.architecture, conventions: sections.conventions };
    default:
      return sections;
  }
}

/**
 * Build a prompt block from selected sections.
 */
export function buildProjectContextPromptBlock(title: string, sections: Partial<ClaudeMdSections>): string {
  const parts: string[] = [`[Project Context] ${title}`];
  for (const key of SECTION_KEYS) {
    const content = sections[key as SectionKey];
    if (content) parts.push(`### ${SECTION_HEADERS[key as SectionKey]}`, content);
  }
  return parts.join("\n");
}
