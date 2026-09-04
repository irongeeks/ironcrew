/**
 * IronCrew — minimal argv-array CLI runner, shared by every module that
 * wraps a third-party CLI for a single request/response call (the secret
 * providers' `bw`/`pass-cli`, the Tailscale status wrapper's `tailscale`).
 *
 * Same non-negotiables as CliAdapterRuntime (runtime/cli-adapter-runtime.ts),
 * scaled down for one call rather than a long streaming run: argv array only
 * (never shell string concatenation), a hard timeout, and separate
 * stdout/stderr capture. Unlike CliAdapterRuntime this never touches
 * StreamRedactor itself — that is a concern specific to what a caller does
 * with the output (a secret provider's raw resolved value; a network
 * status wrapper's peer list) that this generic runner has no visibility
 * into, so it stays the caller's responsibility.
 *
 * `CliRunner` is a plain function type, not a class, so tests can inject a
 * fake instead of spawning a real `bw` / `pass-cli` / `tailscale` binary —
 * none is installed in this environment (or CI), and a fake keeps every
 * wrapper's tests fast and deterministic.
 */

import { spawn } from "node:child_process";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface CliRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to stdin and closed. Omit to close stdin immediately with no input. */
  input?: string;
}

export type CliRunner = (argv: readonly string[], opts?: CliRunOptions) => Promise<CliRunResult>;

export class CliTimeoutError extends Error {}

/** Real process spawner. argv[0] is the binary, argv.slice(1) are its arguments — never a shell string. */
export const spawnCliRunner: CliRunner = (argv, opts = {}) => {
  if (argv.length === 0) return Promise.reject(new Error("spawnCliRunner: empty argv"));
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            reject(new CliTimeoutError(`${argv[0]} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
};
