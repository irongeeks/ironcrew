/**
 * Iron Command OS — CliAdapterRuntime.
 *
 * The bridge between the normalised AgentRuntime contract and OctoOffice's
 * existing CLI adapters (server/adapters/{claude,codex,gemini}.ts). This is
 * what turns the MockRuntime-only vertical slice into one that can drive a
 * real Claude Code / Codex / Gemini CLI session.
 *
 * Deliberately independent of the upstream runtime god-object
 * (server/modules/workflow/agents/cli-runtime.ts): it takes a CliAdapter and
 * nothing else, so it is constructible and testable headlessly. It reuses the
 * adapter's own argv building and stream parsing — the part that actually
 * knows each CLI's protocol — and supplies everything the normalised
 * contract adds on top: redaction, rate-limit detection, idle/hard timeouts,
 * process-tree cancellation, and the mapping onto the seventeen-type run
 * protocol documented in docs/RUNNER_PROTOCOL.md.
 *
 * Mandatory runtime behaviour (docs/RUNNER_PROTOCOL.md) this satisfies:
 *   - capability detection via the adapter's own testEnvironment(), not an
 *     assumption that a flag exists
 *   - auth status without ever emitting a secret
 *   - streaming
 *   - clean process-group termination on cancel
 *   - idle and hard timeouts
 *   - heartbeats (via the normal event flow — the caller heartbeats on every
 *     persisted event, so any event this runtime emits keeps the run alive)
 *   - rate-limit detection as its own event, not a generic failure
 *   - separate stdout/stderr capture
 *   - redaction before anything is emitted
 *   - argv array only — never shell string concatenation
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "../../adapters/adapter-interface.ts";
import { assertArgsMatchMode } from "../policy/runtime-permissions.ts";
import { REDACTED, StreamRedactor } from "../security/redaction.ts";
import { AsyncEventChannel } from "./async-channel.ts";
import { buildCliSpawnEnv } from "./process-env.ts";
import { isPidAlive, killProcessTree } from "./process-kill.ts";
import { detectRateLimit } from "./rate-limit-detect.ts";
import { newId } from "../domain/ids.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunEventType,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
} from "./run-events.ts";

/** Per-provider defaults from docs/PROVIDER_AUTH.md. Overridable per instance. */
const DEFAULT_CONCURRENCY: Record<string, number> = {
  claude: 1,
  codex: 2,
  gemini: 2,
};

export interface CliAdapterRuntimeOptions {
  /** Kill the process if no output arrives for this long. 0 disables. Default 10 min. */
  idleTimeoutMs?: number;
  /** Kill the process unconditionally after this long. 0 disables. Default 30 min. */
  hardTimeoutMs?: number;
  /** Stop reading output past this many bytes per stream, to bound memory on a runaway process. */
  maxOutputBytes?: number;
  /** How long after SIGTERM to escalate to SIGKILL. */
  killGraceMs?: number;
}

interface RunHandle {
  child: ChildProcess;
  cancelled: boolean;
}

const DEFAULT_OPTIONS: Required<CliAdapterRuntimeOptions> = {
  idleTimeoutMs: 10 * 60_000,
  hardTimeoutMs: 30 * 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  killGraceMs: 1200,
};

export class CliAdapterRuntime implements AgentRuntime {
  readonly id: string;
  readonly type: string;

  private readonly adapter: CliAdapter;
  private readonly opts: Required<CliAdapterRuntimeOptions>;
  private readonly running = new Map<string, RunHandle>();

  constructor(adapter: CliAdapter, options: CliAdapterRuntimeOptions = {}) {
    this.adapter = adapter;
    this.id = adapter.providerType;
    this.type = adapter.providerType;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const env = await this.adapter.testEnvironment();
    return {
      streaming: true,
      // Honest rather than aspirational: none of the wrapped adapters expose
      // a session-resume flag today. Claiming true here would be exactly the
      // "invented integration success" the project principles forbid.
      sessionResume: false,
      usageReporting: this.adapter.supportsTokenTracking,
      // Subscription CLIs report no per-call price.
      costReporting: false,
      toolCalls: true,
      subagents: typeof this.adapter.detectSubtask === "function",
      defaultConcurrency: DEFAULT_CONCURRENCY[this.type] ?? 1,
      version: env.version,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const env = await this.adapter.testEnvironment();
    return { healthy: env.ok, installed: env.ok, detail: env.message, checkedAt: Date.now() };
  }

  async authStatus(): Promise<AuthStatus> {
    const env = await this.adapter.testEnvironment();
    if (!env.ok) {
      return {
        authenticated: false,
        method: "subscription-cli",
        detail: env.message,
        setupHint: `Install the ${this.adapter.name} and log in with its official CLI login, then retry.`,
      };
    }
    // env.version is a CLI version string, not an account identifier — safe
    // to surface as the non-identifying hint the AuthStatus contract allows.
    return { authenticated: true, method: "subscription-cli", detail: env.message, accountHint: env.version };
  }

  async cancelRun(runId: string): Promise<void> {
    const handle = this.running.get(runId);
    if (!handle) return;
    handle.cancelled = true;
    if (handle.child.pid) killProcessTree(handle.child.pid, this.opts.killGraceMs);
  }

  async *resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    // No wrapped adapter supports session resume (see capabilities() above);
    // resuming degrades to a fresh run rather than silently losing context
    // differently. The prior sessionRef is at least recorded on the event.
    yield* this.startRun({ ...input, sessionRef }, context);
  }

  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    const invocation: InvocationContext = {
      prompt: input.prompt,
      workdir: context.workspacePath,
      model: input.model,
      permissionMode: context.permissionMode,
    };
    const args = this.adapter.buildArgs(invocation);
    // Last line of defence before argv reaches the OS, matching the guard the
    // upstream spawn path carries — this runtime does not delegate to that
    // path, so it must not skip the check it enforces.
    assertArgsMatchMode(args, context.permissionMode ?? "restricted");

    const channel = new AsyncEventChannel<RunEvent>();
    let seq = 0;
    /**
     * Emit a run event.
     *
     * `fromRedactedText`, when given, is the (already-redacted, via
     * StreamRedactor) text this event's payload was built from. Content
     * reaching `emit()` has therefore already had any secret replaced by the
     * `REDACTED` marker before a JSON parse or field extraction ever saw it —
     * there is nothing left in `payload` to redact a second time. Whether the
     * marker is present in that source text is exactly the true answer to
     * "was this event's content redacted", so that is what gets reported
     * rather than a hardcoded value.
     */
    const emit = (type: RunEventType, payload: Record<string, unknown> = {}, fromRedactedText?: string) => {
      const redacted = fromRedactedText !== undefined && fromRedactedText.includes(REDACTED);
      channel.push({
        eventId: newId("evt"),
        companyId: context.companyId,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        seq: seq++,
        type,
        timestamp: Date.now(),
        correlationId: context.correlationId,
        payload,
        // No per-pattern rule names are recoverable here without duplicating
        // StreamRedactor's cross-chunk carry logic; "stream-redaction" is a
        // deliberately coarse marker. The authoritative, rule-attributed
        // metadata is computed again when RunStore.appendEvent() persists
        // this event — see docs/THREAT_MODEL.md T-04.
        redaction: { redacted, rules: redacted ? ["stream-redaction"] : [] },
      });
    };

    emit("run.started", {
      runtime: this.type,
      model: input.model ?? null,
      permissionMode: context.permissionMode,
      workspace: context.workspacePath,
    });

    if (context.signal?.aborted) {
      emit("run.cancelled", { reason: "cancelled before the process was spawned" });
      channel.close();
      yield* channel;
      return;
    }

    const child = spawn(args[0], args.slice(1), {
      cwd: context.workspacePath,
      env: buildCliSpawnEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const handle: RunHandle = { child, cancelled: false };
    this.running.set(context.runId, handle);

    const onAbort = () => {
      handle.cancelled = true;
      if (child.pid) killProcessTree(child.pid, this.opts.killGraceMs);
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });

    if (this.adapter.promptDelivery === "stdin") {
      child.stdin?.write(input.prompt);
    }
    child.stdin?.end();

    const knownValues = context.redactValues ?? [];
    const stdoutRedactor = new StreamRedactor(knownValues);
    const stderrRedactor = new StreamRedactor(knownValues);

    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOutReason: string | null = null;
    let rateLimitInfo: { matchedText: string; resetAt?: number } | null = null;
    let bytesSeen = 0;
    let outputTruncated = false;
    // Assistant-facing output only (from the adapter's own "output" events).
    // This is what a successful run's message.completed/summary is built
    // from — it must never be polluted by stderr chatter a chatty-but-healthy
    // CLI writes even on success (progress notices, deprecation warnings).
    const stdoutText: string[] = [];
    // Bounded diagnostic tail, used only when the run actually fails, so the
    // CEO/EA sees why rather than just an exit code. Capped so a runaway
    // stderr stream cannot balloon this into an unbounded string.
    const STDERR_TAIL_LIMIT = 4000;
    let stderrTail = "";
    const noteStderr = (text: string) => {
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    };

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      idleTimer = null;
      hardTimer = null;
    };

    const triggerTimeout = (kind: "idle" | "hard") => {
      if (finished) return;
      timedOutReason =
        kind === "idle"
          ? `no output for ${Math.round(this.opts.idleTimeoutMs / 1000)}s`
          : `exceeded maximum runtime ${Math.round(this.opts.hardTimeoutMs / 1000)}s`;
      clearTimers();
      if (child.pid) killProcessTree(child.pid, this.opts.killGraceMs);
    };

    const touchIdle = () => {
      if (finished || this.opts.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), this.opts.idleTimeoutMs);
    };

    touchIdle();
    if (this.opts.hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => triggerTimeout("hard"), this.opts.hardTimeoutMs);
    }

    const mapAdapterEvent = (ev: AdapterStreamEvent, sourceText: string) => {
      switch (ev.type) {
        case "output":
          stdoutText.push(ev.content);
          emit("message.delta", { text: ev.content }, sourceText);
          break;
        case "tool_use":
          emit("tool.requested", { content: ev.content, ...ev.metadata }, sourceText);
          emit("tool.started", { content: ev.content, ...ev.metadata }, sourceText);
          break;
        case "subtask_created":
          emit("subagent.spawned", { title: ev.content, ...ev.metadata }, sourceText);
          break;
        case "subtask_done":
          emit("subagent.completed", { content: ev.content, ...ev.metadata }, sourceText);
          break;
        case "token_usage": {
          const m = ev.metadata ?? {};
          emit(
            "usage.updated",
            {
              inputTokens: Number(m.input_tokens ?? 0),
              outputTokens: Number(m.output_tokens ?? 0),
              cacheReadTokens: Number(m.cache_read_tokens ?? 0),
              cacheWriteTokens: Number(m.cache_write_tokens ?? 0),
              // Subscription CLIs report no per-call price; see capabilities().
              costMicros: 0,
              model: m.model ?? null,
            },
            sourceText,
          );
          break;
        }
        case "error":
          // No wrapped adapter emits this today, but a future one may; treat
          // it as fatal-with-context rather than dropping it silently.
          noteStderr(`\n[error] ${ev.content}`);
          break;
      }
    };

    const handleChunk = (rawText: string, stream: "stdout" | "stderr") => {
      if (!rateLimitInfo) {
        const rl = detectRateLimit(rawText);
        if (rl) rateLimitInfo = rl;
      }
      if (stream === "stdout") {
        for (const ev of this.adapter.parseStreamChunk(rawText)) mapAdapterEvent(ev, rawText);
      } else if (rawText.trim()) {
        // stderr rarely carries genuine structured events, but a CLI may
        // write one there too — still worth a parse attempt. Most adapters'
        // non-JSON fallback treats ANY unparsed line as type "output" (the
        // right assumption on stdout, where unrecognised text is still
        // assistant content). Applied to stderr that assumption is wrong: an
        // unparsed stderr line is overwhelmingly an error or warning, not
        // assistant output, so that fallback is excluded here — only a
        // genuinely structured event (subagent, usage, tool, ...) is honoured;
        // everything else, including the "output" fallback, becomes bounded
        // diagnostic context for a failure message rather than being folded
        // into a successful run's result text.
        const parsed = this.adapter.parseStreamChunk(rawText).filter((ev) => ev.type !== "output");
        if (parsed.length > 0) for (const ev of parsed) mapAdapterEvent(ev, rawText);
        else noteStderr(rawText);
      }
    };

    const onData = (redactor: StreamRedactor, stream: "stdout" | "stderr") => (chunk: Buffer) => {
      touchIdle();
      bytesSeen += chunk.length;
      if (bytesSeen > this.opts.maxOutputBytes) {
        if (!outputTruncated) {
          outputTruncated = true;
          if (child.pid) killProcessTree(child.pid, this.opts.killGraceMs);
        }
        return;
      }
      const text = redactor.push(chunk.toString("utf8"));
      if (text) handleChunk(text, stream);
    };

    child.stdout?.on("data", onData(stdoutRedactor, "stdout"));
    child.stderr?.on("data", onData(stderrRedactor, "stderr"));

    const finish = (type: RunEventType, payload: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimers();
      context.signal?.removeEventListener("abort", onAbort);
      this.running.delete(context.runId);

      const flushedOut = stdoutRedactor.flush();
      if (flushedOut) handleChunk(flushedOut, "stdout");
      const flushedErr = stderrRedactor.flush();
      if (flushedErr) handleChunk(flushedErr, "stderr");

      // A successful run's summary is stdout only. If the CLI genuinely wrote
      // nothing to stdout (unusual, but seen with some misconfigured tools),
      // fall back to the stderr tail rather than leaving the CEO with an
      // empty result — still better than inventing content.
      const resultText = stdoutText.join("") || stderrTail;
      if (resultText) emit("message.completed", { text: resultText }, resultText);

      // The terminal payload's text fields (message/summary/reason) are all
      // built from already-redacted content; stringify it as the source text
      // so this event's redaction flag reflects that truthfully too, rather
      // than defaulting to false because no single string was threaded here.
      emit(type, payload, JSON.stringify(payload));
      channel.close();
    };

    child.on("error", (err) => {
      finish("run.failed", { message: `failed to start ${this.adapter.name}: ${err.message}` });
    });

    child.on("close", (code) => {
      if (finished) return;
      if (handle.cancelled) {
        finish("run.cancelled", { reason: "cancelled" });
      } else if (outputTruncated) {
        finish("run.failed", { message: `output exceeded ${this.opts.maxOutputBytes} bytes; process terminated` });
      } else if (timedOutReason) {
        finish("run.failed", { message: timedOutReason });
      } else if (rateLimitInfo) {
        const rl: { matchedText: string; resetAt?: number } = rateLimitInfo;
        emit(
          "rate_limit.detected",
          { runtime: this.type, resetAt: rl.resetAt ?? null, message: rl.matchedText },
          rl.matchedText,
        );
        finish("run.waiting", { reason: "rate_limited" });
      } else if (code === 0) {
        finish("run.completed", { summary: stdoutText.join("") });
      } else {
        const detail = stderrTail.trim();
        finish("run.failed", {
          message: `${this.adapter.name} exited with code ${code}` + (detail ? ` — ${detail}` : ""),
        });
      }
    });

    yield* channel;
  }
}

/** True when `pid` is still running — exposed for tests that need to assert cleanup. */
export function debugIsRunPidAlive(pid: number): boolean {
  return isPidAlive(pid);
}
