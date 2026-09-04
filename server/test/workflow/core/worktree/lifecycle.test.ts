// server/test/workflow/core/worktree/lifecycle.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import path from "node:path";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
  },
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  createWorktreeLifecycleTools,
  rehydrateWorktrees,
  type WorktreeInfo,
} from "../../../../modules/workflow/core/worktree/lifecycle.ts";

const mockExec = execFileSync as unknown as Mock;
const mockExistsSync = fs.existsSync as unknown as Mock;
const mockMkdirSync = fs.mkdirSync as unknown as Mock;
const mockRmSync = fs.rmSync as unknown as Mock;
const mockSymlinkSync = fs.symlinkSync as unknown as Mock;

const PROJECT = "/home/user/project";
const TASK_ID = "abcdef1234567890";
const SHORT_ID = "abcdef12";
const AGENT = "TestAgent";

function makeDeps() {
  const appendTaskLog = vi.fn();
  const taskWorktrees = new Map<string, WorktreeInfo>();
  return { appendTaskLog, taskWorktrees };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------
describe("isGitRepo", () => {
  it("returns true when git rev-parse succeeds", () => {
    mockExec.mockReturnValueOnce(Buffer.from("true"));
    const { isGitRepo } = createWorktreeLifecycleTools(makeDeps());
    expect(isGitRepo("/some/dir")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "/some/dir",
      stdio: "pipe",
      timeout: 5000,
    });
  });

  it("returns false when git rev-parse throws", () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });
    const { isGitRepo } = createWorktreeLifecycleTools(makeDeps());
    expect(isGitRepo("/not/a/repo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------
describe("createWorktree", () => {
  /** Helper: make execFileSync succeed for isGitRepo + ensureWorktreeBootstrapRepo checks. */
  function stubGitRepoChecks() {
    // isGitRepo is called twice (ensureWorktreeBootstrapRepo + explicit check)
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("abc123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });
  }

  it("reuses existing worktree from taskWorktrees map if still valid", () => {
    const deps = makeDeps();
    const existingPath = "/home/user/project/.ironcrew-worktrees/abcdef12";
    deps.taskWorktrees.set(TASK_ID, {
      worktreePath: existingPath,
      branchName: `ironcrew/${SHORT_ID}`,
      projectPath: PROJECT,
    });
    mockExistsSync.mockReturnValue(true);
    mockExec.mockReturnValue(Buffer.from(".git"));

    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    expect(result).toBe(existingPath);
    // Should only call rev-parse --git-dir for validation, not create a new worktree
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--git-dir"],
      expect.objectContaining({
        cwd: existingPath,
      }),
    );
  });

  it("recreates if existing worktree is invalid (git rev-parse fails)", () => {
    const deps = makeDeps();
    const existingPath = "/home/user/project/.ironcrew-worktrees/abcdef12";
    deps.taskWorktrees.set(TASK_ID, {
      worktreePath: existingPath,
      branchName: `ironcrew/${SHORT_ID}`,
      projectPath: PROJECT,
    });
    // existsSync: true for existing worktree path, then false for .claude/skills checks
    mockExistsSync.mockImplementation((p: string) => {
      if (p === existingPath) return true;
      return false;
    });
    // First call: rev-parse --git-dir fails (invalid worktree)
    // Then proceed with normal creation flow
    let callCount = 0;
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--git-dir") {
        throw new Error("not a valid worktree");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("abc123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        callCount++;
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    // Should have deleted the old mapping and created a new worktree
    expect(result).not.toBeNull();
    expect(callCount).toBe(1);
    expect(deps.taskWorktrees.has(TASK_ID)).toBe(true);
  });

  it("returns null if project is not a git repo", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    expect(result).toBeNull();
    expect(deps.appendTaskLog).toHaveBeenCalledWith(TASK_ID, "system", expect.stringContaining("not a git repository"));
  });

  it("creates worktree base directory and prunes stale worktrees", () => {
    stubGitRepoChecks();
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    expect(mockMkdirSync).toHaveBeenCalledWith(path.join(PROJECT, ".ironcrew-worktrees"), { recursive: true });
    expect(mockExec).toHaveBeenCalledWith("git", ["worktree", "prune"], expect.objectContaining({ cwd: PROJECT }));
  });

  it("uses HEAD as base when no baseBranch is provided", () => {
    stubGitRepoChecks();
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    expect(mockExec).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.objectContaining({ cwd: PROJECT }));
  });

  it("uses baseBranch when provided", () => {
    mockExistsSync.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "dev") {
        return Buffer.from("dev123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT, "dev");

    expect(mockExec).toHaveBeenCalledWith("git", ["rev-parse", "dev"], expect.objectContaining({ cwd: PROJECT }));
  });

  it("falls back to HEAD when baseBranch rev-parse fails", () => {
    mockExistsSync.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "nonexistent") {
        throw new Error("unknown revision");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("head123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT, "nonexistent");

    expect(result).not.toBeNull();
    // Should have tried nonexistent, then fallen back to HEAD
    expect(mockExec).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.objectContaining({ cwd: PROJECT }));
  });

  it("tries branch candidates when first worktree add fails", () => {
    mockExistsSync.mockReturnValue(false);
    let worktreeAddAttempts = 0;
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("abc123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        worktreeAddAttempts++;
        if (worktreeAddAttempts < 3) throw new Error("branch already locked");
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    expect(result).not.toBeNull();
    expect(worktreeAddAttempts).toBe(3);
    // Third candidate is branchName-2 with path shortId-2
    const info = deps.taskWorktrees.get(TASK_ID);
    expect(info?.branchName).toBe(`ironcrew/${SHORT_ID}-2`);
    expect(info?.worktreePath).toBe(path.join(PROJECT, ".ironcrew-worktrees", `${SHORT_ID}-2`));
  });

  it("checks if branch exists before creating worktree", () => {
    mockExistsSync.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("abc123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        // Branch exists
        return Buffer.from(`abc123 refs/heads/ironcrew/${SHORT_ID}\n`);
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    // When branch exists, should NOT use -b flag
    const addCall = mockExec.mock.calls.find(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "worktree" && (c[1] as string[])[1] === "add",
    );
    expect(addCall).toBeDefined();
    const addArgs = addCall![1] as string[];
    expect(addArgs).not.toContain("-b");
    expect(addArgs).toContain(`ironcrew/${SHORT_ID}`);
  });

  it("uses -b flag when branch does not exist", () => {
    stubGitRepoChecks();
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    const addCall = mockExec.mock.calls.find(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "worktree" && (c[1] as string[])[1] === "add",
    );
    expect(addCall).toBeDefined();
    const addArgs = addCall![1] as string[];
    expect(addArgs).toContain("-b");
    expect(addArgs).toContain(`ironcrew/${SHORT_ID}`);
    expect(addArgs).toContain("abc123");
  });

  it("propagates .claude/skills as symlink when skills dir exists", () => {
    stubGitRepoChecks();
    const serverSkillsDir = path.join(process.cwd(), ".claude", "skills");
    const worktreePath = path.join(PROJECT, ".ironcrew-worktrees", SHORT_ID);
    const wtClaudeDir = path.join(worktreePath, ".claude");
    const wtSkillsLink = path.join(wtClaudeDir, "skills");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === serverSkillsDir) return true;
      if (p === wtSkillsLink) return false;
      return false;
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    expect(mockMkdirSync).toHaveBeenCalledWith(wtClaudeDir, { recursive: true });
    expect(mockSymlinkSync).toHaveBeenCalledWith(serverSkillsDir, wtSkillsLink, "junction");
  });

  it("does not create symlink when skills link already exists", () => {
    stubGitRepoChecks();
    const serverSkillsDir = path.join(process.cwd(), ".claude", "skills");
    const worktreePath = path.join(PROJECT, ".ironcrew-worktrees", SHORT_ID);
    const wtSkillsLink = path.join(worktreePath, ".claude", "skills");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === serverSkillsDir) return true;
      if (p === wtSkillsLink) return true;
      return false;
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("stores worktree info in taskWorktrees map on success", () => {
    stubGitRepoChecks();
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    const info = deps.taskWorktrees.get(TASK_ID);
    expect(info).toBeDefined();
    expect(info!.worktreePath).toBe(result);
    expect(info!.branchName).toBe(`ironcrew/${SHORT_ID}`);
    expect(info!.projectPath).toBe(PROJECT);
  });

  it("returns null on complete failure (all branch candidates fail)", () => {
    mockExistsSync.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return Buffer.from("true");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "prune") {
        return Buffer.from("");
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Buffer.from("abc123\n");
      }
      if (cmd === "git" && args[0] === "show-ref") {
        throw new Error("not found");
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        throw new Error("fatal: worktree add failed");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    const result = createWorktree(PROJECT, TASK_ID, AGENT);

    expect(result).toBeNull();
    expect(deps.taskWorktrees.has(TASK_ID)).toBe(false);
  });

  it("cleans up existing candidate path before attempting worktree add", () => {
    stubGitRepoChecks();
    const worktreePath = path.join(PROJECT, ".ironcrew-worktrees", SHORT_ID);
    mockExistsSync.mockImplementation((p: string) => {
      if (p === worktreePath) return true;
      return false;
    });

    const deps = makeDeps();
    const { createWorktree } = createWorktreeLifecycleTools(deps);
    createWorktree(PROJECT, TASK_ID, AGENT);

    expect(mockRmSync).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cleanupWorktree
// ---------------------------------------------------------------------------
describe("cleanupWorktree", () => {
  const worktreePath = "/home/user/project/.ironcrew-worktrees/abcdef12";
  const branchName = `ironcrew/${SHORT_ID}`;

  it("removes worktree via git command and deletes branch", () => {
    mockExec.mockReturnValue(Buffer.from(""));
    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath, branchName, projectPath: PROJECT });

    const { cleanupWorktree } = createWorktreeLifecycleTools(deps);
    cleanupWorktree(PROJECT, TASK_ID);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      expect.objectContaining({ cwd: PROJECT }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", branchName],
      expect.objectContaining({ cwd: PROJECT }),
    );
    expect(deps.taskWorktrees.has(TASK_ID)).toBe(false);
  });

  it("falls back to fs.rmSync + git worktree prune if git remove fails", () => {
    // removeCallCount removed — was unused
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        throw new Error("worktree remove failed");
      }
      return Buffer.from("");
    });
    mockExistsSync.mockReturnValue(true);
    mockRmSync.mockReturnValue(undefined);

    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath, branchName, projectPath: PROJECT });

    const { cleanupWorktree } = createWorktreeLifecycleTools(deps);
    cleanupWorktree(PROJECT, TASK_ID);

    expect(mockRmSync).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
    expect(mockExec).toHaveBeenCalledWith("git", ["worktree", "prune"], expect.objectContaining({ cwd: PROJECT }));
    // Branch deletion should still be attempted
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", branchName],
      expect.objectContaining({ cwd: PROJECT }),
    );
    expect(deps.taskWorktrees.has(TASK_ID)).toBe(false);
  });

  it("removes from taskWorktrees map", () => {
    mockExec.mockReturnValue(Buffer.from(""));
    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath, branchName, projectPath: PROJECT });

    const { cleanupWorktree } = createWorktreeLifecycleTools(deps);
    cleanupWorktree(PROJECT, TASK_ID);

    expect(deps.taskWorktrees.has(TASK_ID)).toBe(false);
  });

  it("is a no-op if no worktree info exists for the task", () => {
    const deps = makeDeps();
    const { cleanupWorktree } = createWorktreeLifecycleTools(deps);
    cleanupWorktree(PROJECT, TASK_ID);

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("handles branch deletion failure gracefully", () => {
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "branch" && args[1] === "-D") {
        throw new Error("branch not found");
      }
      return Buffer.from("");
    });

    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath, branchName, projectPath: PROJECT });

    const { cleanupWorktree } = createWorktreeLifecycleTools(deps);
    // Should not throw
    expect(() => cleanupWorktree(PROJECT, TASK_ID)).not.toThrow();
    expect(deps.taskWorktrees.has(TASK_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureVideoTaskDirectory
// ---------------------------------------------------------------------------
describe("ensureVideoTaskDirectory", () => {
  it("reuses existing mapping if valid", () => {
    const existingDir = "/home/user/cwd/video_output/abcdef12";
    mockExistsSync.mockReturnValue(true);

    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath: existingDir, branchName: "", projectPath: PROJECT });

    const { ensureVideoTaskDirectory } = createWorktreeLifecycleTools(deps);
    const result = ensureVideoTaskDirectory(PROJECT, TASK_ID);

    expect(result).toBe(existingDir);
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("creates video_output/{shortId}/ directory", () => {
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { ensureVideoTaskDirectory } = createWorktreeLifecycleTools(deps);
    const result = ensureVideoTaskDirectory(PROJECT, TASK_ID);

    const expectedDir = path.join(process.cwd(), "video_output", SHORT_ID);
    expect(result).toBe(expectedDir);
    expect(mockMkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it("creates nested video_output/ directory inside the task dir", () => {
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { ensureVideoTaskDirectory } = createWorktreeLifecycleTools(deps);
    const result = ensureVideoTaskDirectory(PROJECT, TASK_ID);

    expect(mockMkdirSync).toHaveBeenCalledWith(path.join(result, "video_output"), { recursive: true });
  });

  it("stores info in taskWorktrees map", () => {
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    const { ensureVideoTaskDirectory } = createWorktreeLifecycleTools(deps);
    const result = ensureVideoTaskDirectory(PROJECT, TASK_ID);

    const info = deps.taskWorktrees.get(TASK_ID);
    expect(info).toBeDefined();
    expect(info!.worktreePath).toBe(result);
    expect(info!.branchName).toBe("");
    expect(info!.projectPath).toBe(PROJECT);
  });

  it("creates fresh directory when existing mapping path no longer exists", () => {
    const staleDir = "/stale/path/that/doesnt/exist";
    mockExistsSync.mockReturnValue(false);

    const deps = makeDeps();
    deps.taskWorktrees.set(TASK_ID, { worktreePath: staleDir, branchName: "", projectPath: PROJECT });

    const { ensureVideoTaskDirectory } = createWorktreeLifecycleTools(deps);
    const result = ensureVideoTaskDirectory(PROJECT, TASK_ID);

    const expectedDir = path.join(process.cwd(), "video_output", SHORT_ID);
    expect(result).toBe(expectedDir);
    expect(mockMkdirSync).toHaveBeenCalled();
  });
});

describe("finding worktrees again after a restart", () => {
  /**
   * `rehydrateWorktrees` runs once at startup and rebuilds the in-memory map
   * from what is actually on disk. It matters here because the product was
   * renamed from OctoOffice: a checkout created before the rename lives in
   * `.octooffice-worktrees`, is registered in the project's `.git/worktrees`,
   * and belongs to a task that is still open.
   *
   * If rehydration only looked under the new name, that checkout would never
   * be found again — the directory, the git registration and the branch would
   * all leak, and the task would look as though nobody had ever started it.
   * Nothing would error, which is what makes it worth a test.
   */
  function dbWith(rows: Array<{ id: string; project_path: string }>) {
    return { prepare: () => ({ all: () => rows }) };
  }

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExec.mockReset();
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Buffer.from("some-branch\n");
      }
      return Buffer.from("");
    });
  });

  it("finds a worktree created before the rename", () => {
    const legacyDir = path.join(PROJECT, ".octooffice-worktrees", SHORT_ID);
    mockExistsSync.mockImplementation((p: string) => p === legacyDir);

    const map = new Map<string, WorktreeInfo>();
    rehydrateWorktrees(dbWith([{ id: TASK_ID, project_path: PROJECT }]), map);

    expect(map.get(TASK_ID)?.worktreePath).toBe(legacyDir);
  });

  it("finds one created after it", () => {
    const dir = path.join(PROJECT, ".ironcrew-worktrees", SHORT_ID);
    mockExistsSync.mockImplementation((p: string) => p === dir);

    const map = new Map<string, WorktreeInfo>();
    rehydrateWorktrees(dbWith([{ id: TASK_ID, project_path: PROJECT }]), map);

    expect(map.get(TASK_ID)?.worktreePath).toBe(dir);
  });

  it("prefers the new location when a project somehow has both", () => {
    // Can happen mid-migration: an old checkout still open while a new task
    // created one under the new name. The new one wins, and the old one is
    // still reachable by the cleanup path.
    const legacyDir = path.join(PROJECT, ".octooffice-worktrees", SHORT_ID);
    const dir = path.join(PROJECT, ".ironcrew-worktrees", SHORT_ID);
    mockExistsSync.mockImplementation((p: string) => p === dir || p === legacyDir);

    const map = new Map<string, WorktreeInfo>();
    rehydrateWorktrees(dbWith([{ id: TASK_ID, project_path: PROJECT }]), map);

    expect(map.get(TASK_ID)?.worktreePath).toBe(dir);
  });

  it("leaves a task alone when neither directory is there", () => {
    mockExistsSync.mockReturnValue(false);
    const map = new Map<string, WorktreeInfo>();
    rehydrateWorktrees(dbWith([{ id: TASK_ID, project_path: PROJECT }]), map);
    expect(map.size).toBe(0);
  });
});
