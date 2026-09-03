import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliAdapter, InvocationContext } from "../../../adapters/adapter-interface.ts";

// We test the shell-injection protection logic by examining the code path in spawnCliAgent.
// Since spawnCliAgent spawns a real process, we mock the heavy dependencies and focus on
// verifying the argument construction and stdin delivery logic.

// Mock fs, child_process, and os
vi.mock("node:fs", () => ({
  default: {
    writeFileSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn((cb: () => void) => cb?.()),
      destroyed: false,
      writableEnded: false,
      closed: false,
    })),
    unlinkSync: vi.fn(),
  },
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: () => "/home/test" },
}));

// Import after mocks
import { createCliRuntimeTools } from "../../../modules/workflow/agents/cli-runtime.ts";

/** Create a fake CliAdapter for testing */
function makeFlagAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    name: "TestFlagAdapter",
    providerType: "test-flag",
    transport: "cli",
    promptDelivery: "flag",
    promptFlag: "--message",
    supportsTokenTracking: false,
    buildArgs: (_ctx: InvocationContext) => ["test-cli", "agent", "--json"],
    parseStreamChunk: () => [],
    testEnvironment: async () => ({ ok: true, message: "ok" }),
    ...overrides,
  };
}

function makeStdinAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    name: "TestStdinAdapter",
    providerType: "test-stdin",
    transport: "cli",
    promptDelivery: "stdin",
    supportsTokenTracking: false,
    buildArgs: (_ctx: InvocationContext) => ["stdin-cli", "run"],
    parseStreamChunk: () => [],
    testEnvironment: async () => ({ ok: true, message: "ok" }),
    ...overrides,
  };
}

describe("cli-runtime — Windows shell injection protection", () => {
  let stdinWritten: string[];
  let mockChild: any;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  function setPlatform(p: string) {
    Object.defineProperty(process, "platform", { value: p, writable: true, configurable: true });
  }

  function restorePlatform() {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stdinWritten = [];

    mockChild = {
      pid: 12345,
      stdin: {
        write: vi.fn((data: string) => stdinWritten.push(data)),
        end: vi.fn(),
      },
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    restorePlatform();
    vi.restoreAllMocks();
  });

  function createRuntime(adapterMap: Record<string, CliAdapter>) {
    return createCliRuntimeTools({
      db: { prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })) },
      logsDir: "/tmp/logs",
      adapterRegistry: {
        get: (provider: string) => {
          const adapter = adapterMap[provider];
          if (!adapter) throw new Error(`Unknown provider: ${provider}`);
          return adapter;
        },
        list: () => Object.values(adapterMap),
      } as any,
      clearCliOutputDedup: vi.fn(),
      normalizeStreamChunk: vi.fn((chunk: Buffer) => chunk.toString()),
      shouldSkipDuplicateCliOutput: vi.fn(() => false),
      broadcast: vi.fn(),
      TASK_RUN_IDLE_TIMEOUT_MS: 0,
      TASK_RUN_HARD_TIMEOUT_MS: 0,
      killPidTree: vi.fn(),
      appendTaskLog: vi.fn(),
      activeProcesses: new Map(),
      stopRequestedTasks: new Set(),
      stopRequestModeByTask: new Map(),
      createSubtaskFromCli: vi.fn(),
      completeSubtaskFromCli: vi.fn(),
      nowMs: () => Date.now(),
    });
  }

  describe("on Windows (mocked)", () => {
    it("does not pass prompt with shell metacharacters as CLI argument", () => {
      setPlatform("win32");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });
      const dangerousPrompt = 'Fix the "bug" & deploy | notify > output.txt';

      runtime.spawnCliAgent("task-1", "test-flag", dangerousPrompt, "/tmp/project", "/tmp/log.txt");

      // The spawn args should NOT contain the dangerous prompt as a CLI argument
      const spawnArgs = mockSpawn.mock.calls[0];
      const allArgs: string[] = spawnArgs[1]; // second arg to spawn is the args array
      expect(allArgs).not.toContain(dangerousPrompt);
      expect(allArgs).not.toContain("--message");
    });

    it("delivers prompt via stdin instead of flag on Windows", () => {
      setPlatform("win32");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });
      const prompt = 'Prompt with "quotes" & ampersands | pipes';

      runtime.spawnCliAgent("task-2", "test-flag", prompt, "/tmp/project", "/tmp/log.txt");

      // Prompt should be written to stdin
      expect(stdinWritten).toContain(prompt);
    });

    it("still includes --session-id on Windows", () => {
      setPlatform("win32");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });

      runtime.spawnCliAgent("task-3", "test-flag", "hello", "/tmp/project", "/tmp/log.txt");

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain("--session-id");
      expect(spawnArgs).toContain("task-3");
    });
  });

  describe("on non-Windows platforms", () => {
    it("still uses flag delivery normally on Linux", () => {
      setPlatform("linux");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });
      const prompt = "Fix the bug";

      runtime.spawnCliAgent("task-4", "test-flag", prompt, "/tmp/project", "/tmp/log.txt");

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain("--message");
      expect(spawnArgs).toContain(prompt);
    });

    it("still uses flag delivery normally on macOS", () => {
      setPlatform("darwin");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });
      const prompt = "Deploy the app";

      runtime.spawnCliAgent("task-5", "test-flag", prompt, "/tmp/project", "/tmp/log.txt");

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain("--message");
      expect(spawnArgs).toContain(prompt);
    });

    it("does not write to stdin for flag adapters on Linux", () => {
      setPlatform("linux");

      const adapter = makeFlagAdapter();
      const runtime = createRuntime({ "test-flag": adapter });

      runtime.spawnCliAgent("task-6", "test-flag", "hello", "/tmp/project", "/tmp/log.txt");

      // stdin should not receive the prompt (flag delivery used)
      expect(stdinWritten).not.toContain("hello");
    });
  });

  describe("stdin adapters are unaffected", () => {
    it("stdin adapters still deliver via stdin on all platforms", () => {
      setPlatform("linux");

      const adapter = makeStdinAdapter();
      const runtime = createRuntime({ "test-stdin": adapter });
      const prompt = "Do the work";

      runtime.spawnCliAgent("task-7", "test-stdin", prompt, "/tmp/project", "/tmp/log.txt");

      expect(stdinWritten).toContain(prompt);
    });

    it("stdin adapters still deliver via stdin on Windows", () => {
      setPlatform("win32");

      const adapter = makeStdinAdapter();
      const runtime = createRuntime({ "test-stdin": adapter });
      const prompt = 'Prompt with "special" & chars';

      runtime.spawnCliAgent("task-8", "test-stdin", prompt, "/tmp/project", "/tmp/log.txt");

      expect(stdinWritten).toContain(prompt);
    });
  });
});
