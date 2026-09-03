import { spawn, execFileSync } from "node:child_process";

export type CommandCaptureResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export function tailText(value: string, maxChars = 600): string {
  const txt = String(value ?? "").trim();
  if (!txt) return "";
  return txt.length > maxChars ? `...${txt.slice(-maxChars)}` : txt;
}

const RUN_COMMAND_CAPTURE_MAX_CHARS = Math.max(
  16_384,
  Number(process.env.AUTO_UPDATE_COMMAND_OUTPUT_MAX_CHARS ?? 200_000) || 200_000,
);

function limitChunkToTail(chunk: Buffer | string, maxChars: number): Buffer | string {
  if (typeof chunk === "string") {
    return chunk.length > maxChars ? chunk.slice(-maxChars) : chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length > maxChars ? chunk.subarray(chunk.length - maxChars) : chunk;
  }
  return String(chunk ?? "");
}

function appendChunkTail(current: string, chunk: Buffer | string, maxChars: number): string {
  const next = current + String(chunk ?? "");
  if (next.length <= maxChars) return next;
  return next.slice(-maxChars);
}

export function createCommandCaptureTools(deps: { killPidTree: (pid: number) => void }) {
  const { killPidTree } = deps;

  function runCommandCaptureSync(cmd: string, args: string[], timeoutMs: number): CommandCaptureResult {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
      }) as unknown as string;
      return { ok: true, code: 0, stdout: String(stdout ?? ""), stderr: "" };
    } catch (err: unknown) {
      const e = err as Record<string, unknown> | null;
      const stdout = e?.stdout ? String(e.stdout) : "";
      const stderr = e?.stderr ? String(e.stderr) : e?.message ? String(e.message) : "";
      return {
        ok: false,
        code: typeof e?.status === "number" && Number.isFinite(e.status) ? Number(e.status) : 1,
        stdout,
        stderr,
      };
    }
  }

  async function runCommandCapture(cmd: string, args: string[], timeoutMs: number): Promise<CommandCaptureResult> {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;

      const finalize = (result: CommandCaptureResult) => {
        if (finished) return;
        finished = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: unknown) {
        finalize({
          ok: false,
          code: 1,
          stdout,
          stderr: err instanceof Error ? err.message : "spawn_failed",
        });
        return;
      }

      const timer = setTimeout(() => {
        clearTimeout(timer);
        const pid = Number(child.pid ?? 0);
        if (pid > 0) {
          killPidTree(pid);
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
        stderr = appendChunkTail(stderr, `\ncommand_timeout_${timeoutMs}ms`, RUN_COMMAND_CAPTURE_MAX_CHARS);
        finalize({
          ok: false,
          code: 124,
          stdout,
          stderr: stderr.trim(),
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const limitedChunk = limitChunkToTail(chunk, RUN_COMMAND_CAPTURE_MAX_CHARS);
        stdout = appendChunkTail(stdout, limitedChunk, RUN_COMMAND_CAPTURE_MAX_CHARS);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const limitedChunk = limitChunkToTail(chunk, RUN_COMMAND_CAPTURE_MAX_CHARS);
        stderr = appendChunkTail(stderr, limitedChunk, RUN_COMMAND_CAPTURE_MAX_CHARS);
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finalize({ ok: false, code: 1, stdout, stderr: err?.message ? String(err.message) : stderr });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const exit = Number.isFinite(code as number) ? Number(code) : 1;
        finalize({ ok: exit === 0, code: exit, stdout, stderr });
      });
    });
  }

  return {
    runCommandCaptureSync,
    runCommandCapture,
  };
}
