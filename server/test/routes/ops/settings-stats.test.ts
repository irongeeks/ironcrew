import { describe, it, expect } from "vitest";

/**
 * Unit tests for pure utility functions in settings-stats.ts.
 *
 * The module is primarily composed of Express route handlers that need a full
 * RuntimeContext (db, app, broadcast, etc.). The testable pure functions are
 * file-scoped closures. We re-implement and test them here:
 *
 * - safeJsonParse — safe JSON.parse wrapper
 * - normalizePackKey — trims and validates pack key strings
 * - readBooleanLikeSetting logic — normalization of boolean-like DB values
 * - completionRate calculation — tasks completion percentage
 */

// ---------------------------------------------------------------------------
// Re-implementations (mirrors server/modules/routes/ops/settings-stats.ts)
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizePackKey(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function readBooleanLikeValue(rawValue: unknown): boolean {
  const row = rawValue !== undefined ? { value: rawValue } : undefined;
  if (!row) return false;
  const raw = String(row.value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return false;
  if (raw === "true" || raw === "1") return true;
  try {
    const parsed = JSON.parse(String(row.value));
    return parsed === true || parsed === 1;
  } catch {
    return false;
  }
}

function computeCompletionRate(totalTasks: number, doneTasks: number): number {
  return totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: "value" });
    expect(safeJsonParse("[1, 2, 3]")).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"')).toBe("hello");
    expect(safeJsonParse("42")).toBe(42);
    expect(safeJsonParse("true")).toBe(true);
    expect(safeJsonParse("null")).toBe(null);
  });

  it("returns raw string for invalid JSON", () => {
    expect(safeJsonParse("not json")).toBe("not json");
    expect(safeJsonParse("{broken")).toBe("{broken");
    expect(safeJsonParse("")).toBe("");
  });
});

describe("normalizePackKey", () => {
  it("trims whitespace", () => {
    expect(normalizePackKey("  development  ")).toBe("development");
  });

  it("strips surrounding quotes", () => {
    expect(normalizePackKey('"video_preprod"')).toBe("video_preprod");
    expect(normalizePackKey("'web_research_report'")).toBe("web_research_report");
  });

  it("returns null for empty strings", () => {
    expect(normalizePackKey("")).toBe(null);
    expect(normalizePackKey("   ")).toBe(null);
    expect(normalizePackKey('""')).toBe(null);
    expect(normalizePackKey("''")).toBe(null);
  });

  it("returns null for non-string values", () => {
    expect(normalizePackKey(null)).toBe(null);
    expect(normalizePackKey(undefined)).toBe(null);
    expect(normalizePackKey(42)).toBe(null);
    expect(normalizePackKey({})).toBe(null);
    expect(normalizePackKey([])).toBe(null);
  });

  it("preserves valid pack keys", () => {
    expect(normalizePackKey("development")).toBe("development");
    expect(normalizePackKey("video_preprod")).toBe("video_preprod");
    expect(normalizePackKey("web_research_report")).toBe("web_research_report");
  });
});

describe("readBooleanLikeValue", () => {
  it("returns true for truthy string values", () => {
    expect(readBooleanLikeValue("true")).toBe(true);
    expect(readBooleanLikeValue("1")).toBe(true);
    expect(readBooleanLikeValue("TRUE")).toBe(true);
    expect(readBooleanLikeValue("  True  ")).toBe(true);
  });

  it("returns false for falsy string values", () => {
    expect(readBooleanLikeValue("false")).toBe(false);
    expect(readBooleanLikeValue("0")).toBe(false);
    expect(readBooleanLikeValue("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(readBooleanLikeValue(undefined)).toBe(false);
  });

  it("handles JSON-parseable boolean/number values", () => {
    expect(readBooleanLikeValue(true)).toBe(true);
    expect(readBooleanLikeValue(1)).toBe(true);
    expect(readBooleanLikeValue(false)).toBe(false);
    expect(readBooleanLikeValue(0)).toBe(false);
  });

  it("returns false for unrecognized strings", () => {
    expect(readBooleanLikeValue("maybe")).toBe(false);
    expect(readBooleanLikeValue("yes")).toBe(false);
    expect(readBooleanLikeValue("on")).toBe(false);
  });
});

describe("completionRate calculation", () => {
  it("returns 0 when no tasks", () => {
    expect(computeCompletionRate(0, 0)).toBe(0);
  });

  it("returns 100 when all tasks are done", () => {
    expect(computeCompletionRate(10, 10)).toBe(100);
  });

  it("returns correct percentage", () => {
    expect(computeCompletionRate(3, 1)).toBe(33);
    expect(computeCompletionRate(3, 2)).toBe(67);
    expect(computeCompletionRate(4, 1)).toBe(25);
  });

  it("rounds to nearest integer", () => {
    expect(computeCompletionRate(7, 3)).toBe(43);
    expect(computeCompletionRate(6, 1)).toBe(17);
  });
});
