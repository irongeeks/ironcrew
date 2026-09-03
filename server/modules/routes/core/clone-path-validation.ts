import path from "node:path";

// Pure validator for /api/github/clone target paths.
//
// Defends against B-003 (#54): the original code took `repo` and
// `target_path` from the request body and joined them onto the home
// directory without any validation, allowing path traversal both via
// repo (`../../etc`) and via absolute target_path (`/etc/cron.d/...`).
//
// Strategy:
//   1) reject owner/repo that don't match the GitHub character class
//      (`[A-Za-z0-9._-]+`), are dot-only, start with `.`, or are empty
//   2) expand `~` and `~/`
//   3) resolve the absolute path with `path.resolve()`
//   4) refuse anything that doesn't sit inside `homeRoot`
//
// `homeRoot` is injected so the function is testable without monkey-
// patching `os.homedir()`. Production callers pass `os.homedir()`.

// GitHub's actual rules are stricter (no leading `-`, no consecutive `..`,
// 39-char max for usernames), but the relaxed character class plus our
// dot-prefix and `..` checks below are sufficient to keep clone targets
// safely under the home root.
const GH_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface ResolveClonePathInput {
  owner: string;
  repo: string;
  targetPath?: string | null;
  homeRoot: string;
}

function assertValidGhName(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}: must be a non-empty string`);
  }
  if (!GH_NAME_RE.test(value)) {
    throw new Error(`invalid ${label}: contains characters outside [A-Za-z0-9._-]`);
  }
  if (value === "." || value === "..") {
    throw new Error(`invalid ${label}: must not be "." or ".."`);
  }
  if (value.startsWith(".")) {
    throw new Error(`invalid ${label}: must not start with "."`);
  }
}

function isContained(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

export function resolveClonePath(input: ResolveClonePathInput): string {
  const { owner, repo, homeRoot } = input;

  assertValidGhName("owner", owner);
  assertValidGhName("repo", repo);

  if (typeof homeRoot !== "string" || !path.isAbsolute(homeRoot)) {
    throw new Error("homeRoot must be an absolute path");
  }

  // Trim and decide whether to use the user-supplied path or the default.
  const raw = typeof input.targetPath === "string" ? input.targetPath.trim() : "";
  let candidate: string;
  if (raw.length === 0) {
    candidate = path.join(homeRoot, "Projects", repo);
  } else {
    // Reject any whitespace or control character inside the path. The
    // outer trim() above only removes leading/trailing whitespace, so
    // anything left here is an embedded separator (\n, \t, \0, ...).
    if (/[\s\0]/.test(raw)) {
      throw new Error("invalid path: contains whitespace or control characters");
    }
    if (raw === "~") {
      candidate = homeRoot;
    } else if (raw.startsWith("~/")) {
      candidate = path.join(homeRoot, raw.slice(2));
    } else if (path.isAbsolute(raw)) {
      candidate = path.resolve(raw);
    } else {
      // Relative paths anchor to homeRoot (consistent with `~/<path>`).
      candidate = path.resolve(homeRoot, raw);
    }
  }

  const resolved = path.resolve(candidate);
  if (!isContained(resolved, homeRoot)) {
    throw new Error("invalid path: resolved location is outside the home directory");
  }
  return resolved;
}
