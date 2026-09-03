import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must come before importing the module under test.
// ---------------------------------------------------------------------------

const routeFollowUpViaCeoMock = vi.hoisted(() => vi.fn());
const handleProjectReviewDecisionReplyMock = vi.hoisted(() => vi.fn());
const handleReviewRoundDecisionReplyMock = vi.hoisted(() => vi.fn());
const handleTimeoutResumeDecisionReplyMock = vi.hoisted(() => vi.fn());
const sendMessengerMessageMock = vi.hoisted(() => vi.fn());

// Capture deps passed into the project-review reply so we can reach into
// openSupplementRound (which is closure-scoped inside the routes module).
const capturedDeps: { current: any } = vi.hoisted(() => ({ current: null }));

vi.mock("../../../../gateway/client.ts", () => ({
  sendMessengerMessage: sendMessengerMessageMock,
}));

vi.mock("../../../workflow/orchestration/ceo-followup-router.ts", () => ({
  routeFollowUpViaCeo: routeFollowUpViaCeoMock,
}));

vi.mock("./decision-inbox/project-review-reply.ts", () => ({
  handleProjectReviewDecisionReply: handleProjectReviewDecisionReplyMock,
}));

vi.mock("./decision-inbox/review-round-reply.ts", () => ({
  handleReviewRoundDecisionReply: handleReviewRoundDecisionReplyMock,
}));

vi.mock("./decision-inbox/timeout-reply.ts", () => ({
  handleTimeoutResumeDecisionReply: handleTimeoutResumeDecisionReplyMock,
}));

// Stub the four item builders so getDecisionInboxItems is deterministic.
const buildProjectReviewItemsMock = vi.hoisted(() => vi.fn(() => [] as any[]));
const buildReviewRoundItemsMock = vi.hoisted(() => vi.fn(() => [] as any[]));
const buildTimeoutResumeItemsMock = vi.hoisted(() => vi.fn(() => [] as any[]));

vi.mock("./decision-inbox/project-timeout-items.ts", () => ({
  createProjectAndTimeoutDecisionItems: () => ({
    getProjectReviewTaskChoices: () => [],
    buildProjectReviewDecisionItems: buildProjectReviewItemsMock,
    buildTimeoutResumeDecisionItems: buildTimeoutResumeItemsMock,
  }),
}));

vi.mock("./decision-inbox/review-round-items.ts", () => ({
  createReviewRoundDecisionItems: () => ({
    getReviewDecisionFallbackLabel: () => "fallback",
    getReviewDecisionNotes: () => null,
    buildReviewRoundDecisionItems: buildReviewRoundItemsMock,
  }),
}));

vi.mock("./decision-inbox/state-helpers.ts", () => ({
  createDecisionStateHelpers: () => ({
    buildProjectReviewSnapshotHash: () => "snap",
    getProjectReviewDecisionState: () => null,
    upsertProjectReviewDecisionState: () => undefined,
    buildReviewRoundSnapshotHash: () => "snap",
    getReviewRoundDecisionState: () => null,
    upsertReviewRoundDecisionState: () => undefined,
    recordProjectReviewDecisionEvent: () => undefined,
  }),
}));

vi.mock("./decision-inbox/project-review-planning.ts", () => ({
  createProjectReviewPlanningHelpers: () => ({
    formatPlannerSummaryForDisplay: () => "",
    resolvePlanningLeadMeta: () => null,
    queueProjectReviewPlanningConsolidation: () => undefined,
  }),
}));

vi.mock("./decision-inbox/review-round-planning.ts", () => ({
  createReviewRoundPlanningHelpers: () => ({
    queueReviewRoundPlanningConsolidation: () => undefined,
  }),
}));

const messengerBridgeMock = vi.hoisted(() => ({
  tryHandleInboxDecisionReply: vi.fn(async () => ({ handled: false, status: 200, payload: {} })),
  flushDecisionInboxMessengerNotices: vi.fn(async () => undefined),
  startBackgroundNoticeSync: vi.fn(),
}));

vi.mock("./decision-inbox/messenger-bridge.ts", () => ({
  createDecisionInboxMessengerBridge: () => messengerBridgeMock,
}));

const readYoloModeEnabledMock = vi.hoisted(() => vi.fn(() => false));
const runYoloDecisionAutopilotMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./decision-inbox/yolo-mode.ts", () => ({
  readYoloModeEnabled: readYoloModeEnabledMock,
  runYoloDecisionAutopilot: runYoloDecisionAutopilotMock,
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { registerDecisionInboxRoutes } from "./decision-inbox-routes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (req: any, res: any) => any;

interface Harness {
  bridge: ReturnType<typeof registerDecisionInboxRoutes>;
  db: DatabaseSync;
  appendTaskLog: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  activeProcesses: Map<string, any>;
  runTask: ReturnType<typeof vi.fn>;
  startTaskExecutionForAgent: ReturnType<typeof vi.fn>;
  getHandlers: Map<string, Handler>;
  postHandlers: Map<string, Handler>;
  packRegistry: { get: ReturnType<typeof vi.fn> };
  metrics: { incCounter: ReturnType<typeof vi.fn> };
  openSupplementRound: () => (
    taskId: string,
    assignedAgentId: string | null,
    fallbackDepartmentId: string | null,
    logPrefix?: string,
    followUpNote?: string,
  ) => Promise<{ started: boolean; reason: string }>;
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      department_id TEXT,
      status TEXT,
      priority INTEGER,
      workflow_pack_key TEXT,
      project_id TEXT,
      project_path TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      status TEXT,
      current_task_id TEXT
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      title TEXT,
      status TEXT,
      completed_at INTEGER
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT,
      message TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function createHarness(opts: { withPackRegistry?: boolean } = {}): Harness {
  const db = createDb();
  const appendTaskLog = vi.fn((taskId: string, kind: string, message: string) => {
    db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
      taskId,
      kind,
      message,
      Date.now(),
    );
  });
  const broadcast = vi.fn();
  const activeProcesses = new Map<string, any>();
  const runTask = vi.fn(async () => undefined);
  const startTaskExecutionForAgent = vi.fn();
  const metrics = { incCounter: vi.fn() };

  // Default: project review handler captures deps and returns false (so it falls through).
  handleProjectReviewDecisionReplyMock.mockImplementation(async ({ deps }: any) => {
    capturedDeps.current = deps;
    return false;
  });
  handleReviewRoundDecisionReplyMock.mockImplementation(async () => false);
  handleTimeoutResumeDecisionReplyMock.mockImplementation(() => false);

  const getHandlers = new Map<string, Handler>();
  const postHandlers = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => getHandlers.set(path, handler),
    post: (path: string, handler: Handler) => postHandlers.set(path, handler),
  };

  const packRegistry = {
    get: vi.fn((_key: string) => null as any),
  };

  const ctx: any = {
    app,
    db,
    nowMs: () => Date.now(),
    activeProcesses,
    appendTaskLog,
    broadcast,
    finishReview: vi.fn(),
    getAgentDisplayName: vi.fn(() => "Agent"),
    getDeptName: vi.fn(() => "Dept"),
    getPreferredLanguage: vi.fn(() => "en"),
    l: (ko: any, en: any) => ({ ko, en }),
    pickL: (pool: any) => pool.en?.[0] ?? pool.ko?.[0] ?? "",
    findTeamLeader: vi.fn(() => null),
    normalizeTextField: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
    processSubtaskDelegations: vi.fn(),
    resolveLang: vi.fn(() => "en"),
    runAgentOneShot: vi.fn(async () => ({ text: "" })),
    scheduleNextReviewRound: vi.fn(),
    seedReviewRevisionSubtasks: vi.fn(),
    startTaskExecutionForAgent,
    chooseSafeReply: vi.fn(() => "ok"),
    runTask,
    metrics,
    packRegistry: opts.withPackRegistry ? packRegistry : undefined,
    taskWorktrees: new Map(),
  };

  const bridge = registerDecisionInboxRoutes(ctx);

  return {
    bridge,
    db,
    appendTaskLog,
    broadcast,
    activeProcesses,
    runTask,
    startTaskExecutionForAgent,
    getHandlers,
    postHandlers,
    packRegistry,
    metrics,
    openSupplementRound: () => {
      if (!capturedDeps.current?.openSupplementRound) {
        throw new Error("openSupplementRound not captured — invoke decision reply route first");
      }
      return capturedDeps.current.openSupplementRound;
    },
  };
}

// Fake express res that records status + json calls.
function createRes() {
  let status = 200;
  let body: any = undefined;
  const res: any = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: any) {
      body = value;
      return res;
    },
    get _status() {
      return status;
    },
    get _body() {
      return body;
    },
  };
  return res;
}

async function triggerDepsCapture(h: Harness) {
  // Provide one item so applyDecisionReply finds it and dispatches into
  // handleProjectReviewDecisionReply (our mock captures deps).
  const item: any = {
    id: "dec-1",
    kind: "project_review_ready",
    created_at: 1,
    summary: "",
    project_id: null,
    project_name: null,
    project_path: null,
    task_id: "task-A",
    task_title: "T",
    options: [{ number: 1, action: "approve", label: "approve" }],
  };
  buildProjectReviewItemsMock.mockReturnValueOnce([item]);
  const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
  await handler({ params: { id: "dec-1" }, body: { option_number: 1 } }, createRes());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decision-inbox-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDeps.current = null;
    routeFollowUpViaCeoMock.mockReset();
    buildProjectReviewItemsMock.mockReturnValue([]);
    buildReviewRoundItemsMock.mockReturnValue([]);
    buildTimeoutResumeItemsMock.mockReturnValue([]);
    messengerBridgeMock.tryHandleInboxDecisionReply.mockReset();
    messengerBridgeMock.tryHandleInboxDecisionReply.mockResolvedValue({ handled: false, status: 200, payload: {} });
    messengerBridgeMock.flushDecisionInboxMessengerNotices.mockReset();
    messengerBridgeMock.flushDecisionInboxMessengerNotices.mockResolvedValue(undefined);
    readYoloModeEnabledMock.mockReturnValue(false);
    runYoloDecisionAutopilotMock.mockReset();
    runYoloDecisionAutopilotMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Yolo timer is unref'd; nothing to clean.
  });

  describe("registerDecisionInboxRoutes registration", () => {
    it("registers GET /api/decision-inbox and POST /api/decision-inbox/:id/reply and returns bridge", () => {
      const h = createHarness();
      expect(h.getHandlers.has("/api/decision-inbox")).toBe(true);
      expect(h.postHandlers.has("/api/decision-inbox/:id/reply")).toBe(true);
      expect(h.bridge).toHaveProperty("tryHandleInboxDecisionReply");
    });
  });

  describe("GET /api/decision-inbox", () => {
    it("returns sorted items and triggers messenger flush", async () => {
      const h = createHarness();
      const items = [
        { id: "a", kind: "project_review_ready", created_at: 1, summary: "", options: [] } as any,
        { id: "b", kind: "review_round_pick", created_at: 5, summary: "", options: [] } as any,
        { id: "c", kind: "task_timeout_resume", created_at: 3, summary: "", options: [] } as any,
      ];
      buildProjectReviewItemsMock.mockReturnValue([items[0]]);
      buildReviewRoundItemsMock.mockReturnValue([items[1]]);
      buildTimeoutResumeItemsMock.mockReturnValue([items[2]]);

      const handler = h.getHandlers.get("/api/decision-inbox")!;
      const res = createRes();
      handler({ query: {} }, res);

      expect(res._body.items.map((i: any) => i.id)).toEqual(["b", "c", "a"]); // desc by created_at
      expect(messengerBridgeMock.flushDecisionInboxMessengerNotices).toHaveBeenCalledWith({ force: false });
    });

    it("respects force=1 query parameter", () => {
      const h = createHarness();
      const handler = h.getHandlers.get("/api/decision-inbox")!;
      handler({ query: { force: "1" } }, createRes());
      expect(messengerBridgeMock.flushDecisionInboxMessengerNotices).toHaveBeenCalledWith({ force: true });
    });

    it("respects force=true query parameter (case-insensitive)", () => {
      const h = createHarness();
      const handler = h.getHandlers.get("/api/decision-inbox")!;
      handler({ query: { force: "TRUE" } }, createRes());
      expect(messengerBridgeMock.flushDecisionInboxMessengerNotices).toHaveBeenCalledWith({ force: true });
    });

    it("swallows messenger flush errors", async () => {
      const h = createHarness();
      messengerBridgeMock.flushDecisionInboxMessengerNotices.mockRejectedValueOnce(new Error("boom"));
      const handler = h.getHandlers.get("/api/decision-inbox")!;
      const res = createRes();
      expect(() => handler({ query: {} }, res)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe("POST /api/decision-inbox/:id/reply", () => {
    it("returns 400 when option_number is missing/non-numeric", async () => {
      const h = createHarness();
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "x" }, body: {} }, res);
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ error: "option_number_required" });
    });

    it("returns 404 when decision id not found", async () => {
      const h = createHarness();
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "missing" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(404);
      expect(res._body).toEqual({ error: "decision_not_found" });
    });

    it("returns 409 when decision item exists but has no options ready", async () => {
      const h = createHarness();
      buildProjectReviewItemsMock.mockReturnValue([
        {
          id: "d1",
          kind: "project_review_ready",
          created_at: 1,
          summary: "",
          options: [],
        } as any,
      ]);
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d1" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(409);
      expect(res._body).toEqual({ error: "decision_options_not_ready", kind: "project_review_ready" });
    });

    it("returns 400 when option_number doesn't match any option", async () => {
      const h = createHarness();
      buildProjectReviewItemsMock.mockReturnValue([
        {
          id: "d1",
          kind: "project_review_ready",
          created_at: 1,
          summary: "",
          options: [{ number: 1, action: "x", label: "x" }],
        } as any,
      ]);
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d1" }, body: { option_number: 99 } }, res);
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ error: "option_not_found", option_number: 99 });
    });

    it("propagates status/payload from project-review reply when handled=true", async () => {
      const h = createHarness();
      buildProjectReviewItemsMock.mockReturnValue([
        {
          id: "d1",
          kind: "project_review_ready",
          created_at: 1,
          summary: "",
          options: [{ number: 1, action: "x", label: "x" }],
        } as any,
      ]);
      handleProjectReviewDecisionReplyMock.mockImplementationOnce(async ({ res }: any) => {
        res.status(202).json({ ok: "project" });
        return true;
      });
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d1" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(202);
      expect(res._body).toEqual({ ok: "project" });
    });

    it("propagates status/payload from review-round reply when handled=true", async () => {
      const h = createHarness();
      buildReviewRoundItemsMock.mockReturnValue([
        {
          id: "d2",
          kind: "review_round_pick",
          created_at: 1,
          summary: "",
          options: [{ number: 1, action: "x", label: "x" }],
          meeting_id: "m",
          review_round: 1,
        } as any,
      ]);
      handleReviewRoundDecisionReplyMock.mockImplementationOnce(async ({ res }: any) => {
        res.status(201).json({ ok: "review-round" });
        return true;
      });
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d2" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(201);
      expect(res._body).toEqual({ ok: "review-round" });
    });

    it("propagates status/payload from timeout-resume reply when handled=true", async () => {
      const h = createHarness();
      buildTimeoutResumeItemsMock.mockReturnValue([
        {
          id: "d3",
          kind: "task_timeout_resume",
          created_at: 1,
          summary: "",
          options: [{ number: 1, action: "x", label: "x" }],
        } as any,
      ]);
      handleTimeoutResumeDecisionReplyMock.mockImplementationOnce(({ res }: any) => {
        res.status(204).json({ ok: "timeout" });
        return true;
      });
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d3" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(204);
      expect(res._body).toEqual({ ok: "timeout" });
    });

    it("returns 400 unknown_decision_id when no handler claims the item", async () => {
      const h = createHarness();
      buildProjectReviewItemsMock.mockReturnValue([
        {
          id: "d4",
          kind: "project_review_ready",
          created_at: 1,
          summary: "",
          options: [{ number: 1, action: "x", label: "x" }],
        } as any,
      ]);
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d4" }, body: { option_number: 1 } }, res);
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ error: "unknown_decision_id" });
    });

    it("accepts alternate option keys (option) in body", async () => {
      const h = createHarness();
      buildProjectReviewItemsMock.mockReturnValue([
        {
          id: "d5",
          kind: "project_review_ready",
          created_at: 1,
          summary: "",
          options: [{ number: 7, action: "x", label: "x" }],
        } as any,
      ]);
      const handler = h.postHandlers.get("/api/decision-inbox/:id/reply")!;
      const res = createRes();
      await handler({ params: { id: "d5" }, body: { option: 7 } }, res);
      // Inner handlers default to false -> falls through to unknown_decision_id.
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ error: "unknown_decision_id" });
    });
  });

  // -------------------------------------------------------------------------
  // openSupplementRound — exercised via captured deps.
  // -------------------------------------------------------------------------

  describe("openSupplementRound", () => {
    async function setup(opts?: { withPackRegistry?: boolean }) {
      const h = createHarness(opts);
      await triggerDepsCapture(h);
      return h;
    }

    it("without followUpNote: opens supplement on online assignee and calls runTask", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status, updated_at) VALUES (?, ?, ?)").run("task-A", "review", 0);
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: true, reason: "started" });
      expect(h.runTask).toHaveBeenCalledWith("task-A");
      const task = h.db.prepare("SELECT status FROM tasks WHERE id=?").get("task-A") as any;
      expect(task.status).toBe("pending");
      expect(h.broadcast).toHaveBeenCalledWith("task_update", expect.any(Object));
    });

    it("returns no_assignee when assignedAgentId is null", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      const result = await h.openSupplementRound()("task-A", null, null);
      expect(result).toEqual({ started: false, reason: "no_assignee" });
      expect(h.runTask).not.toHaveBeenCalled();
    });

    it("returns agent_not_found when assigned agent missing in DB", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      const result = await h.openSupplementRound()("task-A", "ghost", null);
      expect(result).toEqual({ started: false, reason: "agent_not_found" });
    });

    it("returns agent_offline when agent is offline", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "offline");
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: false, reason: "agent_offline" });
    });

    it("returns already_running when activeProcesses has the task", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.activeProcesses.set("task-A", { kill: () => undefined });
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: false, reason: "already_running" });
    });

    it("returns agent_busy when agent is working on a different active task", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db
        .prepare("INSERT INTO agents (id, status, current_task_id) VALUES (?, ?, ?)")
        .run("agent-1", "working", "other-task");
      h.activeProcesses.set("other-task", { kill: () => undefined });
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: false, reason: "agent_busy" });
    });

    it("returns run_failed when runTask throws an Error", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.runTask.mockRejectedValueOnce(new Error("kapow"));
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: false, reason: "run_failed" });
    });

    it("returns run_failed and stringifies non-Error throws", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.runTask.mockRejectedValueOnce("boom-string");
      const result = await h.openSupplementRound()("task-A", "agent-1", null);
      expect(result).toEqual({ started: false, reason: "run_failed" });
    });

    // ---------------- CEO routing branches ----------------

    it("CEO returns null/no_provider — falls back to direct supplement and logs reason", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({ decision: null, reason: "no_provider" });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "fix typo");
      expect(result).toEqual({ started: true, reason: "started" });
      expect(h.appendTaskLog).toHaveBeenCalledWith(
        "task-A",
        "system",
        expect.stringContaining("CEO follow-up routing skipped (reason: no_provider)"),
      );
    });

    it("CEO returns null/parse_error — fallback path", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({ decision: null, reason: "parse_error" });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "note");
      expect(result.started).toBe(true);
      expect(h.appendTaskLog).toHaveBeenCalledWith("task-A", "system", expect.stringContaining("reason: parse_error"));
    });

    it("CEO returns null/llm_error — fallback path", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({ decision: null, reason: "llm_error" });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "note");
      expect(result.started).toBe(true);
      expect(h.appendTaskLog).toHaveBeenCalledWith("task-A", "system", expect.stringContaining("reason: llm_error"));
    });

    it("CEO supplement decision with target_agent_id re-routes to validated online agent", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-2", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "supplement",
          target_agent_id: "agent-2",
          target_department_id: "dept-2",
          reasoning: "agent-2 is the right specialist",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", "dept-1", "Ix", "note");
      expect(result).toEqual({ started: true, reason: "started" });
      const task = h.db.prepare("SELECT assigned_agent_id, department_id FROM tasks WHERE id=?").get("task-A") as any;
      expect(task.assigned_agent_id).toBe("agent-2");
      expect(task.department_id).toBe("dept-2");
      expect(h.appendTaskLog).toHaveBeenCalledWith(
        "task-A",
        "system",
        expect.stringContaining("CEO re-routed to agent"),
      );
    });

    it("CEO supplement reverts to original assignee when target agent not found", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "supplement",
          target_agent_id: "ghost-agent",
          reasoning: "specialist",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "note");
      expect(result.started).toBe(true);
      expect(h.appendTaskLog).toHaveBeenCalledWith("task-A", "system", expect.stringContaining("not found, reverting"));
    });

    it("CEO supplement reverts when target agent is offline", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-2", "offline");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "supplement",
          target_agent_id: "agent-2",
          reasoning: "specialist",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "note");
      expect(result.started).toBe(true);
      expect(h.appendTaskLog).toHaveBeenCalledWith("task-A", "system", expect.stringContaining("offline, reverting"));
    });

    it("CEO new_task — creates a new task, logs, and broadcasts", async () => {
      const h = await setup();
      h.db
        .prepare("INSERT INTO tasks (id, status, project_id, project_path, workflow_pack_key) VALUES (?, ?, ?, ?, ?)")
        .run("task-A", "review", "proj", "/p", "development");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "new_task",
          new_task_title: "Brand new task",
          new_task_description: "Do this fresh thing",
          target_department_id: "dept-x",
          reasoning: "out of scope",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "build a wholly new feature");
      expect(result).toEqual({ started: true, reason: "new_task" });
      const newTasks = h.db
        .prepare("SELECT title, description, department_id, project_id, workflow_pack_key FROM tasks WHERE id != ?")
        .all("task-A") as any[];
      expect(newTasks).toHaveLength(1);
      expect(newTasks[0]).toMatchObject({
        title: "Brand new task",
        description: "Do this fresh thing",
        department_id: "dept-x",
        project_id: "proj",
        workflow_pack_key: "development",
      });
      // runTask must NOT have been called for the new_task path.
      expect(h.runTask).not.toHaveBeenCalled();
    });

    it("CEO new_task uses follow-up note as fallback title/description", async () => {
      const h = await setup();
      h.db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-A", "review");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: { decision: "new_task", reasoning: "out of scope" },
        source: "llm",
      });
      const note = "User requested an entirely separate workstream";
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", note);
      expect(result.reason).toBe("new_task");
      const newTask = h.db.prepare("SELECT title, description FROM tasks WHERE id != ?").get("task-A") as any;
      expect(newTask.title).toBe(note.slice(0, 72));
      expect(newTask.description).toBe(note);
    });

    it("CEO pipeline_reset without packRegistry falls back to supplement and logs", async () => {
      const h = await setup({ withPackRegistry: false });
      h.db
        .prepare("INSERT INTO tasks (id, status, workflow_pack_key) VALUES (?, ?, ?)")
        .run("task-A", "review", "development");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "pipeline_reset",
          reset_from_phase: "design",
          reasoning: "rework",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "rework needed");
      expect(result).toEqual({ started: true, reason: "started" });
      expect(h.appendTaskLog).toHaveBeenCalledWith(
        "task-A",
        "system",
        expect.stringContaining("pack registry unavailable"),
      );
    });

    it("CEO pipeline_reset with unknown pack key falls back to supplement", async () => {
      const h = await setup({ withPackRegistry: true });
      h.db
        .prepare("INSERT INTO tasks (id, status, workflow_pack_key) VALUES (?, ?, ?)")
        .run("task-A", "review", "ghost-pack");
      h.db.prepare("INSERT INTO agents (id, status) VALUES (?, ?)").run("agent-1", "idle");
      h.packRegistry.get.mockReturnValueOnce(null);
      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "pipeline_reset",
          reset_from_phase: "design",
          reasoning: "rework",
        },
        source: "llm",
      });
      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "rework");
      expect(result.started).toBe(true);
      expect(result.reason).toBe("started");
    });

    it("CEO pipeline_reset resets downstream pipeline subtasks via graph adjacency", async () => {
      const h = await setup({ withPackRegistry: true });
      h.db
        .prepare("INSERT INTO tasks (id, status, workflow_pack_key) VALUES (?, ?, ?)")
        .run("task-A", "review", "development");

      // Pipeline subtasks: design -> build -> test, plus an input phase and an unrelated subtask.
      h.db
        .prepare("INSERT INTO subtasks (id, task_id, title, status) VALUES (?, ?, ?, ?)")
        .run("s1", "task-A", "[pipeline:design] X", "completed");
      h.db
        .prepare("INSERT INTO subtasks (id, task_id, title, status) VALUES (?, ?, ?, ?)")
        .run("s2", "task-A", "[pipeline:build] X", "completed");
      h.db
        .prepare("INSERT INTO subtasks (id, task_id, title, status) VALUES (?, ?, ?, ?)")
        .run("s3", "task-A", "[pipeline:test] X", "completed");
      h.db
        .prepare("INSERT INTO subtasks (id, task_id, title, status) VALUES (?, ?, ?, ?)")
        .run("s4", "task-A", "[pipeline:__input__]", "completed");
      h.db
        .prepare("INSERT INTO subtasks (id, task_id, title, status) VALUES (?, ?, ?, ?)")
        .run("s5", "task-A", "Unrelated subtask", "completed");

      const adjacency = new Map<string, string[]>();
      adjacency.set("design", ["build"]);
      adjacency.set("build", ["test"]);
      adjacency.set("test", []);
      h.packRegistry.get.mockReturnValueOnce({ graph: { adjacency } } as any);

      // Active process must be killed by pipeline_reset.
      const killSpy = vi.fn();
      h.activeProcesses.set("task-A", { kill: killSpy });

      routeFollowUpViaCeoMock.mockResolvedValueOnce({
        decision: {
          decision: "pipeline_reset",
          reset_from_phase: "design:variant",
          reasoning: "rework",
        },
        source: "llm",
      });

      const result = await h.openSupplementRound()("task-A", "agent-1", null, "Ix", "rework needed");
      expect(result).toEqual({ started: true, reason: "pipeline_reset" });
      expect(killSpy).toHaveBeenCalled();
      expect(h.activeProcesses.has("task-A")).toBe(false);

      // s1 (base) -> pending; s2,s3 -> blocked; s4 (input) untouched; s5 untouched.
      const rows = h.db.prepare("SELECT id, status FROM subtasks WHERE task_id=?").all("task-A") as Array<{
        id: string;
        status: string;
      }>;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(byId.s1).toBe("pending");
      expect(byId.s2).toBe("blocked");
      expect(byId.s3).toBe("blocked");
      expect(byId.s4).toBe("completed");
      expect(byId.s5).toBe("completed");

      const task = h.db.prepare("SELECT status FROM tasks WHERE id=?").get("task-A") as any;
      expect(task.status).toBe("planned");
    });
  });

  // -------------------------------------------------------------------------
  // YOLO autopilot wiring (touched on every GET / POST).
  // -------------------------------------------------------------------------

  describe("YOLO autopilot", () => {
    it("invokes runYoloDecisionAutopilot when readYoloModeEnabled returns true", async () => {
      readYoloModeEnabledMock.mockReturnValue(true);
      const h = createHarness();
      const handler = h.getHandlers.get("/api/decision-inbox")!;
      handler({ query: {} }, createRes());
      await new Promise((r) => setTimeout(r, 10));
      expect(runYoloDecisionAutopilotMock).toHaveBeenCalled();
    });

    it("skips runYoloDecisionAutopilot when readYoloModeEnabled returns false", async () => {
      readYoloModeEnabledMock.mockReturnValue(false);
      const h = createHarness();
      const handler = h.getHandlers.get("/api/decision-inbox")!;
      handler({ query: {} }, createRes());
      await Promise.resolve();
      expect(runYoloDecisionAutopilotMock).not.toHaveBeenCalled();
    });
  });
});
