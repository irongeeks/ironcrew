import path from "node:path";
import { execFileSync } from "node:child_process";

export const DIFF_SUMMARY_NONE = "__DIFF_NONE__";
export const DIFF_SUMMARY_ERROR = "__DIFF_ERROR__";

const AUTO_COMMIT_ALLOWED_UNTRACKED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".xml",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
]);
const AUTO_COMMIT_ALLOWED_UNTRACKED_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "cmakelists.txt",
  "readme",
  "license",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.json",
  ".env.example",
]);
const AUTO_COMMIT_BLOCKED_DIR_SEGMENTS = new Set([
  ".git",
  ".octooffice",
  ".octooffice-worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "logs",
  "tmp",
  "temp",
]);
const AUTO_COMMIT_ALLOWED_DOT_DIR_SEGMENTS = new Set([".github", ".storybook", ".changeset", ".husky", ".vscode"]);
const AUTO_COMMIT_BLOCKED_FILE_PATTERN =
  /(^|\/)(\.env($|[./])|id_rsa|id_ed25519|known_hosts|authorized_keys|.*\.(pem|key|p12|pfx|crt|cer|der|kdbx|sqlite|db|log|zip|tar|gz|tgz|rar|7z))$/i;

export function hasVisibleDiffSummary(summary: string): boolean {
  return Boolean(summary && summary !== DIFF_SUMMARY_NONE && summary !== DIFF_SUMMARY_ERROR);
}

export function readWorktreeStatusShort(worktreePath: string): string {
  try {
    return execFileSync("git", ["status", "--short"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function readGitNullSeparated(worktreePath: string, args: string[]): string[] {
  try {
    const out = execFileSync("git", args, {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 10000,
    }).toString("utf8");
    return out.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function normalizeRepoRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function isSafeUntrackedPathForAutoCommit(filePath: string): boolean {
  const normalized = normalizeRepoRelativePath(filePath);
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;

  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  for (const seg of segments.slice(0, -1)) {
    if (seg.startsWith(".") && !AUTO_COMMIT_ALLOWED_DOT_DIR_SEGMENTS.has(seg)) return false;
    if (AUTO_COMMIT_BLOCKED_DIR_SEGMENTS.has(seg)) return false;
  }

  if (AUTO_COMMIT_BLOCKED_FILE_PATTERN.test(lower)) {
    // Explicit allow for template env file
    if (lower === ".env.example" || lower.endsWith("/.env.example")) return true;
    return false;
  }

  const base = segments[segments.length - 1] || "";
  if (AUTO_COMMIT_ALLOWED_UNTRACKED_BASENAMES.has(base)) return true;
  const ext = path.extname(base);
  return AUTO_COMMIT_ALLOWED_UNTRACKED_EXTENSIONS.has(ext);
}

function stageWorktreeChangesForAutoCommit(
  taskId: string,
  worktreePath: string,
  appendTaskLog: (taskId: string, kind: string, message: string) => void,
): { stagedPaths: string[]; blockedUntrackedPaths: string[]; error: string | null } {
  try {
    // Tracked edits/deletions/renames are safe to stage in bulk.
    execFileSync("git", ["add", "-u"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 10000,
    });

    const untracked = readGitNullSeparated(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    const blockedUntrackedPaths: string[] = [];
    const safeUntrackedPaths: string[] = [];
    for (const rawPath of untracked) {
      const relPath = normalizeRepoRelativePath(rawPath);
      if (!relPath) continue;
      if (!isSafeUntrackedPathForAutoCommit(relPath)) {
        blockedUntrackedPaths.push(relPath);
        continue;
      }
      safeUntrackedPaths.push(relPath);
    }

    if (safeUntrackedPaths.length > 0) {
      const chunkSize = 200;
      for (let i = 0; i < safeUntrackedPaths.length; i += chunkSize) {
        const chunk = safeUntrackedPaths.slice(i, i + chunkSize);
        execFileSync("git", ["add", "--", ...chunk], {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 10000,
        });
      }
    }

    if (blockedUntrackedPaths.length > 0) {
      const preview = blockedUntrackedPaths.slice(0, 8).join(", ");
      const suffix = blockedUntrackedPaths.length > 8 ? " ..." : "";
      appendTaskLog(
        taskId,
        "system",
        `Auto-commit skipped ${blockedUntrackedPaths.length} restricted untracked path(s): ${preview}${suffix}`,
      );
    }

    const stagedPaths = readGitNullSeparated(worktreePath, ["diff", "--cached", "--name-only", "-z", "--"])
      .map(normalizeRepoRelativePath)
      .filter(Boolean);
    return { stagedPaths, blockedUntrackedPaths, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stagedPaths: [], blockedUntrackedPaths: [], error: msg };
  }
}

export function autoCommitWorktreePendingChanges(
  taskId: string,
  info: { worktreePath: string; branchName: string },
  appendTaskLog: (taskId: string, kind: string, message: string) => void,
): {
  committed: boolean;
  error: string | null;
  errorKind: "restricted_untracked" | "git_error" | null;
  restrictedUntrackedCount: number;
} {
  const statusBefore = readWorktreeStatusShort(info.worktreePath);
  if (!statusBefore) {
    return {
      committed: false,
      error: null,
      errorKind: null,
      restrictedUntrackedCount: 0,
    };
  }

  try {
    const staged = stageWorktreeChangesForAutoCommit(taskId, info.worktreePath, appendTaskLog);
    if (staged.error) {
      return {
        committed: false,
        error: staged.error,
        errorKind: "git_error",
        restrictedUntrackedCount: 0,
      };
    }
    if (staged.stagedPaths.length === 0) {
      if (staged.blockedUntrackedPaths.length > 0) {
        return {
          committed: false,
          error: `auto-commit blocked by restricted untracked files (${staged.blockedUntrackedPaths.length})`,
          errorKind: "restricted_untracked",
          restrictedUntrackedCount: staged.blockedUntrackedPaths.length,
        };
      }
      return {
        committed: false,
        error: null,
        errorKind: null,
        restrictedUntrackedCount: 0,
      };
    }

    execFileSync(
      "git",
      [
        "-c",
        "user.name=OctoOffice",
        "-c",
        "user.email=octooffice@local",
        "commit",
        "-m",
        `chore: auto-commit pending task changes (${taskId.slice(0, 8)})`,
      ],
      {
        cwd: info.worktreePath,
        stdio: "pipe",
        timeout: 15000,
      },
    );
    appendTaskLog(taskId, "system", `Worktree auto-commit created on ${info.branchName} before merge`);
    return {
      committed: true,
      error: null,
      errorKind: null,
      restrictedUntrackedCount: 0,
    };
  } catch (err: unknown) {
    const statusAfter = readWorktreeStatusShort(info.worktreePath);
    if (!statusAfter) {
      return {
        committed: false,
        error: null,
        errorKind: null,
        restrictedUntrackedCount: 0,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    appendTaskLog(taskId, "system", `Worktree auto-commit failed: ${msg}`);
    return {
      committed: false,
      error: msg,
      errorKind: "git_error",
      restrictedUntrackedCount: 0,
    };
  }
}
