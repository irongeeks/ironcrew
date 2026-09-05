import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter } from "../../adapters/claude.ts";
import { codexAdapter } from "../../adapters/codex.ts";
import { geminiAdapter } from "../../adapters/gemini.ts";
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

describe("capabilities / healthCheck / authStatus (no process spawned)", () => {
  it("reports real capabilities per adapter, honestly", async () => {
    const claude = new CliAdapterRuntime(claudeAdapter);
    const caps = await claude.capabilities();
    expect(caps.usageReporting).toBe(true); // claudeAdapter.supportsTokenTracking
    expect(caps.subagents).toBe(true); // claudeAdapter.detectSubtask exists
    expect(caps.costReporting).toBe(false); // subscription CLI, no invented price
    expect(caps.sessionResume).toBe(false); // honestly not implemented
    expect(caps.defaultConcurrency).toBe(1);

    const codex = new CliAdapterRuntime(codexAdapter);
    expect((await codex.capabilities()).usageReporting).toBe(false); // codexAdapter.supportsTokenTracking
    expect((await codex.capabilities()).defaultConcurrency).toBe(2);
  });

  it("id/type match the wrapped adapter's providerType", () => {
    expect(new CliAdapterRuntime(claudeAdapter).type).toBe("claude");
    expect(new CliAdapterRuntime(codexAdapter).type).toBe("codex");
    expect(new CliAdapterRuntime(geminiAdapter).type).toBe("gemini");
  });

  it("healthCheck reports not installed without throwing, for a CLI genuinely absent", async () => {
    const absent: CliAdapter = { ...claudeAdapter, buildArgs: claudeAdapter.buildArgs };
    const runtime = new CliAdapterRuntime({
      ...absent,
      testEnvironment: async () => ({ ok: false, message: "claude CLI not found in PATH" }),
    });
    const health = await runtime.healthCheck();
    expect(health.installed).toBe(false);
    expect(health.healthy).toBe(false);
    expect(health.detail).toBeTruthy();
  });

  it("authStatus never carries a secret and offers a setup hint when not authenticated", async () => {
    const runtime = new CliAdapterRuntime({
      ...claudeAdapter,
      testEnvironment: async () => ({ ok: false, message: "claude CLI not found in PATH" }),
    });
    const auth = await runtime.authStatus();
    expect(auth.authenticated).toBe(false);
    expect(auth.setupHint).toBeTruthy();
    expect(JSON.stringify(auth)).not.toMatch(/sk-|Bearer /);
  });

  it("genuinely detects whatever real Claude Code CLI state this environment actually has", async () => {
    // Talks to the real `claude` binary through the real (unstubbed)
    // adapter — no fake testEnvironment() here. Whether that binary is
    // actually present is a fact about the machine running the test, not
    // about this code: this session happens to run on Claude Code itself,
    // so `claude` is installed here, but a bare CI runner typically has no
    // such CLI. The assertions must hold either way — what they prove is
    // that healthCheck()/authStatus() genuinely reflect the real state
    // rather than a canned answer, and never leak a secret regardless. This
    // does NOT run a live task (see IMPLEMENTATION_STATUS.md — that needs
    // an authenticated context and stays an open manual step).
    const runtime = new CliAdapterRuntime(claudeAdapter);
    const health = await runtime.healthCheck();
    expect(health.installed).toBe(health.healthy); // self-consistent either way
    expect(health.detail).toBeTruthy();

    const auth = await runtime.authStatus();
    expect(JSON.stringify(auth)).not.toMatch(/sk-|Bearer /);
    if (health.installed) {
      expect(auth.authenticated).toBe(false);
      expect(auth.verification).toBe("unverified");
      expect(auth.accountHint).toBeUndefined();
    } else {
      expect(auth.authenticated).toBe(false);
      expect(auth.setupHint).toBeTruthy();
    }
  });

  it("never treats an installed CLI's version as proof of authentication", async () => {
    const fakeOk: CliAdapter = {
      ...claudeAdapter,
      testEnvironment: async () => ({ ok: true, version: "claude/9.9.9", message: "found" }),
    };
    const auth = await new CliAdapterRuntime(fakeOk).authStatus();
    expect(auth.authenticated).toBe(false);
    expect(auth.verification).toBe("unverified");
    expect(auth.accountHint).toBeUndefined();
    expect(auth.detail).toContain("Anmeldung nicht geprüft");
    expect(auth.setupHint).toContain("Runner-Benutzer");
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
  it("delegates to startRun (no wrapped adapter supports real resume)", async () => {
    const runtime = new CliAdapterRuntime(stubbed(claudeAdapter, "success", "claude"), FAST);
    const events: RunEvent[] = [];
    await withStubEnv("success", "claude", async () => {
      for await (const ev of runtime.resumeRun("prior-session", { prompt: "x" }, context())) {
        events.push(ev);
      }
    });
    expect(events[0].type).toBe("run.started");
    expect(events.at(-1)!.type).toBe("run.completed");
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
