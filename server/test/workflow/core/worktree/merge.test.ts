import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeInfo } from "../../../../modules/workflow/core/worktree/lifecycle.ts";

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock decryptSecret
// ---------------------------------------------------------------------------

vi.mock("../../../../oauth/helpers.ts", () => ({
  decryptSecret: vi.fn(() => "ghp_mock_token"),
}));

// ---------------------------------------------------------------------------
// Mock shared.ts – we stub the auto-commit helper
// ---------------------------------------------------------------------------

const autoCommitMock = vi.fn(() => ({
  committed: false,
  error: null as string | null,
  errorKind: null as "restricted_untracked" | "git_error" | null,
  restrictedUntrackedCount: 0,
}));
const readWorktreeStatusShortMock = vi.fn(() => "");
const hasVisibleDiffSummaryMock = vi.fn((s: string) => Boolean(s && s !== "__DIFF_NONE__" && s !== "__DIFF_ERROR__"));

vi.mock("../../../../modules/workflow/core/worktree/shared.ts", () => ({
  autoCommitWorktreePendingChanges: (..._args: unknown[]) => autoCommitMock(),
  readWorktreeStatusShort: (..._args: unknown[]) => readWorktreeStatusShortMock(),
  hasVisibleDiffSummary: (s: string) => hasVisibleDiffSummaryMock(s),
  DIFF_SUMMARY_NONE: "__DIFF_NONE__",
  DIFF_SUMMARY_ERROR: "__DIFF_ERROR__",
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { createWorktreeMergeTools } from "../../../../modules/workflow/core/worktree/merge.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb(
  opts: {
    tasks?: Array<{ id: string; title: string; description?: string | null }>;
    oauthRows?: Array<{ access_token_enc: string }>;
  } = {},
) {
  const tasks = opts.tasks ?? [];
  const oauthRows = opts.oauthRows ?? [{ access_token_enc: "enc_token" }];

  return {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase();
      return {
        get: (...params: unknown[]) => {
          if (upper.includes("FROM TASKS")) {
            return tasks.find((t) => t.id === params[0]);
          }
          if (upper.includes("OAUTH_ACCOUNTS")) {
            return oauthRows[0];
          }
          return undefined;
        },
      };
    },
  };
}

const TASK_ID = "task-0001-0000-0000-000000000001";
const PROJECT_PATH = "/home/user/project";
const WORKTREE_PATH = "/home/user/project/.octooffice-worktrees/task-000";
const BRANCH_NAME = "octooffice/task-000";

function defaultWorktreeInfo(): WorktreeInfo {
  return { worktreePath: WORKTREE_PATH, branchName: BRANCH_NAME, projectPath: PROJECT_PATH };
}

function buildDeps(overrides: Record<string, unknown> = {}) {
  const taskWorktrees = new Map<string, WorktreeInfo>();
  taskWorktrees.set(TASK_ID, defaultWorktreeInfo());

  const db = createMockDb({
    tasks: [{ id: TASK_ID, title: "Test task", description: "desc" }],
  });

  return {
    db: db as any,
    taskWorktrees,
    appendTaskLog: vi.fn(),
    cleanupWorktree: vi.fn(),
    resolveLang: vi.fn(() => "en"),
    l: vi.fn((_ko: any, en: any) => en),
    pickL: vi.fn((_pool: any, _lang: any) => "translated"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeWorktree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    autoCommitMock.mockReturnValue({ committed: false, error: null, errorKind: null, restrictedUntrackedCount: 0 });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from(" src/index.ts | 2 +-\n 1 file changed\n");
      if (args.includes("merge")) return Buffer.from("");
      return Buffer.from("");
    });
  });

  it("returns error when no worktree exists for task", () => {
    const deps = buildDeps();
    deps.taskWorktrees.clear();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(false);
    expect(result.message).toContain("No worktree found");
  });

  it("returns error when auto-commit fails", () => {
    autoCommitMock.mockReturnValue({
      committed: false,
      error: "git add failed",
      errorKind: "git_error",
      restrictedUntrackedCount: 0,
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(false);
  });

  it("returns error when auto-commit blocked by restricted untracked files", () => {
    autoCommitMock.mockReturnValue({
      committed: false,
      error: "blocked",
      errorKind: "restricted_untracked",
      restrictedUntrackedCount: 3,
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(false);
  });

  it("reports no changes needed when diff is empty", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from("");
      return Buffer.from("");
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(true);
  });

  it("successfully merges worktree branch into current branch", () => {
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["merge", BRANCH_NAME, "--no-ff", "-m"]),
      expect.any(Object),
    );
  });

  it("handles merge conflict: aborts and returns conflict list", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from(" changed\n");
      if (args.includes("merge") && !args.includes("--abort")) throw new Error("conflict");
      if (args.includes("--diff-filter=U")) return Buffer.from("file1.ts\nfile2.ts\n");
      return Buffer.from("");
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(["file1.ts", "file2.ts"]);
  });

  it("handles generic merge failure without conflicts", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from(" changed\n");
      if (args.includes("merge") && !args.includes("--abort")) throw new Error("fatal: some error");
      if (args.includes("--diff-filter=U")) return Buffer.from("");
      return Buffer.from("");
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.mergeWorktree(PROJECT_PATH, TASK_ID);
    expect(result.success).toBe(false);
    expect(result.conflicts).toBeUndefined();
  });
});

describe("getWorktreeDiffSummary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readWorktreeStatusShortMock.mockReturnValue("");
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from(" src/index.ts | 2 +-\n");
      return Buffer.from("");
    });
  });

  it("returns empty string when no worktree info", () => {
    const deps = buildDeps();
    deps.taskWorktrees.clear();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.getWorktreeDiffSummary(PROJECT_PATH, TASK_ID);
    expect(result).toBe("");
  });

  it("returns committed diff stat", () => {
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.getWorktreeDiffSummary(PROJECT_PATH, TASK_ID);
    expect(result).toContain("src/index.ts");
  });

  it("includes uncommitted changes when present", () => {
    readWorktreeStatusShortMock.mockReturnValue("M src/other.ts");
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.getWorktreeDiffSummary(PROJECT_PATH, TASK_ID);
    expect(result).toContain("uncommitted worktree changes");
    expect(result).toContain("M src/other.ts");
  });

  it("returns DIFF_SUMMARY_NONE when no changes at all", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from("");
      return Buffer.from("");
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.getWorktreeDiffSummary(PROJECT_PATH, TASK_ID);
    expect(result).toBe("__DIFF_NONE__");
  });

  it("returns DIFF_SUMMARY_ERROR when git command fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git fail");
    });
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.getWorktreeDiffSummary(PROJECT_PATH, TASK_ID);
    expect(result).toBe("__DIFF_ERROR__");
  });
});

describe("rollbackTaskWorktree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    readWorktreeStatusShortMock.mockReturnValue("");
  });

  it("returns false when no worktree info", () => {
    const deps = buildDeps();
    deps.taskWorktrees.clear();
    const tools = createWorktreeMergeTools(deps);

    expect(tools.rollbackTaskWorktree(TASK_ID, "test")).toBe(false);
  });

  it("calls cleanupWorktree and logs", () => {
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    const result = tools.rollbackTaskWorktree(TASK_ID, "user_cancel");
    expect(result).toBe(true);
    expect(deps.cleanupWorktree).toHaveBeenCalledWith(PROJECT_PATH, TASK_ID);
    expect(deps.appendTaskLog).toHaveBeenCalledWith(TASK_ID, "system", expect.stringContaining("rollback"));
  });

  it("logs diff summary when visible changes exist", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) return Buffer.from("main\n");
      if (args.includes("--stat")) return Buffer.from(" file.ts | 1 +\n");
      return Buffer.from("");
    });
    hasVisibleDiffSummaryMock.mockReturnValue(true);
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);

    tools.rollbackTaskWorktree(TASK_ID, "review_fail");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(TASK_ID, "system", expect.stringContaining("diff summary"));
  });
});

describe("hasVisibleDiffSummary", () => {
  it("returns true for real diff content", () => {
    const deps = buildDeps();
    const tools = createWorktreeMergeTools(deps);
    // Uses the re-exported function from shared.ts
    expect(tools.hasVisibleDiffSummary(" file.ts | 1 +\n")).toBe(true);
  });
});
