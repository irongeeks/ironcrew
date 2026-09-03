import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseProviderOutput, type ParsedAuthOutput } from "./parsers.ts";

// Strip ANSI escape sequences + control chars that PTY adds
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[>=][^\x1b]*/g, "")
    .replace(/\r/g, "");
}

export interface AuthSession {
  id: string;
  provider: string;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  status: "pending" | "success" | "failed" | "timeout";
  parsed: ParsedAuthOutput;
  createdAt: number;
  /** Whether the provider was already authenticated when the session started */
  wasAuthenticated: boolean;
}

export interface StartResult {
  sessionId: string;
  verificationUrl: string | null;
  deviceCode: string | null;
  needsInput: boolean;
  rawOutput: string;
}

export interface StatusResult {
  status: "pending" | "success" | "failed" | "timeout";
  authenticated: boolean;
  error: string | null;
  needsInput: boolean;
  rawOutput: string;
}

interface CliAuthRunnerDeps {
  detectAllCli: () => Promise<
    Record<string, { installed: boolean; authenticated: boolean; version: string | null; authHint: string }>
  >;
  sessionTtlMs?: number;
}

const PROVIDER_COMMANDS: Record<string, { cmd: string; args: string[]; needsPty?: boolean }> = {
  claude: { cmd: "claude", args: ["auth", "login"] },
  codex: { cmd: "codex", args: ["auth", "login"] },
  gemini: { cmd: "gemini", args: ["auth", "login"] },
};

export class CliAuthRunner {
  private sessions = new Map<string, AuthSession>();
  private detectAllCli: CliAuthRunnerDeps["detectAllCli"];
  private sessionTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(deps: CliAuthRunnerDeps) {
    this.detectAllCli = deps.detectAllCli;
    this.sessionTtlMs = deps.sessionTtlMs ?? 5 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  async startSession(provider: string): Promise<StartResult> {
    const cmdDef = PROVIDER_COMMANDS[provider];
    if (!cmdDef) throw new Error(`Unsupported provider: ${provider}`);

    for (const session of this.sessions.values()) {
      if (session.provider === provider && session.status === "pending") {
        throw new Error(`Auth session already running for ${provider}`);
      }
    }

    const sessionId = randomUUID();

    // Snapshot current auth state so we don't falsely succeed from stale credentials
    let wasAuthenticated = false;
    try {
      const cliResult = await this.detectAllCli();
      wasAuthenticated = cliResult[provider]?.authenticated ?? false;
    } catch {
      // ignore — assume not authenticated
    }

    // CLIs using Ink (like claude setup-token) require a real TTY with raw mode.
    // We use python's pty.fork() to create a proper pseudo-terminal that Ink accepts.
    const proc = cmdDef.needsPty
      ? this.spawnWithPty(cmdDef.cmd, cmdDef.args)
      : spawn(cmdDef.cmd, cmdDef.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

    const session: AuthSession = {
      id: sessionId,
      provider,
      process: proc,
      stdout: "",
      stderr: "",
      status: "pending",
      parsed: { verificationUrl: null, deviceCode: null, needsInput: false },
      createdAt: Date.now(),
      wasAuthenticated,
    };

    this.sessions.set(sessionId, session);

    proc.stdout?.on("data", (chunk: Buffer) => {
      session.stdout += stripAnsi(chunk.toString());
      session.parsed = parseProviderOutput(provider, session.stdout);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      session.stderr += stripAnsi(chunk.toString());
    });

    proc.on("error", (err: Error) => {
      if (session.status !== "pending") return;
      session.status = "failed";
      session.stderr += err.message;
    });

    proc.on("close", async (code) => {
      if (session.status === "timeout") return;
      if (code === 0) {
        try {
          const cliResult = await this.detectAllCli();
          const providerStatus = cliResult[provider];
          session.status = providerStatus?.authenticated ? "success" : "failed";
        } catch {
          session.status = "failed";
        }
      } else {
        session.status = "failed";
      }
    });

    // Wait briefly for stdout to arrive with the URL
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return {
      sessionId,
      verificationUrl: session.parsed.verificationUrl,
      deviceCode: session.parsed.deviceCode,
      needsInput: session.parsed.needsInput,
      rawOutput: session.stdout,
    };
  }

  async getStatus(provider: string, sessionId: string): Promise<StatusResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.provider !== provider) {
      return { status: "failed", authenticated: false, error: "Session not found", needsInput: false, rawOutput: "" };
    }

    if (session.status === "pending") {
      try {
        const cliResult = await this.detectAllCli();
        const providerStatus = cliResult[provider];
        // Only transition to success if credentials actually changed:
        // - Provider was NOT authenticated when the session started, but now is
        // - Or the spawned process already exited with code 0 (handled in close handler)
        if (providerStatus?.authenticated && !session.wasAuthenticated) {
          session.status = "success";
          session.process.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
    }

    // Re-parse stdout to get latest needsInput state
    session.parsed = parseProviderOutput(session.provider, session.stdout);

    return {
      status: session.status,
      authenticated: session.status === "success",
      error: session.status === "failed" ? session.stderr || "Authentication failed" : null,
      needsInput: session.parsed.needsInput,
      rawOutput: session.stdout,
    };
  }

  sendInput(provider: string, sessionId: string, input: string): { sent: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || session.provider !== provider) {
      return { sent: false, error: "Session not found" };
    }
    if (session.status !== "pending") {
      return { sent: false, error: `Session is ${session.status}, not pending` };
    }
    if (!session.process.stdin?.writable) {
      return { sent: false, error: "stdin not writable" };
    }
    // Ink-based CLIs expect \r (carriage return) as Enter, not \n.
    // Write char-by-char with small delays for Ink's raw-mode input handler,
    // then send \r to submit.
    const chars = input.split("");
    let i = 0;
    const writeNext = () => {
      if (i < chars.length) {
        session.process.stdin?.write(chars[i]);
        i++;
        setTimeout(writeNext, 10);
      } else {
        setTimeout(() => session.process.stdin?.write("\r"), 50);
      }
    };
    writeNext();
    return { sent: true };
  }

  cancelSession(provider: string, sessionId: string): { cancelled: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session || session.provider !== provider) {
      return { cancelled: false };
    }
    session.process.kill("SIGTERM");
    this.sessions.delete(sessionId);
    return { cancelled: true };
  }

  /** Spawn a command inside a python pty so Ink-based CLIs get a real terminal */
  private spawnWithPty(cmd: string, args: string[]): ChildProcess {
    // Build Python argument list: os.execlp('claude', 'claude', 'setup-token')
    const pyArgs = [cmd, ...args].map((a) => `'${a.replace(/'/g, "\\'")}'`).join(",");
    const pyScript = `
import pty,os,sys,signal,select
pid,fd=pty.fork()
if pid==0:
  os.environ['TERM']='dumb'
  os.environ['NO_COLOR']='1'
  os.execlp(${pyArgs})
else:
  signal.signal(signal.SIGTERM,lambda s,f:(os.kill(pid,signal.SIGTERM),sys.exit(0)))
  while True:
    r,_,_=select.select([fd,0],[],[],1)
    if fd in r:
      try:
        d=os.read(fd,4096)
        if not d:break
        sys.stdout.buffer.write(d);sys.stdout.buffer.flush()
      except OSError:break
    if 0 in r:
      try:
        d=os.read(0,4096)
        if d:os.write(fd,d)
      except OSError:pass
`;
    return spawn("python3", ["-c", pyScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.sessionTtlMs) {
        if (session.status === "pending") {
          session.status = "timeout";
          session.process.kill("SIGTERM");
        }
        this.sessions.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      session.process.kill("SIGTERM");
    }
    this.sessions.clear();
  }
}
