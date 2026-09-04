import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Token character class allowed for GitHub PATs and OAuth tokens. Strict
// alphanumerics plus `_` and `-` covers all documented token shapes:
//   - classic 40-char hex                e.g. abcdef0123…
//   - personal access token              e.g. ghp_<36 chars>
//   - server-to-server install token     e.g. ghs_<36 chars>
//   - user-to-server (OAuth) token       e.g. gho_<36 chars>
//   - refresh token                      e.g. ghr_<36 chars>
//   - fine-grained PAT                   e.g. github_pat_<82 chars>
// Any character outside this set indicates a malformed or hostile token
// (newlines, $, `, ", spaces, ;, &) and MUST be rejected.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,255}$/;

// Generated per call and handed straight to the child process — never read
// from the operator's environment, so the rename needs no compatibility.
const ENV_VAR_NAME = "IRONCREW_GIT_ASKPASS_TOKEN";

export interface GitAskpassResult {
  scriptPath: string;
  env: Record<string, string>;
  cleanup(): void;
}

/**
 * Create a temporary GIT_ASKPASS helper script that returns a token to git
 * without ever embedding the token in the script body. The token is passed
 * in via an environment variable that spawn() must merge into the child
 * process env.
 *
 * Defends against B-001: a token containing $(cmd), backticks, quotes, or
 * newlines previously caused /bin/sh to evaluate it. The fix has two layers:
 *   1) strict token format validation (rejects anything outside [A-Za-z0-9_-])
 *   2) env-var indirection (the script body is a static literal that prints
 *      the env var; the token is only ever a string in process memory).
 */
export function createGitAskpassScript(token: string): GitAskpassResult {
  if (!TOKEN_RE.test(token)) {
    throw new Error("invalid GitHub token format");
  }

  const scriptPath = path.join(os.tmpdir(), `git-askpass-${randomUUID()}.sh`);
  // The script body is a static constant. `printf '%s\n' "$VAR"` is safer
  // than `echo "$VAR"` (echo is not portable for values starting with `-`).
  const body = `#!/bin/sh\nprintf '%s\\n' "$${ENV_VAR_NAME}"\n`;
  fs.writeFileSync(scriptPath, body, { mode: 0o700 });

  const env: Record<string, string> = { [ENV_VAR_NAME]: token };

  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // already removed or never existed — both are fine for cleanup
    }
  };

  return { scriptPath, env, cleanup };
}
