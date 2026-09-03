import { describe, it, expect } from "vitest";
import {
  parseClaudeMd,
  writeClaudeMd,
  SECTION_CHAR_LIMITS,
  selectSectionsForDepartment,
  buildProjectContextPromptBlock,
} from "../../../modules/workflow/core/claude-md-parser.ts";

const SAMPLE_MD = `# TeleCalm

## Overview
Telehealth demo app for Nefesh.

## Architecture
Next.js 14, React 18, Zustand.

## Conventions
Strict TypeScript, Zod validation.

## Decisions
- 2026-04-07: Zustand over Redux for bundle size

## Status
Analysis phase complete. Planning next.
`;

describe("parseClaudeMd", () => {
  it("parses all 5 sections from well-formed CLAUDE.md", () => {
    const result = parseClaudeMd(SAMPLE_MD);
    expect(result.title).toBe("TeleCalm");
    expect(result.sections.overview).toBe("Telehealth demo app for Nefesh.");
    expect(result.sections.architecture).toBe("Next.js 14, React 18, Zustand.");
    expect(result.sections.conventions).toBe("Strict TypeScript, Zod validation.");
    expect(result.sections.decisions).toBe("- 2026-04-07: Zustand over Redux for bundle size");
    expect(result.sections.status).toBe("Analysis phase complete. Planning next.");
  });

  it("returns empty sections for missing headers", () => {
    const result = parseClaudeMd("# MyProject\n\n## Overview\nHello\n");
    expect(result.title).toBe("MyProject");
    expect(result.sections.overview).toBe("Hello");
    expect(result.sections.architecture).toBe("");
    expect(result.sections.conventions).toBe("");
    expect(result.sections.decisions).toBe("");
    expect(result.sections.status).toBe("");
  });

  it("handles CLAUDE.md without structured sections (legacy)", () => {
    const legacy = "# Project\n\nSome unstructured content here.\nMore content.";
    const result = parseClaudeMd(legacy);
    expect(result.title).toBe("Project");
    expect(result.sections.overview).toContain("Some unstructured content");
  });

  it("handles empty string", () => {
    const result = parseClaudeMd("");
    expect(result.title).toBe("");
    expect(result.sections.overview).toBe("");
  });
});

describe("writeClaudeMd", () => {
  it("writes all sections in correct order", () => {
    const md = writeClaudeMd("TeleCalm", {
      overview: "A demo app.",
      architecture: "Next.js stack.",
      conventions: "TypeScript strict.",
      decisions: "- 2026-04-07: Choice A",
      status: "In progress.",
    });
    expect(md).toContain("# TeleCalm");
    expect(md).toContain("## Overview\nA demo app.");
    expect(md).toContain("## Architecture\nNext.js stack.");
    expect(md).toContain("## Conventions\nTypeScript strict.");
    expect(md).toContain("## Decisions\n- 2026-04-07: Choice A");
    expect(md).toContain("## Status\nIn progress.");
  });

  it("truncates sections exceeding char limits", () => {
    const longText = "x".repeat(SECTION_CHAR_LIMITS.overview + 500);
    const md = writeClaudeMd("Test", {
      overview: longText,
      architecture: "",
      conventions: "",
      decisions: "",
      status: "",
    });
    const parsed = parseClaudeMd(md);
    expect(parsed.sections.overview.length).toBeLessThanOrEqual(SECTION_CHAR_LIMITS.overview);
  });

  it("omits empty sections", () => {
    const md = writeClaudeMd("Test", {
      overview: "Hello",
      architecture: "",
      conventions: "",
      decisions: "",
      status: "",
    });
    expect(md).toContain("## Overview");
    expect(md).not.toContain("## Architecture");
    expect(md).not.toContain("## Conventions");
  });
});

describe("selectSectionsForDepartment", () => {
  const sections = {
    overview: "OV",
    architecture: "AR",
    conventions: "CO",
    decisions: "DE",
    status: "ST",
  };

  it("returns overview+architecture+conventions for planning", () => {
    const result = selectSectionsForDepartment(sections, "planning");
    expect(result).toEqual({ overview: "OV", architecture: "AR", conventions: "CO" });
  });

  it("returns architecture+conventions+status for dev", () => {
    const result = selectSectionsForDepartment(sections, "dev");
    expect(result).toEqual({ architecture: "AR", conventions: "CO", status: "ST" });
  });

  it("returns all sections for null department", () => {
    const result = selectSectionsForDepartment(sections, null);
    expect(result).toEqual(sections);
  });
});

describe("buildProjectContextPromptBlock", () => {
  it("builds prompt block with title and sections", () => {
    const block = buildProjectContextPromptBlock("MyApp", { overview: "Hello", architecture: "React" });
    expect(block).toContain("[Project Context] MyApp");
    expect(block).toContain("### Overview\nHello");
    expect(block).toContain("### Architecture\nReact");
  });
});

describe("roundtrip", () => {
  it("parse then write preserves content", () => {
    const parsed = parseClaudeMd(SAMPLE_MD);
    const written = writeClaudeMd(parsed.title, parsed.sections);
    const reparsed = parseClaudeMd(written);
    expect(reparsed.sections).toEqual(parsed.sections);
  });
});
