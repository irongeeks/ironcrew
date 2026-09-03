import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reproducer for B-001 (issue #51): shell injection via user-controlled GitHub PAT
// in the GIT_ASKPASS script body. The original code at
// server/modules/routes/core/github-routes.ts:249 interpolated the token directly
// into a shell script, which means a token containing $(cmd), backticks, quotes,
// or newlines would be evaluated by /bin/sh when git invoked the askpass helper.
//
// The fix extracts the askpass-script logic into a tested helper that:
//   1) validates the token against a strict GitHub-PAT character class,
//   2) writes a static shell script that reads the token from an env var
//      (so the token never appears in the script body), and
//   3) returns both the script path and the env vars to pass to spawn().
import { createGitAskpassScript } from "../../../modules/routes/core/git-askpass.ts";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    const p = cleanups.pop();
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      // already removed
    }
  }
});

describe("createGitAskpassScript — token validation (B-001)", () => {
  const malicious: Array<[string, string]> = [
    ["command substitution", "$(touch /tmp/pwned)"],
    ["backtick execution", "`echo pwned`"],
    ["quote break-out", `"; rm -rf /; echo "`],
    ["newline injection", "ghp_valid\necho INJECTED"],
    ["semicolon command chain", "ghp_valid; rm -rf /"],
    ["space-separated payload", "ghp_valid && curl evil"],
    ["dollar variable", "$HOME"],
    ["empty token", ""],
  ];

  it.each(malicious)("rejects token with %s", (_label, token) => {
    expect(() => createGitAskpassScript(token)).toThrow(/invalid.*token|token.*format/i);
  });

  it("accepts a classic 40-char hex token", () => {
    const token = "a".repeat(40);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    expect(result.scriptPath).toBeTruthy();
  });

  it("accepts a ghp_ prefixed personal access token", () => {
    const token = "ghp_" + "A".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    expect(result.scriptPath).toBeTruthy();
  });

  it("accepts a fine-grained github_pat_ token", () => {
    const token = "github_pat_" + "B".repeat(82);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    expect(result.scriptPath).toBeTruthy();
  });

  it("accepts an installation token (ghs_)", () => {
    const token = "ghs_" + "C".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    expect(result.scriptPath).toBeTruthy();
  });
});

describe("createGitAskpassScript — script content (B-001)", () => {
  it("does NOT embed the token literally in the script body", () => {
    const token = "ghp_" + "Z".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const body = fs.readFileSync(result.scriptPath, "utf8");
    expect(body).not.toContain(token);
  });

  it("references an env variable for the token", () => {
    const token = "ghp_" + "Y".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const body = fs.readFileSync(result.scriptPath, "utf8");
    // The script should expand an env var via "$VARNAME" rather than carry the token.
    expect(body).toMatch(/\$[A-Z_][A-Z0-9_]*/);
  });

  it("returns env vars containing the token under the same name referenced by the script", () => {
    const token = "ghp_" + "X".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const body = fs.readFileSync(result.scriptPath, "utf8");
    const match = body.match(/\$([A-Z_][A-Z0-9_]*)/);
    expect(match).not.toBeNull();
    const varName = match![1];
    expect(result.env[varName]).toBe(token);
  });

  it("script starts with a shebang line", () => {
    const token = "ghp_" + "W".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const body = fs.readFileSync(result.scriptPath, "utf8");
    expect(body.startsWith("#!")).toBe(true);
  });
});

describe("createGitAskpassScript — file system safety (B-001)", () => {
  it("creates the script with mode 0o700 (owner rwx only)", () => {
    const token = "ghp_" + "V".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const st = fs.statSync(result.scriptPath);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("places the script in the OS temp directory by default", () => {
    const token = "ghp_" + "U".repeat(36);
    const result = createGitAskpassScript(token);
    cleanups.push(result.scriptPath);
    const tmp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(path.dirname(result.scriptPath))).toBe(tmp);
  });

  it("provides a cleanup function that removes the script file", () => {
    const token = "ghp_" + "T".repeat(36);
    const result = createGitAskpassScript(token);
    expect(fs.existsSync(result.scriptPath)).toBe(true);
    result.cleanup();
    expect(fs.existsSync(result.scriptPath)).toBe(false);
  });

  it("cleanup is idempotent — calling twice does not throw", () => {
    const token = "ghp_" + "S".repeat(36);
    const result = createGitAskpassScript(token);
    result.cleanup();
    expect(() => result.cleanup()).not.toThrow();
  });
});
