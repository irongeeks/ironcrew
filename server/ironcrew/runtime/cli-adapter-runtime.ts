/**
 * IronCrew — CliAdapterRuntime.
 *
 * The bridge between the normalised AgentRuntime contract and IronCrew's
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
 *   - version/help capability probes with bounded subprocesses and a short cache
 *   - explicit, capability-gated session resume (never a silent fresh start)
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

import { StringDecoder } from "node:string_decoder";
import { NativeCliParser } from "./cli-native-events.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { helpHas, inspectCli, probeCommand, type CliProbe, type ProbeCommand } from "./cli-probe.ts";
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
  antigravity: 2,
};

export interface CliAdapterRuntimeOptions {
  /** Native command prefix; intended for an explicitly configured launcher or test fixture. */
  probeCommand?: ProbeCommand;
  probeTimeoutMs?: number;
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

const DEFAULT_OPTIONS: Required<Omit<CliAdapterRuntimeOptions, "probeCommand">> = {
  probeTimeoutMs: 5_000,
  idleTimeoutMs: 10 * 60_000,
  hardTimeoutMs: 30 * 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  killGraceMs: 1200,
};

export class CliAdapterRuntime implements AgentRuntime {
  readonly id: string;
  readonly type: string;

  private readonly adapter: CliAdapter;
  private readonly opts: Required<Omit<CliAdapterRuntimeOptions, "probeCommand">>;
  private readonly probePrefix: ProbeCommand | null;
  private cachedProbe: { at: number; value: Promise<CliProbe> } | null = null;
  private readonly running = new Map<string, RunHandle>();

  constructor(adapter: CliAdapter, options: CliAdapterRuntimeOptions = {}) {
    this.adapter = adapter;
    this.id = adapter.providerType;
    this.type = adapter.providerType;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    const executable = adapter.buildArgs({ prompt: "", workdir: process.cwd(), permissionMode: "restricted" })[0];
    const canonical = (
      { claude: "claude", codex: "codex", gemini: "gemini", antigravity: "agy" } as Record<string, string>
    )[this.type];
    this.probePrefix = options.probeCommand ?? (canonical && executable === canonical ? [executable] : null);
  }

  private async inspect(): Promise<CliProbe | null> {
    if (!this.probePrefix) return null;
    if (!this.cachedProbe || Date.now() - this.cachedProbe.at >= 30_000) {
      this.cachedProbe = { at: Date.now(), value: inspectCli(this.type, this.probePrefix, this.opts.probeTimeoutMs) };
    }
    return this.cachedProbe.value;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const probe = await this.inspect();
    return {
      workspaceRequired: true,
      streaming: probe?.streaming ?? false,
      sessionResume: probe?.resume ?? false,
      usageReporting: this.adapter.supportsTokenTracking || this.type === "codex",
      costReporting: false,
      toolCalls: probe?.streaming ?? false,
      subagents: (probe?.streaming ?? false) && typeof this.adapter.detectSubtask === "function",
      defaultConcurrency: DEFAULT_CONCURRENCY[this.type] ?? 1,
      version: probe?.version,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const probe = await this.inspect();
    if (!probe) {
      const env = await this.adapter.testEnvironment();
      return { healthy: false, installed: env.ok, detail: "CLI-Protokoll nicht geprüft.", checkedAt: Date.now() };
    }
    return {
      healthy: probe.installed && probe.streaming,
      installed: probe.installed,
      detail: !probe.installed
        ? "CLI nicht installiert oder Versionsprüfung fehlgeschlagen."
        : probe.streaming
          ? "Version und Streaming-Protokoll geprüft. Anmeldung wird separat geprüft."
          : "CLI vorhanden, benötigtes Streaming-Protokoll nicht in der lokalen Hilfe bestätigt.",
      checkedAt: Date.now(),
    };
  }

  async authStatus(): Promise<AuthStatus> {
    const probe = await this.inspect();
    const method = this.type === "codex" || this.type === "antigravity" ? "oauth-cli" : "subscription-cli";
    const unknown: AuthStatus = {
      authenticated: false,
      verification: "unverified",
      method,
      detail: "Anmeldung nicht geprüft. Ein erfolgreiches --version bestätigt keinen Login.",
      setupHint: `Anmeldung lokal unter dem Runner-Benutzer mit der offiziellen ${this.adapter.name} prüfen.`,
    };
    if (!probe?.installed || !probe.authArgs || !this.probePrefix) return unknown;
    const result = await probeCommand(this.probePrefix, probe.authArgs, this.opts.probeTimeoutMs);
    let authenticated: boolean | undefined;
    let authMethod: AuthStatus["method"] = method;
    if (this.type === "claude") {
      try {
        const data = JSON.parse(result.text) as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof data.loggedIn === "boolean" && (result.code === 0 || result.code === 1))
          authenticated = data.loggedIn && result.code === 0;
        if (data.authMethod === "api_key" || data.authMethod === "api-key") authMethod = "api-key";
      } catch {
        /* Unknown CLI output is unverified, never a successful login. */
      }
    } else if (this.type === "codex") {
      if (result.code === 0 && /logged in using chatgpt/i.test(result.text)) authenticated = true;
      else if (result.code === 0 && /logged in using an? api key/i.test(result.text)) {
        authenticated = true;
        authMethod = "api-key";
      } else if (result.code === 1 && /not logged in/i.test(result.text)) authenticated = false;
    }
    if (authenticated === undefined) return unknown;
    return {
      authenticated,
      verification: "verified",
      method: authMethod,
      detail: authenticated
        ? "Lokaler CLI-Login bestätigt; keine Online-Quota-Prüfung."
        : "Die offizielle CLI meldet keine aktive Anmeldung.",
      ...(authenticated ? {} : { setupHint: unknown.setupHint }),
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const handle = this.running.get(runId);
    if (!handle) return;
    handle.cancelled = true;
    if (handle.child.pid) killProcessTree(handle.child.pid, this.opts.killGraceMs);
  }

  async *resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
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
    assertArgsMatchMode(args, context.permissionMode ?? "restricted");
    const probe = await this.inspect();
    if (probe && (!probe.installed || !probe.streaming))
      throw new Error("CLI nicht für das benötigte Streaming-Protokoll verfügbar.");
    if (input.sessionRef && (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(input.sessionRef) || !probe?.resume)) {
      throw new Error("Session-Fortsetzung nicht unterstützt oder Session-ID ungültig. Kein neuer Lauf gestartet.");
    }
    if (probe) {
      if (this.type === "claude" && context.permissionMode !== "elevated") {
        // Do not inherit a permissive local setting or a previous session's
        // mode. This explicit flag is required in help, otherwise fail closed.
        args.push("--permission-mode", context.permissionMode === "workspace_write" ? "acceptEdits" : "plan");
      }
      // Optional switches are not guessed from a version number. In particular,
      // a config-specific Codex feature name is never force-enabled globally.
      const enable = args.indexOf("--enable");
      if (enable >= 0 && args[enable + 1] === "multi_agent") args.splice(enable, 2);
      for (const [flag, values] of [
        ["--include-partial-messages", 0],
        ["--max-turns", 1],
      ] as const) {
        const i = args.indexOf(flag);
        if (i >= 0 && !helpHas(probe.help, flag)) args.splice(i, values + 1);
      }
      if (input.maxTurns !== undefined) {
        const i = args.indexOf("--max-turns");
        if (i >= 0) args[i + 1] = String(Math.max(1, Math.floor(input.maxTurns)));
      }
      if (input.sessionRef) {
        if (this.type === "codex") {
          const i = args.indexOf("exec");
          if (i < 0) throw new Error("Codex-Adapter hat keinen exec-Einstiegspunkt.");
          args.splice(i + 1, 0, "resume");
          args.push(input.sessionRef, "-");
        } else args.push(this.type === "antigravity" ? "--conversation" : "--resume", input.sessionRef);
      }
      if (
        this.adapter.promptDelivery === "flag" &&
        (!this.adapter.promptFlag || !helpHas(probe.help, this.adapter.promptFlag))
      ) {
        throw new Error("Installierte CLI bestätigt das benötigte Prompt-Flag nicht.");
      }
      const help = `${probe.help}\n${probe.execHelp}\n${input.sessionRef ? probe.resumeHelp : ""}`;
      for (const arg of args.slice(1)) {
        if (/^-{1,2}[a-zA-Z]/.test(arg) && !helpHas(help, arg.split("=")[0])) {
          throw new Error(
            `Installierte CLI bestätigt das erforderliche Flag ${arg.split("=")[0]} nicht. Lauf verweigert.`,
          );
        }
      }
    }
    // Last line of defence before argv reaches the OS, matching the guard the
    // upstream spawn path carries — this runtime does not delegate to that
    // path, so it must not skip the check it enforces.
    assertArgsMatchMode(args, context.permissionMode ?? "restricted");

    // The prompt, for adapters that take it as a flag rather than on stdin
    // (agy, openclaw). Until this existed they were spawned with no prompt at
    // all and produced an empty run.
    //
    // Appended *after* the guard above on purpose: the prompt is data, and a
    // prompt that merely mentions "--yolo" must not be mistaken for an argv
    // token that asks for it. Nothing is shell-interpolated here — spawn gets
    // an argv array — so the prompt cannot break out of its own slot.
    if (this.adapter.promptDelivery === "flag") {
      if (!this.adapter.promptFlag) {
        throw new Error(
          `Adapter "${this.adapter.providerType}" delivers its prompt by flag but names no flag; refusing to start a run without a prompt.`,
        );
      }
      args.push(this.adapter.promptFlag, input.prompt);
    }

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
      ...(input.sessionRef ? { sessionRef: input.sessionRef, resumed: true } : {}),
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
    let structuredFailure: string | null = null;
    const nativeParser = new NativeCliParser(this.type);
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
          // A structured failure is fatal even when the CLI exits with zero.
          structuredFailure = ev.content || "CLI meldet einen fehlgeschlagenen Lauf.";
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
        const native = nativeParser.parse(rawText);
        if (native) {
          for (const event of native) {
            if (event.type === "message.delta") stdoutText.push(String(event.payload.text ?? ""));
            if (event.type === "run.failed")
              structuredFailure = String(event.payload.message ?? "CLI-Lauf fehlgeschlagen.");
            else emit(event.type, event.payload, rawText);
          }
          return;
        }
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

    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" };
    const handleLines = (text: string, stream: "stdout" | "stderr", final = false) => {
      pending[stream] += text;
      let newline: number;
      while ((newline = pending[stream].indexOf("\n")) >= 0) {
        const line = pending[stream].slice(0, newline + 1);
        pending[stream] = pending[stream].slice(newline + 1);
        handleChunk(line, stream);
      }
      if (final && pending[stream]) {
        handleChunk(pending[stream], stream);
        pending[stream] = "";
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
      const text = redactor.push(decoders[stream].write(chunk));
      if (text) handleLines(text, stream);
    };

    child.stdout?.on("data", onData(stdoutRedactor, "stdout"));
    child.stderr?.on("data", onData(stderrRedactor, "stderr"));

    const flushStreams = () => {
      handleLines(stdoutRedactor.push(decoders.stdout.end()) + stdoutRedactor.flush(), "stdout", true);
      handleLines(stderrRedactor.push(decoders.stderr.end()) + stderrRedactor.flush(), "stderr", true);
    };
    const finish = (type: RunEventType, payload: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimers();
      context.signal?.removeEventListener("abort", onAbort);
      this.running.delete(context.runId);

      flushStreams();
      const sessionRef = nativeParser.sessionRef ?? input.sessionRef;
      if (sessionRef) payload.sessionRef = sessionRef;

      // A successful run's summary is stdout only. If the CLI genuinely wrote
      // nothing to stdout (unusual, but seen with some misconfigured tools),
      // fall back to the stderr tail rather than leaving the CEO with an
      // empty result — still better than inventing content.
      const resultText = stdoutText.join("") || stderrTail;
      if (resultText)
        emit("message.completed", { text: resultText, ...(sessionRef ? { sessionRef } : {}) }, resultText);

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
      // Flush complete NDJSON frames before selecting the terminal outcome.
      flushStreams();
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
      } else if (structuredFailure) {
        finish("run.failed", { message: structuredFailure });
      } else if (code === 0) {
        finish("run.completed", { summary: stdoutText.join("") });
      } else {
        const detail = stderrTail.trim();
        finish("run.failed", {
          message: `${this.adapter.name} exited with code ${code}` + (detail ? ` — ${detail}` : ""),
        });
      }
    });

    try {
      yield* channel;
    } finally {
      if (!finished) onAbort();
    }
  }
}

/** True when `pid` is still running — exposed for tests that need to assert cleanup. */
export function debugIsRunPidAlive(pid: number): boolean {
  return isPidAlive(pid);
}
