/**
 * IronCrew — spawn environment preparation.
 *
 * Pure functions, lifted from the pattern IronCrew's cli-runtime.ts already
 * uses, so the CliAdapterRuntime spawn path behaves the same way an operator
 * already expects: strip nested-session markers, fall back to the common CLI
 * install directories a login shell would have but a service process might
 * not, and force non-interactive/non-colour output so stream parsing sees
 * plain text.
 */

import path from "node:path";
import os from "node:os";

/** Directories official CLI installers commonly add, which a spawned child's PATH may lack. */
export function cliPathFallbackDirs(homeDir = os.homedir()): string[] {
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, "bin"),
  ];
}

/** Append fallback dirs to an existing PATH value, de-duplicated, order preserved. */
export function withCliPathFallback(pathValue: string | undefined, fallbackDirs: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of (pathValue ?? "").split(path.delimiter)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    parts.push(trimmed);
    seen.add(trimmed);
  }
  for (const dir of fallbackDirs) {
    if (!dir || seen.has(dir)) continue;
    parts.push(dir);
    seen.add(dir);
  }
  return parts.join(path.delimiter);
}

/**
 * Build the environment for a spawned CLI process.
 *
 * - Removes CLAUDECODE/CLAUDE_CODE so the child does not detect a "nested
 *   session" and refuse to run (IronCrew's own process may itself be
 *   invoked from inside a Claude Code session).
 * - Extends PATH with the common install directories.
 * - Forces NO_COLOR/FORCE_COLOR/CI so the CLI emits plain, parseable output
 *   rather than ANSI-decorated interactive formatting.
 * - Leaves TERM alone if the caller already set one; some CLIs behave oddly
 *   with no TERM at all, so a safe default ("dumb") is supplied only when
 *   absent.
 */
export function buildCliSpawnEnv(base: NodeJS.ProcessEnv, opts: { homeDir?: string } = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) clean[key] = value;
  }
  delete clean.CLAUDECODE;
  delete clean.CLAUDE_CODE;
  clean.PATH = withCliPathFallback(clean.PATH, cliPathFallbackDirs(opts.homeDir));
  clean.NO_COLOR = "1";
  clean.FORCE_COLOR = "0";
  clean.CI = "1";
  if (!clean.TERM) clean.TERM = "dumb";
  return clean;
}
