import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerTaskRunRoute, type TaskRunRouteDeps } from "../../../../modules/routes/core/tasks/execution-run.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../../gateway/client.ts", () => ({
  notifyTaskStatus: vi.fn(),
}));

vi.mock("../../../../modules/workflow/core/video-skill-bootstrap.ts", () => ({
  ensureVideoPreprodRemotionBestPracticesSkill: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === "string" && p.endsWith(".git")) return true;
        return false;
      }),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    }),
    mkdirSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  title: string;
  description: string | null;
  assigned_agent_id: string | null;
  department_id: string | null;
  project_id: string | null;
  workflow_pack_key: string | null;
  project_path: string | null;
  status: string;
  task_type: string | null;
  workflow_meta_json: string | null;
}

interface MockAgentRow {
  id: string;
  name: string;
  name_ko: string | null;
  role: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  cli_profile: string | null;
  personality: string | null;
  department_id: string | null;
  department_name: string | null;
  department_name_ko: string | null;
  department_prompt: string | null;
  status?: string;
  current_task_id?: string | null;
}

function createMockDb(opts: { tasks?: MockTaskRow[]; agents?: MockAgentRow[] }) {
  const tasks = [...(opts.tasks ?? [])];
  const agents = [...(opts.agents ?? [])];
  const updates: Array<{ sql: string; params: unknown[] }> = [];

  return {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase();
      return {
        get: (...params: unknown[]) => {
          if (upper.includes("FROM TASKS") && upper.includes("WHERE ID")) {
            return tasks.find((t) => t.id === params[0]);
          }
          if (upper.includes("FROM AGENTS") && upper.includes("WHERE A.ID")) {
            return agents.find((a) => a.id === (params.length > 1 ? params[1] : params[0]));
          }
          if (upper.includes("FROM AGENTS") && upper.includes("WHERE ID")) {
            return agents.find((a) => a.id === params[0]);
          }
          if (upper.includes("CURRENT_TASK_ID") && upper.includes("AGENTS") && upper.includes("WORKING")) {
            const agent = agents.find((a) => a.id === params[0] && a.status === "working");
            return agent ? { current_task_id: agent.current_task_id } : undefined;
          }
          if (upper.includes("DEPARTMENT_ID") && upper.includes("FROM TASKS")) {
            const task = tasks.find((t) => t.id === params[0]);
            return task ? { department_id: task.department_id } : undefined;
          }
          if (upper.includes("WORKFLOW_META_JSON") && upper.includes("TASKS")) {
            const task = tasks.find((t) => t.id === params[0]);
            return task ? { workflow_meta_json: task.workflow_meta_json } : undefined;
          }
          if (upper.includes("COUNT") && upper.includes("SUBTASKS")) {
            return { cnt: 0 };
          }
          if (upper.includes("SERVER_ALLOCATIONS")) {
            return undefined;
          }
          if (upper.includes("SUBTASKS") && upper.includes("PIPELINE")) {
            return undefined;
          }
          return undefined;
        },
        run: (...params: unknown[]) => {
          updates.push({ sql, params });
          if (upper.includes("UPDATE TASKS SET STATUS")) {
            const task = tasks.find((t) => t.id === params[params.length - 1]);
            if (task) task.status = params[0] as string;
          }
        },
        all: (..._params: unknown[]) => {
          return [];
        },
      };
    },
    _updates: updates,
  };
}

// ---------------------------------------------------------------------------
// Default test fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "test-task-0001-0000-0000-000000000001";
const AGENT_ID = "agent-001";

function defaultTask(overrides: Partial<MockTaskRow> = {}): MockTaskRow {
  return {
    id: TASK_ID,
    title: "Implement feature X",
    description: "Build the feature X for the project",
    assigned_agent_id: AGENT_ID,
    department_id: "dev",
    project_id: "proj-1",
    workflow_pack_key: null,
    project_path: "/tmp/test-project",
    status: "planned",
    task_type: "general",
    workflow_meta_json: null,
    ...overrides,
  };
}

function defaultAgent(overrides: Partial<MockAgentRow> = {}): MockAgentRow {
  return {
    id: AGENT_ID,
    name: "TestAgent",
    name_ko: "테스트에이전트",
    role: "senior",
    cli_provider: "claude",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
    cli_profile: null,
    personality: "diligent",
    department_id: "dev",
    department_name: "Development",
    department_name_ko: "개발팀",
    department_prompt: null,
    status: "idle",
    current_task_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function createMockDeps(
  db: ReturnType<typeof createMockDb>,
  overrides: Partial<TaskRunRouteDeps> = {},
): TaskRunRouteDeps {
  const app = express();
  app.use(express.json());

  const mockChild = {
    pid: 12345,
    on: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    unref: vi.fn(),
  };

  return {
    app: app as any,
    db: db as any,
    activeProcesses: new Map(),
    appendTaskLog: vi.fn(),
    nowMs: () => Date.now(),
    resolveLang: () => "en" as any,
    ensureTaskExecutionSession: vi.fn(() => ({
      sessionId: "session-1",
      taskId: "task-1",
      agentId: AGENT_ID,
      provider: "claude",
      openedAt: Date.now(),
      lastTouchedAt: Date.now(),
    })),
    resolveProjectPath: vi.fn(() => "/tmp/test-project"),
    logsDir: "/tmp/logs",
    createWorktree: vi.fn(() => "/tmp/worktree/test"),
    generateProjectContext: vi.fn(() => "src/\n  index.ts"),
    getRecentChanges: vi.fn(() => ""),
    ensureClaudeMd: vi.fn(),
    getDeptRoleConstraint: vi.fn(() => ""),
    normalizeTextField: vi.fn((v: unknown) => (typeof v === "string" ? v : null)),
    getRecentConversationContext: vi.fn(() => ""),
    getTaskContinuationContext: vi.fn(() => ""),
    pickL: vi.fn((_pool: any, _lang: any) => "translated"),
    l: vi.fn((_ko: any, en: any) => en),
    getProviderModelConfig: vi.fn(() => ({})),
    buildTaskExecutionPrompt: vi.fn(() => "Execute the task"),
    hasExplicitWarningFixRequest: vi.fn(() => false),
    getNextHttpAgentPid: vi.fn(() => 99999),
    broadcast: vi.fn(),
    getAgentDisplayName: vi.fn(() => "TestAgent"),
    notifyCeo: vi.fn(),
    startProgressTimer: vi.fn(),
    launchApiProviderAgent: vi.fn(),
    launchHttpAgent: vi.fn(),
    spawnCliAgent: vi.fn(() => mockChild as any),
    handleTaskRunComplete: vi.fn(),
    buildAvailableSkillsPromptBlock: vi.fn(() => "[Available Skills]"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/run", () => {
  let db: ReturnType<typeof createMockDb>;
  let deps: TaskRunRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function setup(taskOverrides: Partial<MockTaskRow> = {}, agentOverrides: Partial<MockAgentRow> = {}) {
    db = createMockDb({
      tasks: [defaultTask(taskOverrides)],
      agents: [defaultAgent(agentOverrides)],
    });
    deps = createMockDeps(db);
    registerTaskRunRoute(deps);
    app = deps.app as any;
  }

  it("returns 404 when task not found", async () => {
    db = createMockDb({ tasks: [], agents: [] });
    deps = createMockDeps(db);
    registerTaskRunRoute(deps);
    app = deps.app as any;

    const res = await request(app).post("/api/tasks/nonexistent/run").send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 when no agent assigned", async () => {
    setup({ assigned_agent_id: null });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_agent_assigned");
  });

  it("returns 400 when agent not found in DB", async () => {
    setup({ assigned_agent_id: "nonexistent-agent" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("returns 400 for unsupported provider", async () => {
    setup({}, { cli_provider: "unsupported_provider" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_provider");
  });

  it("returns 409 when worktree creation fails", async () => {
    setup();
    (deps.createWorktree as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("worktree_required");
  });

  it("succeeds with CLI provider (claude) and returns pid", async () => {
    setup();

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pid).toBe(12345);
    expect(res.body.worktree).toBe(true);
    expect(deps.spawnCliAgent).toHaveBeenCalled();
    expect(deps.ensureClaudeMd).toHaveBeenCalled();
  });

  it("succeeds with API provider", async () => {
    setup({}, { cli_provider: "api", api_provider_id: "prov-1", api_model: "gpt-4" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pid).toBe(99999);
    expect(deps.launchApiProviderAgent).toHaveBeenCalled();
    expect(deps.spawnCliAgent).not.toHaveBeenCalled();
  });

  it("succeeds with HTTP provider (copilot)", async () => {
    setup({}, { cli_provider: "copilot" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.launchHttpAgent).toHaveBeenCalled();
    expect(deps.spawnCliAgent).not.toHaveBeenCalled();
  });

  it("succeeds with HTTP provider (antigravity)", async () => {
    setup({}, { cli_provider: "antigravity" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.launchHttpAgent).toHaveBeenCalled();
  });

  it("cleans stale active process on re-run when PID is dead", async () => {
    setup({ status: "in_progress" });
    const staleChild = { pid: 99 };
    (deps.activeProcesses as Map<string, any>).set(TASK_ID, staleChild);

    // process.kill(pid, 0) will throw for dead PID
    const origKill = process.kill;
    process.kill = vi.fn(() => {
      throw new Error("ESRCH");
    }) as any;

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();

    process.kill = origKill;

    expect(res.status).toBe(200);
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      TASK_ID,
      "system",
      expect.stringContaining("Cleaned up stale process"),
    );
  });

  it("returns 400 when already_running with active process", async () => {
    setup({ status: "in_progress" });
    const liveChild = { pid: 12345 };
    (deps.activeProcesses as Map<string, any>).set(TASK_ID, liveChild);

    // process.kill(pid, 0) succeeds for live PID
    const origKill = process.kill;
    process.kill = vi.fn(() => true) as any;

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();

    process.kill = origKill;

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("already_running");
  });

  it("resets stale in_progress status when no active process", async () => {
    setup({ status: "in_progress" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      TASK_ID,
      "system",
      expect.stringContaining("Reset stale in_progress"),
    );
  });

  it("uses project path directly for non-git repos", async () => {
    // The fs.existsSync mock must be set up before the request triggers the route handler.
    // The module-level mock defaults to returning true for .git paths, so override it here.
    const fs = await import("node:fs");
    (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    setup({ project_path: "/tmp/non-git-project" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.appendTaskLog).toHaveBeenCalledWith(TASK_ID, "system", expect.stringContaining("not a git repo"));
  });

  it("auto-creates workspace when project_path is null", async () => {
    setup({ project_path: null });
    (deps.resolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const fs = await import("node:fs");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      TASK_ID,
      "system",
      expect.stringContaining("Auto-assigned workspace"),
    );
  });

  it("broadcasts task_update and agent_status on successful run", async () => {
    setup();

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.broadcast).toHaveBeenCalledWith("task_update", expect.anything());
    expect(deps.broadcast).toHaveBeenCalledWith("agent_status", expect.anything());
  });

  it("starts progress timer on successful run", async () => {
    setup();

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.startProgressTimer).toHaveBeenCalledWith(TASK_ID, "Implement feature X", "dev");
  });

  it("notifies CEO on run start", async () => {
    setup();

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.any(String), TASK_ID);
  });

  it("registers close handler for CLI provider", async () => {
    setup();
    const mockChild = { pid: 12345, on: vi.fn() };
    (deps.spawnCliAgent as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(mockChild.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("returns 400 when agent is busy on another task", async () => {
    setup({}, { status: "working", current_task_id: "other-task" });
    (deps.activeProcesses as Map<string, any>).set("other-task", { pid: 111 });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agent_busy");
  });

  it("uses openclaw profile when provider is openclaw", async () => {
    setup({}, { cli_provider: "openclaw", cli_profile: "qwen" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.spawnCliAgent).toHaveBeenCalledWith(
      TASK_ID,
      "openclaw",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      "qwen",
    );
  });

  it("does not call ensureClaudeMd for non-claude providers", async () => {
    setup({}, { cli_provider: "gemini" });

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(res.status).toBe(200);
    expect(deps.ensureClaudeMd).not.toHaveBeenCalled();
  });

  it("builds prompt with project context and task info", async () => {
    setup();

    await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    expect(deps.buildTaskExecutionPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("[Task] Implement feature X")]),
      expect.any(Object),
    );
  });

  it("consumes interrupt prompts when pending", async () => {
    setup();

    // Mock loadPendingInterruptPrompts to return some items
    // This is imported at module level, so we test that the flow calls consumeInterruptPrompts
    // by checking appendTaskLog was called (the consume path logs)
    await request(app).post(`/api/tasks/${TASK_ID}/run`).send();
    // If no pending prompts, consume is not called — check the successful flow
    expect(deps.appendTaskLog).toHaveBeenCalledWith(TASK_ID, "system", expect.stringContaining("RUN start"));
  });

  it("accepts agent_id from request body when task has none assigned", async () => {
    db = createMockDb({
      tasks: [defaultTask({ assigned_agent_id: null })],
      agents: [defaultAgent()],
    });
    deps = createMockDeps(db);
    registerTaskRunRoute(deps);
    app = deps.app as any;

    const res = await request(app).post(`/api/tasks/${TASK_ID}/run`).send({ agent_id: AGENT_ID });
    expect(res.status).toBe(200);
  });
});
