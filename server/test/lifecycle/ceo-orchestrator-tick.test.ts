import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Express } from "express";

// ---------------------------------------------------------------------------
// Hoisted mocks
//
// The ceo-orchestrator module creates a child logger at import time, and pulls
// callLlm / getFirstEnabledProvider / resolveModel from the llm-call module.
// We mock both before importing the system under test so we can script LLM
// responses, drive the provider selection, and avoid any real I/O.
// ---------------------------------------------------------------------------

const { mockWarn, mockError, mockInfo, mockCallLlm, mockGetProvider, mockResolveModel } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockCallLlm: vi.fn(),
  mockGetProvider: vi.fn(),
  mockResolveModel: vi.fn(),
}));

vi.mock("../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      info: mockInfo,
      warn: mockWarn,
      error: mockError,
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  },
}));

vi.mock("../../modules/workflow/orchestration/llm-call.ts", () => ({
  callLlm: mockCallLlm,
  getFirstEnabledProvider: mockGetProvider,
  resolveModel: mockResolveModel,
}));

// Import under test AFTER mocks are registered.
import { createCeoOrchestrator } from "../../modules/lifecycle/ceo-orchestrator.ts";

// ---------------------------------------------------------------------------
// In-memory fake DB
//
// The orchestrator only uses `db.prepare(sql).get(...)` and `.all(...)`. We map
// known SQL fragments to scripted result rows. Any unknown SQL throws so the
// test fails loudly rather than silently returning empty data.
// ---------------------------------------------------------------------------

type StoreState = {
  ceoEnabled: string;
  ceoModel: string;
  companyName: string | undefined;
  messages: Array<{ content: string; message_type: string; created_at: number }>;
  queueStats: Array<{ status: string; cnt: number }>;
  reviewTasks: Array<{ id: string; title: string; assigned_agent_id: string | null }>;
  agentStats: Array<{ status: string; cnt: number }>;
  departments: Array<{ id: string; name: string }>;
};

function defaultState(): StoreState {
  return {
    ceoEnabled: "true",
    ceoModel: "",
    companyName: "TestCo",
    messages: [{ content: "hi from a user", message_type: "chat", created_at: 1 }],
    queueStats: [
      { status: "in_progress", cnt: 2 },
      { status: "review", cnt: 1 },
    ],
    reviewTasks: [{ id: "11111111-2222-3333-4444-555555555555", title: "Fix login", assigned_agent_id: null }],
    agentStats: [{ status: "idle", cnt: 3 }],
    departments: [
      { id: "dev", name: "Development" },
      { id: "qa", name: "QA" },
    ],
  };
}

function makeFakeDb(state: StoreState) {
  return {
    prepare(sql: string) {
      const trimmed = sql.replace(/\s+/g, " ").trim();
      return {
        get: (..._args: unknown[]) => {
          if (trimmed.includes("'ceoOrchestratorEnabled'")) return { value: state.ceoEnabled };
          if (trimmed.includes("'ceoOrchestratorModel'")) return { value: state.ceoModel };
          if (trimmed.includes("'companyName'"))
            return state.companyName === undefined ? undefined : { value: state.companyName };
          throw new Error(`unexpected get() SQL: ${trimmed}`);
        },
        all: (..._args: unknown[]) => {
          if (trimmed.startsWith("SELECT content, message_type, created_at FROM messages")) return state.messages;
          if (trimmed.startsWith("SELECT status, COUNT(*) as cnt FROM tasks")) return state.queueStats;
          if (trimmed.startsWith("SELECT id, title, assigned_agent_id FROM tasks")) return state.reviewTasks;
          if (trimmed.startsWith("SELECT status, COUNT(*) as cnt FROM agents")) return state.agentStats;
          if (trimmed.startsWith("SELECT id, name FROM departments")) return state.departments;
          throw new Error(`unexpected all() SQL: ${trimmed}`);
        },
      };
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeOrchestrator(state: StoreState = defaultState()) {
  const broadcast = vi.fn();
  const notifyCeo = vi.fn();
  const appendTaskLog = vi.fn();
  const nowMs = vi.fn(() => 1_700_000_000_000);
  const app = { get: vi.fn().mockReturnValue(8790) } as unknown as Express;
  const db = makeFakeDb(state);

  const orchestrator = createCeoOrchestrator({
    db,
    app,
    broadcast,
    notifyCeo,
    appendTaskLog,
    nowMs,
  });

  return { orchestrator, broadcast, notifyCeo, appendTaskLog, nowMs, app, db, state };
}

function setProvider(row: unknown = { id: "p1", provider_type: "openai", api_key: "enc:k", base_url: "https://x" }) {
  mockGetProvider.mockReturnValue(row as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CEO Orchestrator — tick loop", () => {
  beforeEach(() => {
    mockWarn.mockReset();
    mockError.mockReset();
    mockInfo.mockReset();
    mockCallLlm.mockReset();
    mockGetProvider.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockReturnValue("test-model");
    // Replace global fetch with a vi.fn so we can assert on calls.
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Early-return short-circuit branches
  // -------------------------------------------------------------------------

  it("returns early when ceoOrchestratorEnabled is false", async () => {
    const state = defaultState();
    state.ceoEnabled = "false";
    const { orchestrator } = makeOrchestrator(state);

    await orchestrator.ceoTick();

    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it("returns early when no API provider is configured", async () => {
    setProvider(null);
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it("returns early when context collection yields nothing interesting", async () => {
    setProvider();
    const empty = defaultState();
    empty.messages = [];
    empty.reviewTasks = [];
    empty.queueStats = [{ status: "in_progress", cnt: 1 }]; // length <= 1
    const { orchestrator } = makeOrchestrator(empty);

    await orchestrator.ceoTick();

    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it("uses default company name when settings row is missing", async () => {
    setProvider();
    const state = defaultState();
    state.companyName = undefined;
    mockCallLlm.mockResolvedValue("[]");
    const { orchestrator } = makeOrchestrator(state);

    await orchestrator.ceoTick();

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    const systemPrompt = mockCallLlm.mock.calls[0][2] as string;
    expect(systemPrompt).toContain("OctoOffice");
  });

  // -------------------------------------------------------------------------
  // Decision execution branches
  // -------------------------------------------------------------------------

  it("executes a create_task decision (POST /api/tasks)", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(
      JSON.stringify([{ type: "create_task", title: "New thing", description: "do it", priority: 7 }]),
    );
    const { orchestrator, notifyCeo, broadcast } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8790/api/tasks");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      title: "New thing",
      priority: 7,
    });
    expect(notifyCeo).toHaveBeenCalledWith(expect.stringContaining('Created task: "New thing"'), null, "directive");
    expect(broadcast).toHaveBeenCalledWith("autonomous_action", expect.objectContaining({ action: "ceo_decision" }));
  });

  it("executes a reprioritize decision with priority change", async () => {
    setProvider();
    const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mockCallLlm.mockResolvedValue(JSON.stringify([{ type: "reprioritize", task_id: taskId, priority: 9 }]));
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8790/api/tasks/${taskId}`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ priority: 9 });
  });

  it("executes a reassign decision", async () => {
    setProvider();
    const taskId = "11111111-2222-3333-4444-555555555555";
    mockCallLlm.mockResolvedValue(JSON.stringify([{ type: "reassign", task_id: taskId, department_id: "qa" }]));
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8790/api/tasks/${taskId}`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ department_id: "qa" });
  });

  it("executes an approve_review decision (sets status=done)", async () => {
    setProvider();
    const taskId = "22222222-3333-4444-5555-666666666666";
    mockCallLlm.mockResolvedValue(JSON.stringify([{ type: "approve_review", task_id: taskId }]));
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: "done" });
  });

  it("executes a message decision (POST /api/messages)", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(
      JSON.stringify([{ type: "message", content: "Standup at 10", receiver_type: "all" }]),
    );
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8790/api/messages");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      sender_type: "ceo",
      content: "Standup at 10",
      receiver_type: "all",
      receiver_id: null,
    });
  });

  // -------------------------------------------------------------------------
  // Capping & summary notification
  // -------------------------------------------------------------------------

  it("caps decisions at 3 per tick and emits a summary notification", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(
      JSON.stringify([
        { type: "create_task", title: "A", description: "" },
        { type: "create_task", title: "B", description: "" },
        { type: "create_task", title: "C", description: "" },
        { type: "create_task", title: "D", description: "" },
        { type: "create_task", title: "E", description: "" },
      ]),
    );
    const { orchestrator, notifyCeo } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Executed 3 decision(s)"), null, "status_update");
  });

  it("emits no summary notification when LLM returns []", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue("[]");
    const { orchestrator, notifyCeo } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).not.toHaveBeenCalled();
    // notifyCeo may be called by other branches but not with the summary message
    const summaryCall = notifyCeo.mock.calls.find((c) => String(c[0]).includes("Executed"));
    expect(summaryCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it("logs error when callLlm throws (e.g. parse_error / network unreachable)", async () => {
    setProvider();
    mockCallLlm.mockRejectedValue(new Error("LLM unreachable"));
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    expect(mockError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "tick failed");
  });

  it("continues other decisions when one decision execution throws", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(
      JSON.stringify([
        { type: "create_task", title: "first", description: "" },
        { type: "message", content: "second", receiver_type: "all" },
      ]),
    );
    const { orchestrator } = makeOrchestrator();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    (globalThis as any).fetch = fetchMock;

    await orchestrator.ceoTick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "failed to execute decision",
    );
  });

  it("drops invalid decisions during parse and only executes valid ones", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(
      JSON.stringify([
        { type: "reprioritize", task_id: "not-a-uuid", priority: 5 },
        { type: "create_task", title: "ok", description: "" },
      ]),
    );
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8790/api/tasks");
  });

  it("returns [] from non-array LLM response and executes nothing", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue("just some prose, no JSON here");
    const { orchestrator } = makeOrchestrator();

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Concurrency guard
  // -------------------------------------------------------------------------

  it("does not start a new tick while a previous tick is still running", async () => {
    setProvider();
    let resolveLlm!: (s: string) => void;
    mockCallLlm.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveLlm = resolve;
        }),
    );
    const { orchestrator } = makeOrchestrator();

    const first = orchestrator.ceoTick();
    // Second invocation while the first is in flight: should short-circuit
    // before calling callLlm again.
    await orchestrator.ceoTick();
    expect(mockCallLlm).toHaveBeenCalledTimes(1);

    resolveLlm("[]");
    await first;
  });

  // -------------------------------------------------------------------------
  // App port resolution
  // -------------------------------------------------------------------------

  it("falls back to default port 8790 when app.get is missing", async () => {
    setProvider();
    mockCallLlm.mockResolvedValue(JSON.stringify([{ type: "create_task", title: "t", description: "" }]));
    const broadcast = vi.fn();
    const notifyCeo = vi.fn();
    const orchestrator = createCeoOrchestrator({
      db: makeFakeDb(defaultState()),
      app: {} as Express,
      broadcast,
      notifyCeo,
      appendTaskLog: vi.fn(),
      nowMs: () => 1,
    });

    await orchestrator.ceoTick();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(String(fetchMock.mock.calls[0][0])).toContain("127.0.0.1:8790");
  });
});
