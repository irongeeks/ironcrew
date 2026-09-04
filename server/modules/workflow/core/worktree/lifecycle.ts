import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "../../../../observability/logger.ts";
import {
  LEGACY_WORKTREE_BRANCH_PREFIX,
  LEGACY_WORKTREE_DIR_NAME,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_NAME,
} from "./shared.ts";

const log = logger.child({ module: "core-workflow" });

export type WorktreeInfo = {
  worktreePath: string;
  branchName: string;
  projectPath: string;
};

type CreateWorktreeLifecycleToolsDeps = {
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  taskWorktrees: Map<string, WorktreeInfo>;
};

export function createWorktreeLifecycleTools(deps: CreateWorktreeLifecycleToolsDeps) {
  const { appendTaskLog, taskWorktrees } = deps;

  function isGitRepo(dir: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  function ensureWorktreeBootstrapRepo(projectPath: string, taskId: string): boolean {
    if (isGitRepo(projectPath)) return true;
    appendTaskLog(
      taskId,
      "system",
      `Git bootstrap skipped: '${projectPath}' is not a git repository. Worktree creation requires an existing git repo.`,
    );
    return false;
  }

  function createWorktree(projectPath: string, taskId: string, agentName: string, baseBranch?: string): string | null {
    // Reuse existing worktree if still present (e.g. preserved across pipeline steps)
    const existing = taskWorktrees.get(taskId) as
      | { worktreePath?: string; branchName?: string; projectPath?: string }
      | undefined;
    if (existing?.worktreePath && fs.existsSync(existing.worktreePath)) {
      try {
        // Verify the worktree directory is still a valid git worktree
        execFileSync("git", ["rev-parse", "--git-dir"], { cwd: existing.worktreePath, stdio: "pipe", timeout: 5000 });
        log.info(
          { taskId: taskId.slice(0, 8), worktreePath: existing.worktreePath, agent: agentName },
          "reusing existing worktree",
        );
        return existing.worktreePath;
      } catch {
        // Worktree directory exists but is invalid — remove mapping and recreate
        taskWorktrees.delete(taskId);
      }
    }

    if (!ensureWorktreeBootstrapRepo(projectPath, taskId)) return null;
    if (!isGitRepo(projectPath)) return null;

    const shortId = taskId.slice(0, 8);
    const branchName = `${WORKTREE_BRANCH_PREFIX}/${shortId}`;
    const worktreeBase = path.join(projectPath, WORKTREE_DIR_NAME);
    const worktreePath = path.join(worktreeBase, shortId);

    try {
      fs.mkdirSync(worktreeBase, { recursive: true });
      execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });

      // Get current branch/HEAD as base
      let base: string;
      if (baseBranch) {
        try {
          base = execFileSync("git", ["rev-parse", baseBranch], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        } catch {
          base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        }
      } else {
        base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
          .toString()
          .trim();
      }

      const branchCandidates = [branchName, `${branchName}-1`, `${branchName}-2`, `${branchName}-3`];
      let created = false;
      let selectedBranch = branchName;
      let selectedWorktreePath = worktreePath;
      let lastError: unknown = null;

      for (let idx = 0; idx < branchCandidates.length; idx += 1) {
        const candidateBranch = branchCandidates[idx]!;
        const candidatePath = idx === 0 ? worktreePath : path.join(worktreeBase, `${shortId}-${idx}`);
        try {
          if (fs.existsSync(candidatePath)) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
          }
        } catch {
          // best effort cleanup
        }

        const branchExists = (() => {
          try {
            execFileSync("git", ["show-ref", "--verify", `refs/heads/${candidateBranch}`], {
              cwd: projectPath,
              stdio: "pipe",
              timeout: 5000,
            });
            return true;
          } catch {
            return false;
          }
        })();

        const addArgs = branchExists
          ? ["worktree", "add", candidatePath, candidateBranch]
          : ["worktree", "add", candidatePath, "-b", candidateBranch, base];

        try {
          execFileSync("git", addArgs, {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 15000,
          });
          selectedBranch = candidateBranch;
          selectedWorktreePath = candidatePath;
          created = true;
          break;
        } catch (err: unknown) {
          lastError = err;
        }
      }

      if (!created) throw lastError instanceof Error ? lastError : new Error("worktree_add_failed");

      // Propagate .claude/skills into the worktree so agents can resolve installed skills
      try {
        const serverSkillsDir = path.join(process.cwd(), ".claude", "skills");
        if (fs.existsSync(serverSkillsDir)) {
          const wtClaudeDir = path.join(selectedWorktreePath, ".claude");
          const wtSkillsLink = path.join(wtClaudeDir, "skills");
          if (!fs.existsSync(wtSkillsLink)) {
            fs.mkdirSync(wtClaudeDir, { recursive: true });
            fs.symlinkSync(serverSkillsDir, wtSkillsLink, "junction");
          }
        }
      } catch {
        // best effort — skill propagation failure should not block execution
      }

      taskWorktrees.set(taskId, { worktreePath: selectedWorktreePath, branchName: selectedBranch, projectPath });
      log.info(
        { taskId: shortId, worktreePath: selectedWorktreePath, branch: selectedBranch, agent: agentName },
        "created worktree for task",
      );
      return selectedWorktreePath;
    } catch (err: unknown) {
      log.error({ taskId: shortId, err }, "failed to create worktree for task");
      return null;
    }
  }

  function cleanupWorktree(projectPath: string, taskId: string): void {
    const info = taskWorktrees.get(taskId);
    if (!info) return;

    const shortId = taskId.slice(0, 8);

    try {
      execFileSync("git", ["worktree", "remove", info.worktreePath, "--force"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      log.warn({ taskId: shortId }, "git worktree remove failed, falling back to manual cleanup");
      try {
        if (fs.existsSync(info.worktreePath)) {
          fs.rmSync(info.worktreePath, { recursive: true, force: true });
        }
        execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }
    }

    try {
      execFileSync("git", ["branch", "-D", info.branchName], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      log.warn({ branch: info.branchName }, "failed to delete branch — may need manual cleanup");
    }

    taskWorktrees.delete(taskId);
    log.info({ taskId: shortId }, "cleaned up worktree for task");
  }

  /**
   * Create a plain (non-git) task directory for video pipeline tasks.
   * Uses a fixed base directory (video_output/) in the server's cwd so video tasks
   * don't require a dashboard project. Each task gets {cwd}/video_output/{shortId}/.
   * Reuses the existing directory across pipeline phases (concept → screenplay → … → assembly).
   */
  function ensureVideoTaskDirectory(projectPath: string, taskId: string): string {
    // Reuse existing mapping if still valid (pipeline phases reuse the same directory)
    const existing = taskWorktrees.get(taskId) as
      | { worktreePath?: string; branchName?: string; projectPath?: string }
      | undefined;
    if (existing?.worktreePath && fs.existsSync(existing.worktreePath)) {
      return existing.worktreePath;
    }

    const shortId = taskId.slice(0, 8);
    const videoOutputBase = path.join(process.cwd(), "video_output");
    const taskDir = path.join(videoOutputBase, shortId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, "video_output"), { recursive: true });

    // Store in taskWorktrees map so other code paths (artifact discovery, docs sync) can find the path
    taskWorktrees.set(taskId, { worktreePath: taskDir, branchName: "", projectPath });

    return taskDir;
  }

  return {
    isGitRepo,
    createWorktree,
    cleanupWorktree,
    ensureVideoTaskDirectory,
  };
}

/**
 * Rehydrate the in-memory taskWorktrees map from existing worktree directories on disk.
 * Called once at server startup to restore worktree info lost by restart.
 */
export function rehydrateWorktrees(
  db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } },
  taskWorktrees: Map<string, WorktreeInfo>,
): void {
  const rows = db
    .prepare(
      "SELECT id, project_path FROM tasks WHERE status IN ('review', 'in_progress', 'planned', 'pending') AND project_path IS NOT NULL AND TRIM(project_path) != ''",
    )
    .all() as Array<{ id: string; project_path: string }>;

  for (const row of rows) {
    if (taskWorktrees.has(row.id)) continue;
    const shortId = row.id.slice(0, 8);
    // Both directory names, new first.
    //
    // A worktree created before the rename is a real git checkout that this
    // project still has registered in `.git/worktrees`, with a task row
    // pointing at it. Looking only under the new name would leave it
    // unrehydrated — the directory, the registration and the branch would all
    // leak, and the task would look as though nobody had ever started it.
    // Rehydration is read-only, so recognising both costs a stat.
    const candidates = [WORKTREE_DIR_NAME, LEGACY_WORKTREE_DIR_NAME].flatMap((dirName) => {
      const base = path.join(row.project_path, dirName);
      const prefix = dirName === WORKTREE_DIR_NAME ? WORKTREE_BRANCH_PREFIX : LEGACY_WORKTREE_BRANCH_PREFIX;
      return ["", "-1", "-2", "-3"].map((suffix) => ({
        dir: path.join(base, `${shortId}${suffix}`),
        branch: `${prefix}/${shortId}${suffix}`,
      }));
    });

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.dir)) continue;
      try {
        execFileSync("git", ["rev-parse", "--git-dir"], {
          cwd: candidate.dir,
          stdio: "pipe",
          timeout: 5000,
        });
        const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: candidate.dir,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        taskWorktrees.set(row.id, {
          worktreePath: candidate.dir,
          branchName: branch || candidate.branch,
          projectPath: row.project_path,
        });
        log.info({ taskId: shortId, worktreePath: candidate.dir, branch }, "rehydrated worktree from disk");
        break;
      } catch {
        log.warn({ taskId: shortId, dir: candidate.dir }, "worktree dir exists but is not a valid git worktree");
      }
    }
  }
}
