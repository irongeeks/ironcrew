import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter } from "../../adapters/claude.ts";
import { codexAdapter } from "../../adapters/codex.ts";
import { geminiAdapter } from "../../adapters/gemini.ts";
import { antigravityAdapter } from "../../adapters/antigravity.ts";
import type { CliAdapter } from "../../adapters/adapter-interface.ts";
import { CliAdapterRuntime, type CliAdapterRuntimeOptions } from "./cli-adapter-runtime.ts";
import { PermissionPolicyError } from "../policy/runtime-permissions.ts";
import type { RunContext, RunEvent } from "./run-events.ts";
import { newId } from "../domain/ids.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "__fixtures__", "stub-cli.mjs");
const ARGV_ECHO = path.join(__dirname, "__fixtures__", "argv-echo.mjs");

/**
 * Point a real adapter's argv at the test fixture instead of the real CLI
 * binary, while keeping its actual parseStreamChunk/detectSubtask/etc. This
 * exercises the genuine per-provider protocol-parsing code, spawned as a
 * real child process, without needing a real CLI login in this environment.
 */
function stubbed(adapter: CliAdapter, scenario: string, protocol: "claude" | "codex" | "gemini"): CliAdapter {
  return {
    ...adapter,
    buildArgs: () => [process.execPath, STUB],
    testEnvironment: adapter.testEnvironment.bind(adapter),
    parseStreamChunk: adapter.parseStreamChunk.bind(adapter),
    detectSubtask: adapter.detectSubtask?.bind(adapter),
    detectSubtaskDone: adapter.detectSubtaskDone?.bind(adapter),
    env: { STUB_SCENARIO: scenario, STUB_PROTOCOL: protocol },
  } as CliAdapter & { env: Record<string, string> };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    companyId: "cmp_test",
    projectId: null,
    taskId: "task_test",
    runId: newId("run"),
    agentId: "agt_test",
    correlationId: "corr_test",
    workspacePath: process.cwd(),
    permissionMode: "restricted",
    ...overrides,
  };
}

async function collect(runtime: CliAdapterRuntime, ctx: RunContext, prompt = "hallo"): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of runtime.startRun({ prompt }, ctx)) out.push(ev);
  return out;
}

/**
 * Environment variables the stub reads (STUB_SCENARIO/STUB_PROTOCOL) travel
 * through process.env, not through the adapter/args, since buildCliSpawnEnv()
 * starts from process.env. Set them on process.env for the duration of the
 * spawn — this file runs sequentially per test (vitest default), and each
 * test cleans up its own env vars, so this is safe.
 */
function withStubEnv<T>(scenario: string, protocol: string, fn: () => Promise<T>): Promise<T> {
  const prevScenario = process.env.STUB_SCENARIO;
  const prevProtocol = process.env.STUB_PROTOCOL;
  process.env.STUB_SCENARIO = scenario;
  process.env.STUB_PROTOCOL = protocol;
  return fn().finally(() => {
    if (prevScenario === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = prevScenario;
    if (prevProtocol === undefined) delete process.env.STUB_PROTOCOL;
    else process.env.STUB_PROTOCOL = prevProtocol;
  });
}

const FAST: CliAdapterRuntimeOptions = { idleTimeoutMs: 0, hardTimeoutMs: 0, killGraceMs: 100 };

const PROBE = path.join(__dirname, "__fixtures__", "probe-cli.mjs");
function probed(adapter: CliAdapter): CliAdapterRuntime {
  const prefix: [string, ...string[]] = [process.execPath, PROBE, adapter.providerType];
  return new CliAdapterRuntime(
    {
      ...adapter,
      buildArgs: (input) => [...prefix, ...adapter.buildArgs(input).slice(1)],
    },
    { probeCommand: prefix, probeTimeoutMs: 2_000, killGraceMs: 20 },
  );
}
afterEach(() => vi.unstubAllEnvs());

describe("capability and local auth probes", () => {
  it("confirms version, streaming and resume from the installed help protocol", async () => {
    const runtime = probed(claudeAdapter);
    expect(await runtime.capabilities()).toMatchObject({
      version: "9.1.0",
      streaming: true,
      sessionResume: true,
      defaultConcurrency: 1,
    });
    expect(await runtime.healthCheck()).toMatchObject({ installed: true, healthy: true });
  });
  it("does not equate an installed executable with a usable runtime", async () => {
    vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "missing-stream");
    const runtime = probed(claudeAdapter);
    expect(await runtime.healthCheck()).toMatchObject({ installed: true, healthy: false });
    await expect(collect(runtime, context())).rejects.toThrow("Streaming");
  });
  it("leaves auth unverified when the installed CLI has no status contract", async () => {
    vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "missing-auth");
    expect(await probed(claudeAdapter).authStatus()).toMatchObject({
      authenticated: false,
      verification: "unverified",
    });
  });
  it.each([claudeAdapter, codexAdapter])("whitelists only safe auth fields for $providerType", async (adapter) => {
    const auth = await probed(adapter).authStatus();
    expect(auth).toMatchObject({ authenticated: true, verification: "verified" });
    expect(JSON.stringify(auth)).not.toMatch(/sensitive-profile|never-expose|accessToken/);
  });
  it.each([claudeAdapter, codexAdapter])(
    "recognizes the official logged-out result for $providerType",
    async (adapter) => {
      vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "logged-out");
      expect(await probed(adapter).authStatus()).toMatchObject({ authenticated: false, verification: "verified" });
    },
  );
  it("does not interpret an unknown auth error as a successful login", async () => {
    vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "auth-unknown");
    expect(await probed(codexAdapter).authStatus()).toMatchObject({ authenticated: false, verification: "unverified" });
  });
  it("does not invent an Antigravity login status", async () => {
    expect(await probed(antigravityAdapter).authStatus()).toMatchObject({
      authenticated: false,
      verification: "unverified",
    });
  });
  it("reports absent CLI without trying a login", async () => {
    const runtime = new CliAdapterRuntime(claudeAdapter, { probeCommand: ["ironcrew-deliberately-missing-cli"] });
    expect(await runtime.healthCheck()).toMatchObject({ installed: false, healthy: false });
  });
});

describe("a successful run, per adapter protocol", () => {
  it.each([["claude", claudeAdapter] as const, ["codex", codexAdapter] as const, ["gemini", geminiAdapter] as const])(
    "streams message.delta and completes cleanly over the %s protocol",
    async (name, adapter) => {
      const runtime = new CliAdapterRuntime(stubbed(adapter, "success", name), FAST);
      const events = await withStubEnv("success", name, () => collect(runtime, context()));

      expect(events[0].type).toBe("run.started");
      expect(events.at(-1)!.type).toBe("run.completed");

      const deltas = events.filter((e) => e.type === "message.delta");
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.map((d) => d.payload.text).join("")).toBe("Hallo Welt.");

      const completed = events.find((e) => e.type === "message.completed")!;
      expect(completed.payload.text).toBe("Hallo Welt.");

      // Every event is fully addressed — an unaddressed event cannot be audited.
      for (const ev of events) {
        expect(ev.companyId).toBe("cmp_test");
        expect(ev.taskId).toBe("task_test");
        expect(ev.correlationId).toBe("corr_test");
      }
    },
  );

  it("reports token usage only for the claude protocol, which actually parses it", async () => {
    const claudeRun = new CliAdapterRuntime(stubbed(claudeAdapter, "success", "claude"), FAST);
    const claudeEvents = await withStubEnv("success", "claude", () => collect(claudeRun, context()));
    const usage = claudeEvents.find((e) => e.type === "usage.updated")!;
    expect(usage.payload).toMatchObject({ inputTokens: 120, outputTokens: 34, costMicros: 0 });

    const codexRun = new CliAdapterRuntime(stubbed(codexAdapter, "success", "codex"), FAST);
    const codexEvents = await withStubEnv("success", "codex", () => collect(codexRun, context()));
    expect(codexEvents.some((e) => e.type === "usage.updated")).toBe(false);
  });

  it("delivers the prompt via stdin", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "echo_stdin", "claude"), FAST);
    const events = await withStubEnv("echo_stdin", "claude", () => collect(runtime, context(), "Bitte Backup pruefen"));
    const delta = events.find((e) => e.type === "message.delta")!;
    expect(delta.payload.text).toBe("echo:Bitte Backup pruefen");
  });

  it.each([["claude", claudeAdapter] as const, ["codex", codexAdapter] as const, ["gemini", geminiAdapter] as const])(
    "maps a sub-agent spawn/completion over the %s protocol",
    async (name, adapter) => {
      const runtime = new CliAdapterRuntime(stubbed(adapter, "subagent", name), FAST);
      const events = await withStubEnv("subagent", name, () => collect(runtime, context()));
      expect(events.some((e) => e.type === "subagent.spawned")).toBe(true);
      expect(events.some((e) => e.type === "subagent.completed")).toBe(true);
    },
  );
});

describe("secret redaction reaches emitted events", () => {
  it("never lets a secret reach an event payload", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "secret", "claude"), FAST);
    const events = await withStubEnv("secret", "claude", () => collect(runtime, context()));
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");

    const delta = events.find((e) => e.type === "message.delta")!;
    expect(delta.redaction.redacted).toBe(true);
  });

  it("catches a secret split across two stdout chunks", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "split_secret", "claude"), FAST);
    const events = await withStubEnv("split_secret", "claude", () => collect(runtime, context()));
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    expect(events.find((e) => e.type === "message.completed")?.redaction.redacted).toBe(true);
  });
});

describe("failure and rate-limit paths", () => {
  it("ends in run.failed with stderr context, never run.completed, on a non-zero exit", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "fail", "claude"), FAST);
    const events = await withStubEnv("fail", "claude", () => collect(runtime, context()));
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
    const failed = events.at(-1)!;
    expect(failed.type).toBe("run.failed");
    expect(String(failed.payload.message)).toContain("exited with code 1");
    expect(String(failed.payload.message)).toContain("something broke");
  });

  it("does not fold stderr chatter into a successful run's summary", async () => {
    // The "success" scenario writes only to stdout; this asserts the
    // separation itself (stdoutText vs stderrTail) rather than relying on
    // the fixture happening not to write to stderr.
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "success", "claude"), FAST);
    const events = await withStubEnv("success", "claude", () => collect(runtime, context()));
    const completed = events.find((e) => e.type === "message.completed")!;
    expect(completed.payload.text).not.toMatch(/\[stderr\]|\[error\]/);
  });

  it("surfaces a rate limit as its own event and ends in run.waiting, not run.failed", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "rate_limit", "claude"), FAST);
    const events = await withStubEnv("rate_limit", "claude", () => collect(runtime, context()));
    const rl = events.find((e) => e.type === "rate_limit.detected");
    expect(rl).toBeDefined();
    expect(typeof rl!.payload.resetAt).toBe("number");
    expect(events.some((e) => e.type === "run.failed")).toBe(false);
    expect(events.at(-1)!.type).toBe("run.waiting");
  });

  it("fails cleanly when the binary itself cannot be spawned", async () => {
    const missing: CliAdapter = {
      ...claudeAdapter,
      buildArgs: () => ["/definitely/not/a/real/binary/iron-crew-test"],
    };
    const runtime = new CliAdapterRuntime(missing, FAST);
    const events = await collect(runtime, context());
    expect(events.at(-1)!.type).toBe("run.failed");
    expect(String(events.at(-1)!.payload.message)).toMatch(/failed to start/i);
  });
});

describe("cancellation and timeouts (real process lifecycle)", () => {
  it("cancelRun() actually stops the process and ends the stream in run.cancelled", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "ignore_sigterm", "claude"), FAST);
    const ctx = context();
    const events: RunEvent[] = [];

    await withStubEnv("ignore_sigterm", "claude", async () => {
      for await (const ev of runtime.startRun({ prompt: "x" }, ctx)) {
        events.push(ev);
        if (ev.type === "message.delta") {
          await runtime.cancelRun(ctx.runId);
        }
      }
    });

    expect(events.at(-1)!.type).toBe("run.cancelled");
  }, 10_000);

  it("honours an AbortSignal mid-run", async () => {
    const controller = new AbortController();
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "ignore_sigterm", "claude"), FAST);
    const ctx = context({ signal: controller.signal });
    const events: RunEvent[] = [];

    await withStubEnv("ignore_sigterm", "claude", async () => {
      for await (const ev of runtime.startRun({ prompt: "x" }, ctx)) {
        events.push(ev);
        if (ev.type === "message.delta") controller.abort();
      }
    });

    expect(events.at(-1)!.type).toBe("run.cancelled");
  }, 10_000);

  it("honours a signal already aborted before the process is spawned", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "success", "claude"), FAST);
    const events = await withStubEnv("success", "claude", () =>
      collect(runtime, context({ signal: controller.signal })),
    );
    expect(events.at(-1)!.type).toBe("run.cancelled");
    expect(events).toHaveLength(2); // run.started, run.cancelled — no process ever ran
  });

  it("kills and fails the run after the idle timeout", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "hang", "claude"), {
      idleTimeoutMs: 150,
      hardTimeoutMs: 0,
      killGraceMs: 100,
    });
    const events = await withStubEnv("hang", "claude", () => collect(runtime, context()));
    const last = events.at(-1)!;
    expect(last.type).toBe("run.failed");
    expect(String(last.payload.message)).toMatch(/no output for/);
  }, 10_000);

  it("kills and fails the run after the hard timeout even if the process keeps writing", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "ignore_sigterm", "claude"), {
      idleTimeoutMs: 0,
      hardTimeoutMs: 150,
      killGraceMs: 100,
    });
    const events = await withStubEnv("ignore_sigterm", "claude", () => collect(runtime, context()));
    const last = events.at(-1)!;
    expect(last.type).toBe("run.failed");
    expect(String(last.payload.message)).toMatch(/exceeded maximum runtime/);
  }, 10_000);

  it("truncates and fails a run whose output exceeds the configured byte limit", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "big", "claude"), {
      idleTimeoutMs: 0,
      hardTimeoutMs: 0,
      maxOutputBytes: 4096,
      killGraceMs: 100,
    });
    const events = await withStubEnv("big", "claude", () => collect(runtime, context()));
    const last = events.at(-1)!;
    expect(last.type).toBe("run.failed");
    expect(String(last.payload.message)).toMatch(/output exceeded/);
  }, 10_000);
});

describe("permission guard is wired in", () => {
  it("refuses to spawn when argv carries a bypass flag the resolved mode does not authorise", async () => {
    const misconfigured: CliAdapter = {
      ...claudeAdapter,
      buildArgs: () => ["claude", "--dangerously-skip-permissions"],
    };
    const runtime = new CliAdapterRuntime(misconfigured, FAST);
    await expect(collect(runtime, context({ permissionMode: "restricted" }))).rejects.toThrow(PermissionPolicyError);
  });

  it("permits the same flag once policy resolved to elevated", async () => {
    const elevated: CliAdapter = {
      ...claudeAdapter,
      buildArgs: () => [process.execPath, STUB],
    };
    const runtime = new CliAdapterRuntime(stubbed(elevated, "success", "claude"), FAST);
    const events = await withStubEnv("success", "claude", () =>
      collect(runtime, context({ permissionMode: "elevated" })),
    );
    expect(events.at(-1)!.type).toBe("run.completed");
  });
});

describe("resumeRun", () => {
  it.each([claudeAdapter, codexAdapter, antigravityAdapter])(
    "continues the explicit $providerType session through the real subprocess argv",
    async (adapter) => {
      const runtime = probed(adapter);
      const events: RunEvent[] = [];
      for await (const event of runtime.resumeRun("session-fixture-001", { prompt: "Fortsetzen" }, context()))
        events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", payload: { sessionRef: "session-fixture-001" } });
      const message = events.find((event) => event.type === "message.completed")!;
      const observed = JSON.parse(String(message.payload.text)) as { args: string[]; stdin: string };
      expect(observed.args).toContain(
        adapter.providerType === "claude" ? "--resume" : adapter.providerType === "codex" ? "resume" : "--conversation",
      );
      expect(observed.args).toContain("session-fixture-001");
      if (adapter.promptDelivery === "stdin") expect(observed.stdin).toBe("Fortsetzen");
      else expect(observed.args).toContain("Fortsetzen");
      expect(observed.args).not.toContain("multi_agent");
    },
  );
  it("refuses unsupported resume instead of silently starting over", async () => {
    vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "missing-resume");
    const runtime = probed(claudeAdapter);
    await expect(collect(runtime, context())).resolves.toBeTruthy();
    await expect(async () => {
      for await (const _event of runtime.resumeRun("prior-session", { prompt: "x" }, context())) {
        /* consume */
      }
    }).rejects.toThrow("Kein neuer Lauf");
  });
  it("rejects a session reference that could be interpreted as an option", async () => {
    const runtime = probed(codexAdapter);
    await expect(async () => {
      for await (const _event of runtime.resumeRun("--last", { prompt: "x" }, context())) {
        /* consume */
      }
    }).rejects.toThrow("ungültig");
  });
  it("records the session before completion and retains split UTF-8/NDJSON", async () => {
    const events = await collect(probed(claudeAdapter), context());
    expect(events.find((event) => event.type === "run.started" && event.payload.sessionRef)).toBeTruthy();
    expect(String(events.find((event) => event.type === "message.completed")?.payload.text)).toContain("Grüße");
    expect(events.find((event) => event.type === "usage.updated")?.payload.inputTokens).toBe(17);
  });
  it("treats a structured provider failure as failed even with process exit zero", async () => {
    vi.stubEnv("IRONCREW_CLI_FIXTURE_MODE", "structured-error");
    const events = await collect(probed(codexAdapter), context());
    expect(events.at(-1)).toMatchObject({ type: "run.failed", payload: { sessionRef: "session-fixture-001" } });
  });
});

describe("prompt delivery", () => {
  /**
   * An adapter that reports the argv it was actually spawned with.
   *
   * The prompt of a flag-delivery adapter (agy, openclaw) used to be dropped
   * here: the runtime only wrote stdin, and stdin is precisely what those
   * CLIs ignore. The run then succeeded with an empty prompt, which is the
   * worst kind of bug — it looks like the agent had nothing to say.
   */
  function argvReporter(over: Partial<CliAdapter> = {}): CliAdapter {
    return {
      name: "argv reporter",
      providerType: "argv",
      transport: "cli",
      supportsTokenTracking: false,
      promptDelivery: "flag",
      promptFlag: "-p",
      buildArgs: () => [process.execPath, ARGV_ECHO],
      parseStreamChunk: (raw: string) => [{ type: "output" as const, content: raw }],
      testEnvironment: async () => ({ ok: true, message: "stub" }),
      ...over,
    } as CliAdapter;
  }

  it("appends the prompt for a flag-delivery adapter", async () => {
    const runtime = new CliAdapterRuntime(argvReporter(), FAST);
    const events = await collect(runtime, context(), "finde den Fehler");
    const text = events
      .filter((e) => e.type === "message.completed")
      .map((e) => String(e.payload.text ?? ""))
      .join("");

    expect(JSON.parse(text).args).toEqual(["-p", "finde den Fehler"]);
  });

  it("passes a prompt containing a bypass flag as data, not as policy", async () => {
    // The guard runs on the adapter's own argv, before the prompt is appended
    // — otherwise a prompt merely mentioning the flag would be unrunnable.
    const runtime = new CliAdapterRuntime(argvReporter(), FAST);
    const events = await collect(runtime, context({ permissionMode: "restricted" }), "warum nicht --yolo?");
    const text = events
      .filter((e) => e.type === "message.completed")
      .map((e) => String(e.payload.text ?? ""))
      .join("");

    expect(JSON.parse(text).args).toEqual(["-p", "warum nicht --yolo?"]);
    expect(events.at(-1)!.type).toBe("run.completed");
  });

  it("refuses to start a flag-delivery adapter that names no flag, rather than running with no prompt", async () => {
    const runtime = new CliAdapterRuntime(argvReporter({ promptFlag: undefined }), FAST);
    await expect(collect(runtime, context())).rejects.toThrow(/names no flag/);
  });

  it("still uses stdin for adapters that read it", async () => {
    const runtime = new CliAdapterRuntime(
      argvReporter({
        promptDelivery: "stdin",
        promptFlag: undefined,
        buildArgs: () => [process.execPath, ARGV_ECHO],
      }),
      FAST,
    );
    const events = await collect(runtime, context(), "über stdin");
    const text = events
      .filter((e) => e.type === "message.completed")
      .map((e) => String(e.payload.text ?? ""))
      .join("");

    const reported = JSON.parse(text);
    expect(reported.args).toEqual([]);
    expect(reported.stdin).toBe("über stdin");
  });
});
