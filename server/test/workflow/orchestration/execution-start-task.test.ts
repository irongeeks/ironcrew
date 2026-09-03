import { describe, it, expect, vi, beforeEach } from "vitest";
import { createExecutionStartTaskTools } from "../../../modules/workflow/orchestration/execution-start-task.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../modules/workflow/packs/department-scope.ts", () => ({
  getDepartmentPromptForPack: vi.fn(() => ""),
}));

vi.mock("../../../modules/workflow/core/video-skill-bootstrap.ts", () => ({
  ensureVideoPreprodRemotionBestPracticesSkill: vi.fn(),
}));

vi.mock("../../../modules/workflow/orchestration/server-allocation.ts", () => ({
  inferRequestedServerType: vi.fn(() => null),
  requestServerAccess: vi.fn(() => ({ state: "skipped" })),
}));

vi.mock("../../../modules/workflow/core/interrupt-injection-tools.ts", () => ({
  buildInterruptPromptBlock: vi.fn(() => ""),
  consumeInterruptPrompts: vi.fn(),
  loadPendingInterruptPrompts: vi.fn(() => []),
}));

vi.mock("../../../modules/routes/docs/index.ts", () => ({
  buildDocsExecutionContextBlock: vi.fn(() => ({ contextBlock: "" })),
}));

vi.mock("../../../modules/workflow/core/mcp-prompt-tools.ts", () => ({
  buildMcpToolsPromptBlock: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

function createMockDb() {
  const store: {
    tasks: MockRow[];
    agents: MockRow[];
  } = {
    tasks: [],
    agents: [],
  };

  return {
    _store: store,

    addTask(row: MockRow) {
      store.tasks.push(row);
    },

    addAgent(row: MockRow) {
      store.agents.push(row);
    },

    prepare(sql: string) {
      const trimmed = sql.trim().toUpperCase();

      return {
        get(...params: unknown[]): MockRow | undefined {
          if (trimmed.includes("FROM TASKS") && trimmed.includes("WHERE ID")) {
            const taskId = params[0] as string;
            return store.tasks.find((t) => t.id === taskId);
          }
          if (trimmed.includes("FROM AGENTS") && trimmed.includes("WHERE ID")) {
            const agentId = params[0] as string;
            return store.agents.find((a) => a.id === agentId);
          }
          return undefined;
        },

        all(): MockRow[] {
          return [];
        },

        run(...params: unknown[]) {
          // UPDATE tasks SET status = 'in_progress'
          if (trimmed.includes("UPDATE TASKS") && trimmed.includes("IN_PROGRESS")) {
            const taskId = params[params.length - 1] as string;
            const task = store.tasks.find((t) => t.id === taskId);
            if (task) {
              task.status = "in_progress";
              task.assigned_agent_id = params[0];
            }
          }
          // UPDATE tasks SET status = 'pending'
          if (trimmed.includes("UPDATE TASKS") && trimmed.includes("PENDING")) {
            const taskId = params[params.length - 1] as string;
            const task = store.tasks.find((t) => t.id === taskId);
            if (task) task.status = "pending";
          }
          // UPDATE agents SET status = 'working'
          if (trimmed.includes("UPDATE AGENTS SET STATUS = 'WORKING'")) {
            const agentId = params[params.length - 1] as string;
            const agent = store.agents.find((a) => a.id === agentId);
            if (agent) {
              agent.status = "working";
              agent.current_task_id = params[0];
            }
          }
          // UPDATE agents SET status = 'idle'
          if (trimmed.includes("UPDATE AGENTS SET STATUS = 'IDLE'")) {
            const agentId = params[params.length - 1] as string;
            const agent = store.agents.find((a) => a.id === agentId);
            if (agent) {
              agent.status = "idle";
            }
          }
          // UPDATE tasks SET project_path
          if (trimmed.includes("UPDATE TASKS SET PROJECT_PATH")) {
            const taskId = params[params.length - 1] as string;
            const task = store.tasks.find((t) => t.id === taskId);
            if (task) task.project_path = params[0];
          }
          return { changes: 1 };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(dbOverride?: ReturnType<typeof createMockDb>) {
  const db = dbOverride ?? createMockDb();

  const mockChild = {
    on: vi.fn(),
    pid: 12345,
  };

  return {
    db: db as any,
    nowMs: () => Date.now(),
    logsDir: "/tmp/test-logs",
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    ensureTaskExecutionSession: vi.fn(() => ({
      sessionId: "session-1",
      taskId: "task-1",
      agentId: "agent-1",
      provider: "claude",
      openedAt: Date.now(),
      lastTouchedAt: Date.now(),
    })),
    resolveLang: vi.fn(() => "en" as const),
    notifyTaskStatus: vi.fn(),
    resolveProjectPath: vi.fn(() => "/tmp/project"),
    createWorktree: vi.fn(() => "/tmp/worktree"),
    getDeptRoleConstraint: vi.fn(() => ""),
    getRecentConversationContext: vi.fn(() => ""),
    getTaskContinuationContext: vi.fn(() => ""),
    getRecentChanges: vi.fn(() => ""),
    ensureClaudeMd: vi.fn(),
    pickL: ((pool: any, lang: any) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "") as any,
    l: ((ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => ({
      ko,
      en,
      ja: ja ?? [],
      zh: zh ?? [],
      de: de ?? [],
    })) as any,
    buildAvailableSkillsPromptBlock: vi.fn(() => ""),
    buildTaskExecutionPrompt: vi.fn((_parts: (string | null | undefined)[]) => "mock prompt"),
    hasExplicitWarningFixRequest: vi.fn(() => false),
    getNextHttpAgentPid: vi.fn(() => 99),
    launchApiProviderAgent: vi.fn(),
    launchHttpAgent: vi.fn(),
    getProviderModelConfig: vi.fn(() => ({})),
    spawnCliAgent: vi.fn(() => mockChild) as any,
    handleTaskRunComplete: vi.fn(),
    notifyCeo: vi.fn(),
    startProgressTimer: vi.fn(),
    mcpManager: undefined,
    _mockChild: mockChild,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExecutionStartTaskTools", () => {
  it("returns startTaskExecutionForAgent function", () => {
    const deps = createMockDeps();
    const tools = createExecutionStartTaskTools(deps);
    expect(typeof tools.startTaskExecutionForAgent).toBe("function");
  });
});

describe("startTaskExecutionForAgent", () => {
  let db: ReturnType<typeof createMockDb>;
  let deps: ReturnType<typeof createMockDeps>;
  let tools: ReturnType<typeof createExecutionStartTaskTools>;

  const mockAgent = {
    id: "agent-1",
    name: "TestAgent",
    name_ko: "테스트에이전트",
    role: "senior",
    personality: "Focused and efficient",
    cli_provider: "claude",
    cli_model: null,
    cli_reasoning_level: null,
    cli_profile: null,
    api_provider_id: null,
    api_model: null,
    oauth_account_id: null,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createMockDb();
    deps = createMockDeps(db);
    tools = createExecutionStartTaskTools(deps);

    db.addTask({
      id: "task-1",
      title: "Test Task",
      description: "A test task",
      status: "planned",
      assigned_agent_id: null,
      department_id: "dept-1",
      project_id: "proj-1",
      project_path: "/tmp/project",
      base_branch: null,
      workflow_pack_key: null,
      task_type: null,
      workflow_meta_json: null,
    });
    db.addAgent({ id: "agent-1", status: "idle", current_task_id: null });
  });

  it("updates task to in_progress and agent to working", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    const task = db._store.tasks.find((t) => t.id === "task-1");
    expect(task?.status).toBe("in_progress");
    expect(task?.assigned_agent_id).toBe("agent-1");

    const agent = db._store.agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("working");
  });

  it("logs agent start", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", "테스트에이전트 started (approved)");
  });

  it("broadcasts task and agent status updates", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.broadcast).toHaveBeenCalledWith("task_update", expect.anything());
    expect(deps.broadcast).toHaveBeenCalledWith("agent_status", expect.anything());
  });

  it("creates task execution session", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.ensureTaskExecutionSession).toHaveBeenCalledWith("task-1", "agent-1", "claude");
  });

  it("spawns CLI agent for claude provider", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.spawnCliAgent).toHaveBeenCalledWith(
      "task-1",
      "claude",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      undefined,
    );
  });

  it("registers close handler on spawned child process", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps._mockChild.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("notifies CEO about task start", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("started work on"), "task-1");
  });

  it("starts progress timer", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.startProgressTimer).toHaveBeenCalledWith("task-1", "Test Task", "dept-1");
  });

  it("notifies task status as in_progress", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.notifyTaskStatus).toHaveBeenCalledWith("task-1", "Test Task", "in_progress", "en");
  });

  it("does nothing for unsupported provider", () => {
    const unsupportedAgent = { ...mockAgent, cli_provider: "unsupported_provider" };

    tools.startTaskExecutionForAgent("task-1", unsupportedAgent, "dept-1", "Engineering");

    expect(deps.spawnCliAgent).not.toHaveBeenCalled();
    expect(deps.launchApiProviderAgent).not.toHaveBeenCalled();
    expect(deps.launchHttpAgent).not.toHaveBeenCalled();
  });

  it("launches API provider agent for 'api' provider", () => {
    const apiAgent = { ...mockAgent, cli_provider: "api", api_provider_id: "prov-1", api_model: "gpt-4" };

    tools.startTaskExecutionForAgent("task-1", apiAgent, "dept-1", "Engineering");

    expect(deps.launchApiProviderAgent).toHaveBeenCalledWith(
      "task-1",
      "prov-1",
      "gpt-4",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.anything(),
      99,
    );
  });

  it("launches HTTP agent for copilot provider", () => {
    const copilotAgent = { ...mockAgent, cli_provider: "copilot", oauth_account_id: "oauth-1" };

    tools.startTaskExecutionForAgent("task-1", copilotAgent, "dept-1", "Engineering");

    expect(deps.launchHttpAgent).toHaveBeenCalledWith(
      "task-1",
      "copilot",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.anything(),
      99,
      "oauth-1",
    );
  });

  it("launches HTTP agent for antigravity provider", () => {
    const agAgent = { ...mockAgent, cli_provider: "antigravity" };

    tools.startTaskExecutionForAgent("task-1", agAgent, "dept-1", "Engineering");

    expect(deps.launchHttpAgent).toHaveBeenCalled();
  });

  it("rolls back to pending when server access is queued", async () => {
    const { requestServerAccess } = await import("../../../modules/workflow/orchestration/server-allocation.ts");
    vi.mocked(requestServerAccess).mockReturnValue({
      state: "queued",
      allocation_id: "alloc-1",
      queue_position: 2,
      requested_server_type: "comfyui",
    });

    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    const task = db._store.tasks.find((t) => t.id === "task-1");
    expect(task?.status).toBe("pending");
    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", expect.stringContaining("Server queued"));
    expect(deps.spawnCliAgent).not.toHaveBeenCalled();
  });

  it("logs server allocation when allocated", async () => {
    const { requestServerAccess } = await import("../../../modules/workflow/orchestration/server-allocation.ts");
    vi.mocked(requestServerAccess).mockReturnValue({
      state: "allocated",
      allocation_id: "alloc-1",
      server_id: "server-1",
      requested_server_type: "comfyui",
    });

    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", expect.stringContaining("Server allocated"));
    expect(deps.broadcast).toHaveBeenCalledWith(
      "server_update",
      expect.objectContaining({ action: "allocation_activated" }),
    );
  });

  it("rolls back to pending when worktree creation fails", () => {
    deps.createWorktree.mockReturnValue(null as unknown as string);

    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    const task = db._store.tasks.find((t) => t.id === "task-1");
    expect(task?.status).toBe("pending");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "error",
      expect.stringContaining("Execution blocked: isolated worktree creation failed"),
    );
    expect(deps.spawnCliAgent).not.toHaveBeenCalled();
  });

  it("calls ensureClaudeMd for claude provider", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.ensureClaudeMd).toHaveBeenCalled();
  });

  it("does not call ensureClaudeMd for non-claude provider", () => {
    const geminiAgent = { ...mockAgent, cli_provider: "gemini" };

    tools.startTaskExecutionForAgent("task-1", geminiAgent, "dept-1", "Engineering");

    expect(deps.ensureClaudeMd).not.toHaveBeenCalled();
  });

  it("builds task execution prompt", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(deps.buildTaskExecutionPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("Test Task")]),
      expect.objectContaining({ allowWarningFix: false }),
    );
  });

  it("uses agent name (not name_ko) for english display when name_ko is used for start log", () => {
    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    // The start log uses name_ko
    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", "테스트에이전트 started (approved)");
    // The RUN start log uses the base name
    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", expect.stringContaining("RUN start"));
  });

  it("consumes pending interrupt prompts when present", async () => {
    const { loadPendingInterruptPrompts, consumeInterruptPrompts } =
      await import("../../../modules/workflow/core/interrupt-injection-tools.ts");
    vi.mocked(loadPendingInterruptPrompts).mockReturnValue([
      { id: "int-1", prompt: "Fix the bug", task_id: "task-1", session_id: "session-1", created_at: 100 },
    ] as any);

    tools.startTaskExecutionForAgent("task-1", mockAgent, "dept-1", "Engineering");

    expect(consumeInterruptPrompts).toHaveBeenCalledWith(expect.anything(), ["int-1"], expect.any(Number));
    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", expect.stringContaining("INJECT consumed (1)"));
  });
});
