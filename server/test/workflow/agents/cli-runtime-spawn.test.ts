import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliAdapter, HttpAdapter, InvocationContext } from "../../../adapters/adapter-interface.ts";
import { EventEmitter } from "node:events";

// ---- Mocks ----

const { fsMocks, mockSpawn } = vi.hoisted(() => ({
  fsMocks: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    createWriteStream: vi.fn(),
  },
  mockSpawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: fsMocks,
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: () => "/home/test" },
}));

// Import after mocks
import { createCliRuntimeTools } from "../../../modules/workflow/agents/cli-runtime.ts";
import { claudeAdapter } from "../../../adapters/claude.ts";
import { codexAdapter } from "../../../adapters/codex.ts";
import { geminiAdapter } from "../../../adapters/gemini.ts";
import { openclawAdapter } from "../../../adapters/openclaw.ts";
import { opencodeAdapter } from "../../../adapters/opencode.ts";
import { copilotAdapter } from "../../../adapters/copilot.ts";
import { antigravityAdapter } from "../../../adapters/antigravity.ts";

// ---- Helpers ----

interface FakeChildOpts {
  pid?: number;
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { off: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { off: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function makeFakeChild(opts: FakeChildOpts = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = opts.pid ?? 4242;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = new EventEmitter() as FakeChild["stdout"];
  stdout.off = vi.fn((ev: string, fn: any) => stdout.removeListener(ev, fn) as any);
  const stderr = new EventEmitter() as FakeChild["stderr"];
  stderr.off = vi.fn((ev: string, fn: any) => stderr.removeListener(ev, fn) as any);
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

function makeLogStream() {
  return {
    write: vi.fn(),
    end: vi.fn((cb?: () => void) => cb?.()),
    destroyed: false,
    writableEnded: false,
    closed: false,
  };
}

function makeAdapterRegistry(adapters: Record<string, CliAdapter | HttpAdapter>) {
  return {
    get: (provider: string) => {
      const a = adapters[provider];
      if (!a) throw new Error(`No adapter registered for provider: ${provider}`);
      return a;
    },
    list: () => Object.values(adapters),
  } as any;
}

function makeDeps(overrides: Partial<Parameters<typeof createCliRuntimeTools>[0]> = {}) {
  const dbPrepareGet = vi.fn(() => undefined);
  const dbPrepareRun = vi.fn();
  const dbPrepareAll = vi.fn(() => []);
  const db = {
    prepare: vi.fn(() => ({
      get: dbPrepareGet,
      run: dbPrepareRun,
      all: dbPrepareAll,
    })),
  };

  return {
    db: db as any,
    logsDir: "/tmp/logs",
    adapterRegistry: makeAdapterRegistry({}),
    clearCliOutputDedup: vi.fn(),
    normalizeStreamChunk: vi.fn((chunk: Buffer) => chunk.toString()),
    shouldSkipDuplicateCliOutput: vi.fn(() => false),
    broadcast: vi.fn(),
    TASK_RUN_IDLE_TIMEOUT_MS: 0,
    TASK_RUN_HARD_TIMEOUT_MS: 0,
    killPidTree: vi.fn(),
    appendTaskLog: vi.fn(),
    activeProcesses: new Map(),
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "pause" | "cancel">(),
    createSubtaskFromCli: vi.fn(),
    completeSubtaskFromCli: vi.fn(),
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, writable: true, configurable: true });
}

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
function restorePlatform() {
  if (ORIGINAL_PLATFORM) Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
}

// ---- Tests ----

describe("cli-runtime spawnCliAgent — adapter dispatch", () => {
  let child: FakeChild;
  let logStream: ReturnType<typeof makeLogStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    child = makeFakeChild();
    logStream = makeLogStream();
    fsMocks.createWriteStream.mockReturnValue(logStream);
    mockSpawn.mockReturnValue(child);
  });

  afterEach(() => {
    restorePlatform();
  });

  it.each([
    ["claude", claudeAdapter],
    ["codex", codexAdapter],
    ["gemini", geminiAdapter],
    ["opencode", opencodeAdapter],
    ["openclaw", openclawAdapter],
  ] as const)("spawns the %s adapter with its buildArgs output", (key, adapter) => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ [key]: adapter as any }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", key, "Do the thing", "/tmp/project", "/tmp/log.txt", "model-x");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mockSpawn.mock.calls[0];
    expect(typeof cmd).toBe("string");
    expect(Array.isArray(args)).toBe(true);
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect((options.env as Record<string, string>).NO_COLOR).toBe("1");
    expect((options.env as Record<string, string>).CLAUDECODE).toBeUndefined();
    expect((options.env as Record<string, string>).CI).toBe("1");
  });

  it.each([["copilot", copilotAdapter]] as const)("rejects HTTP adapter %s with a clear error", (key, adapter) => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ [key]: adapter as any }) });
    const runtime = createCliRuntimeTools(deps);
    expect(() => runtime.spawnCliAgent("t", key, "p", "/tmp", "/tmp/l.txt")).toThrow(/HTTP adapter/);
  });

  it("spawns the antigravity CLI adapter — it is agy, not an HTTP endpoint", () => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ antigravity: antigravityAdapter }) });
    const runtime = createCliRuntimeTools(deps);
    expect(() => runtime.spawnCliAgent("t", "antigravity", "p", "/tmp", "/tmp/l.txt")).not.toThrow();
    expect(mockSpawn.mock.calls[0][0]).toBe("agy");
  });

  it("throws when provider is unknown", () => {
    const deps = makeDeps();
    const runtime = createCliRuntimeTools(deps);
    expect(() => runtime.spawnCliAgent("t", "nope", "p", "/tmp", "/tmp/l.txt")).toThrow(/No adapter registered/);
  });
});

describe("cli-runtime spawnCliAgent — env, prompt, stdin", () => {
  let child: FakeChild;
  let logStream: ReturnType<typeof makeLogStream>;
  let fakeAdapter: CliAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    child = makeFakeChild();
    logStream = makeLogStream();
    fsMocks.createWriteStream.mockReturnValue(logStream);
    mockSpawn.mockReturnValue(child);
    fakeAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: false,
      buildArgs: (ctx: InvocationContext) => ["fake-cli", "--cwd", ctx.workdir],
      parseStreamChunk: () => [],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
  });

  afterEach(() => restorePlatform());

  it("writes prompt to disk and pipes to stdin for stdin adapters", () => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-stdin", "fake", "Hello, world", "/tmp/project", "/tmp/log.txt");

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith("/tmp/logs/task-stdin.prompt.txt", "Hello, world", "utf8");
    expect(child.stdin.write).toHaveBeenCalledWith("Hello, world");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("does not write prompt to stdin for flag adapters on Linux", () => {
    const flagAdapter: CliAdapter = {
      ...fakeAdapter,
      promptDelivery: "flag",
      promptFlag: "--message",
      // Models OpenClaw, which is the adapter that actually has a session flag.
      sessionFlag: "--session-id",
    };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: flagAdapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-flag", "fake", "P", "/tmp/p", "/tmp/log.txt");

    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--message");
    expect(args).toContain("P");
    expect(args).toContain("--session-id");
    expect(args).toContain("task-flag");
  });

  it("appends fallback dirs to PATH", () => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }) });
    const runtime = createCliRuntimeTools(deps);

    const originalPath = process.env.PATH;
    process.env.PATH = "/some/dir";
    try {
      runtime.spawnCliAgent("t", "fake", "p", "/tmp/p", "/tmp/log.txt");
      const env = mockSpawn.mock.calls[0][2].env as Record<string, string>;
      expect(env.PATH).toContain("/some/dir");
      expect(env.PATH).toContain("/usr/local/bin");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("warns and broadcasts when token freshness is expired", () => {
    const checkTokenFreshness = vi.fn(() => "expired" as const);
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      checkTokenFreshness,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("t", "fake", "p", "/tmp/p", "/tmp/log.txt");

    expect(checkTokenFreshness).toHaveBeenCalledWith("fake");
    expect(deps.appendTaskLog).toHaveBeenCalledWith("t", "warn", expect.stringContaining("token may be expired"));
    expect(deps.broadcast).toHaveBeenCalledWith("cli_auth_warning", { provider: "fake", reason: "token_expired" });
  });
});

describe("cli-runtime spawnCliAgent — process lifecycle", () => {
  let child: FakeChild;
  let logStream: ReturnType<typeof makeLogStream>;
  let fakeAdapter: CliAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    child = makeFakeChild();
    logStream = makeLogStream();
    fsMocks.createWriteStream.mockReturnValue(logStream);
    mockSpawn.mockReturnValue(child);
    fakeAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: true,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: vi.fn(() => []),
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
  });

  afterEach(() => restorePlatform());

  it("kills existing process for the task before spawning a new one", () => {
    const existing = makeFakeChild({ pid: 9999 });
    const activeProcesses = new Map([["task-1", existing as any]]);
    const killPidTree = vi.fn();
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      activeProcesses,
      killPidTree,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");

    expect(killPidTree).toHaveBeenCalledWith(9999);
    expect(activeProcesses.get("task-1")).toBe(child);
  });

  it("registers the child in activeProcesses and removes it on close", () => {
    const activeProcesses = new Map();
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      activeProcesses,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    expect(activeProcesses.get("task-1")).toBe(child);

    child.emit("close", 0);
    expect(activeProcesses.has("task-1")).toBe(false);
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith("/tmp/logs/task-1.prompt.txt");
  });

  it("pipes stdout chunks to log + broadcast", () => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");

    child.stdout.emit("data", Buffer.from("output chunk"));

    expect(logStream.write).toHaveBeenCalledWith("output chunk");
    expect(deps.broadcast).toHaveBeenCalledWith("cli_output", {
      task_id: "task-1",
      stream: "stdout",
      data: "output chunk",
    });
  });

  it("pipes stderr chunks to log + broadcast", () => {
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");

    child.stderr.emit("data", Buffer.from("err chunk"));

    expect(logStream.write).toHaveBeenCalledWith("err chunk");
    expect(deps.broadcast).toHaveBeenCalledWith("cli_output", {
      task_id: "task-1",
      stream: "stderr",
      data: "err chunk",
    });
  });

  it("skips duplicate stdout chunks", () => {
    const shouldSkip = vi.fn(() => true);
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      shouldSkipDuplicateCliOutput: shouldSkip,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    logStream.write.mockClear();

    child.stdout.emit("data", Buffer.from("dupe"));
    expect(logStream.write).not.toHaveBeenCalled();
  });

  it("ignores empty normalized chunks", () => {
    const normalize = vi.fn(() => "");
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      normalizeStreamChunk: normalize,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    logStream.write.mockClear();

    child.stdout.emit("data", Buffer.from("anything"));
    child.stderr.emit("data", Buffer.from("anything"));
    expect(logStream.write).not.toHaveBeenCalled();
  });

  it("logs spawn error and removes from activeProcesses", () => {
    const activeProcesses = new Map();
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
      activeProcesses,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    child.emit("error", new Error("ENOENT"));

    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "error", expect.stringContaining("ENOENT"));
    expect(activeProcesses.has("task-1")).toBe(false);
  });

  it("triggers idle timeout and kills process", () => {
    vi.useFakeTimers();
    try {
      const killPidTree = vi.fn();
      const deps = makeDeps({
        adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
        TASK_RUN_IDLE_TIMEOUT_MS: 1_000,
        killPidTree,
      });
      const runtime = createCliRuntimeTools(deps);

      runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");

      vi.advanceTimersByTime(1_500);
      expect(killPidTree).toHaveBeenCalledWith(child.pid);
      expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "error", expect.stringContaining("RUN TIMEOUT"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("triggers hard timeout and kills process", () => {
    vi.useFakeTimers();
    try {
      const killPidTree = vi.fn();
      const deps = makeDeps({
        adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
        TASK_RUN_HARD_TIMEOUT_MS: 5_000,
        killPidTree,
      });
      const runtime = createCliRuntimeTools(deps);

      runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");

      vi.advanceTimersByTime(6_000);
      expect(killPidTree).toHaveBeenCalledWith(child.pid);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to child.kill when pid is missing on timeout", () => {
    vi.useFakeTimers();
    try {
      child.pid = 0 as any;
      const killPidTree = vi.fn();
      const deps = makeDeps({
        adapterRegistry: makeAdapterRegistry({ fake: fakeAdapter }),
        TASK_RUN_IDLE_TIMEOUT_MS: 500,
        killPidTree,
      });
      const runtime = createCliRuntimeTools(deps);

      runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
      vi.advanceTimersByTime(1_000);
      expect(killPidTree).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs token tracking unsupported when adapter does not support it", () => {
    const noTrackingAdapter: CliAdapter = { ...fakeAdapter, supportsTokenTracking: false };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: noTrackingAdapter }) });
    const runtime = createCliRuntimeTools(deps);
    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "token_tracking_unavailable",
      expect.stringContaining("does not support token tracking"),
    );
  });
});

describe("cli-runtime spawnCliAgent — subtask + token events", () => {
  let child: FakeChild;
  let logStream: ReturnType<typeof makeLogStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    child = makeFakeChild();
    logStream = makeLogStream();
    fsMocks.createWriteStream.mockReturnValue(logStream);
    mockSpawn.mockReturnValue(child);
  });

  afterEach(() => restorePlatform());

  it("creates subtasks from subtask_created events", () => {
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: false,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [{ type: "subtask_created", content: "Sub", metadata: { id: "sub-1" } }],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: adapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    child.stdout.emit("data", Buffer.from("event"));

    expect(deps.createSubtaskFromCli).toHaveBeenCalledWith("task-1", "sub-1", "Sub");
  });

  it("completes subtasks from subtask_done events with id", () => {
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: false,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [{ type: "subtask_done", content: "", metadata: { id: "sub-1" } }],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: adapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    child.stdout.emit("data", Buffer.from("event"));

    expect(deps.completeSubtaskFromCli).toHaveBeenCalledWith("sub-1");
  });

  it("records token usage events", () => {
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: true,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [
        {
          type: "token_usage",
          content: "",
          metadata: { input_tokens: 100, output_tokens: 50, model: "m" },
        },
      ],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const dbRun = vi.fn();
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
        run: dbRun,
        all: vi.fn(() => []),
      })),
    };
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: adapter }),
      db: db as any,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    child.stdout.emit("data", Buffer.from("event"));

    const sqls = (db.prepare.mock.calls as any[]).map((c) => c[0]);
    expect(sqls.some((s: string) => s.includes("INSERT INTO token_usage"))).toBe(true);
  });

  it("appends token usage summary on close when totals > 0", () => {
    let parseCount = 0;
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: true,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => {
        parseCount += 1;
        if (parseCount === 1) {
          return [
            {
              type: "token_usage",
              content: "",
              metadata: { input_tokens: 10, output_tokens: 20 },
            },
          ];
        }
        return [];
      },
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ fake: adapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    child.stdout.emit("data", Buffer.from("evt"));
    child.emit("close", 0);

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "token_usage_summary",
      expect.stringContaining("Tokens:"),
    );
  });

  it("loads cost profile budget from workflow_packs when available", () => {
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: true,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const dbGet = vi
      .fn()
      .mockReturnValueOnce({
        cost_profile_json: JSON.stringify({ max_input_tokens: 1000, max_output_tokens: 500 }),
      })
      .mockReturnValue(undefined);
    const db = {
      prepare: vi.fn(() => ({
        get: dbGet,
        run: vi.fn(),
        all: vi.fn(() => []),
      })),
    };
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: adapter }),
      db: db as any,
    });
    const runtime = createCliRuntimeTools(deps);

    expect(() => runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt")).not.toThrow();
  });

  it("ignores invalid cost_profile_json gracefully", () => {
    const adapter: CliAdapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: true,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const dbGet = vi.fn().mockReturnValue({ cost_profile_json: "{not valid json" });
    const db = {
      prepare: vi.fn(() => ({
        get: dbGet,
        run: vi.fn(),
        all: vi.fn(() => []),
      })),
    };
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: adapter }),
      db: db as any,
    });
    const runtime = createCliRuntimeTools(deps);

    expect(() => runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt")).not.toThrow();
  });

  it("captures codex thread mapping from item.completed spawn_agent line", () => {
    const adapter: CliAdapter = {
      name: "Codex",
      providerType: "codex",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: false,
      buildArgs: () => ["codex"],
      parseStreamChunk: () => [],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
    const deps = makeDeps({ adapterRegistry: makeAdapterRegistry({ codex: adapter }) });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "codex", "p", "/tmp/p", "/tmp/log.txt");

    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "collab_tool_call",
        tool: "spawn_agent",
        id: "item-A",
        receiver_thread_ids: ["thread-X"],
      },
    });
    child.stdout.emit("data", Buffer.from(line));

    expect(runtime.codexThreadToSubtask.get("thread-X")).toBe("item-A");
  });
});

describe("cli-runtime spawnCliAgent — metrics", () => {
  let child: FakeChild;
  let logStream: ReturnType<typeof makeLogStream>;
  let adapter: CliAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    child = makeFakeChild();
    logStream = makeLogStream();
    fsMocks.createWriteStream.mockReturnValue(logStream);
    mockSpawn.mockReturnValue(child);
    adapter = {
      name: "Fake",
      providerType: "fake",
      transport: "cli",
      promptDelivery: "stdin",
      supportsTokenTracking: false,
      buildArgs: () => ["fake-cli"],
      parseStreamChunk: () => [],
      testEnvironment: async () => ({ ok: true, message: "ok" }),
    };
  });

  afterEach(() => restorePlatform());

  it("records spawn + duration + exit metrics", () => {
    const metrics = {
      incCounter: vi.fn(),
      recordHistogram: vi.fn(),
      decCounter: vi.fn(),
      setGauge: vi.fn(),
    };
    const deps = makeDeps({
      adapterRegistry: makeAdapterRegistry({ fake: adapter }),
      metrics: metrics as any,
    });
    const runtime = createCliRuntimeTools(deps);

    runtime.spawnCliAgent("task-1", "fake", "p", "/tmp/p", "/tmp/log.txt");
    expect(metrics.incCounter).toHaveBeenCalledWith("agent.spawn", { provider: "fake" });

    child.emit("close", 0);
    expect(metrics.recordHistogram).toHaveBeenCalledWith("agent.duration_ms", expect.any(Number), { provider: "fake" });
    expect(metrics.incCounter).toHaveBeenCalledWith("agent.exit", { provider: "fake", code: "0" });
  });
});
