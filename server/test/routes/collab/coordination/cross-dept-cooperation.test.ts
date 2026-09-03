import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCrossDeptCooperationTools } from "../../../../modules/routes/collab/coordination/cross-dept-cooperation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  cli_profile: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
}

function makeAgent(overrides: Partial<MockAgent> = {}): MockAgent {
  return {
    id: "agent-leader-1",
    name: "Alice",
    name_ko: "앨리스",
    role: "team_leader",
    personality: null,
    status: "idle",
    department_id: "dev",
    current_task_id: null,
    avatar_emoji: "👩",
    cli_provider: "claude",
    cli_model: null,
    cli_reasoning_level: null,
    cli_profile: null,
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../../modules/workflow/packs/department-scope.ts", () => ({
  getDepartmentPromptForPack: () => "",
}));

vi.mock("../../../../modules/workflow/packs/task-pack-resolver.ts", () => ({
  resolveWorkflowPackKeyForTask: () => null,
}));

const mockResolveConstrainedAgentScope = vi.fn().mockReturnValue(null);
vi.mock("../../../../modules/routes/core/tasks/execution-run-auto-assign.ts", () => ({
  resolveConstrainedAgentScopeForTask: (...args: unknown[]) => mockResolveConstrainedAgentScope(...args),
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface PreparedStmt {
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => void;
  all: (...args: unknown[]) => unknown[];
}

interface MockDb {
  store: {
    tasks: Record<string, Record<string, unknown>>;
    agents: Record<string, Record<string, unknown>>;
    subtasks: Record<string, Record<string, unknown>>;
  };
  prepare(sql: string): PreparedStmt;
}

function createMockDb(seedData?: {
  tasks?: Record<string, Record<string, unknown>>;
  agents?: Record<string, Record<string, unknown>>;
  subtasks?: Array<Record<string, unknown>>;
}): MockDb {
  const store: MockDb["store"] = {
    tasks: { ...(seedData?.tasks ?? {}) },
    agents: { ...(seedData?.agents ?? {}) },
    subtasks: {},
  };

  // Index subtasks by task_id for easy lookup
  const subtasksByTaskId = new Map<string, Array<Record<string, unknown>>>();
  for (const st of seedData?.subtasks ?? []) {
    const tid = st.task_id as string;
    if (!subtasksByTaskId.has(tid)) subtasksByTaskId.set(tid, []);
    subtasksByTaskId.get(tid)!.push(st);
  }

  // Track child tasks by source_task_id
  const childTasksBySource = new Map<string, Array<Record<string, unknown>>>();

  return {
    store,
    prepare(sql: string): PreparedStmt {
      const upper = sql.trim().toUpperCase();

      // INSERT INTO TASKS
      if (upper.startsWith("INSERT INTO TASKS")) {
        return {
          get: () => null,
          all: () => [],
          run: (...args: unknown[]) => {
            const id = args[0] as string;
            const task: Record<string, unknown> = {
              id,
              title: args[1],
              description: args[2],
              department_id: args[3],
              assigned_agent_id: args[4],
              project_id: args[5],
              status: "planned",
              priority: 1,
              task_type: "general",
              workflow_pack_key: args[6],
              project_path: args[7],
              source_task_id: args[8],
              created_at: args[9],
              updated_at: args[10],
            };
            store.tasks[id] = task;
            // Track child->parent
            const sourceId = args[8] as string | null;
            if (sourceId) {
              if (!childTasksBySource.has(sourceId)) childTasksBySource.set(sourceId, []);
              childTasksBySource.get(sourceId)!.push(task);
            }
          },
        };
      }

      // SELECT source_task_id FROM tasks
      if (upper.includes("SELECT SOURCE_TASK_ID FROM TASKS")) {
        return {
          get: (id: unknown) => {
            const t = store.tasks[id as string];
            return t ? { source_task_id: t.source_task_id ?? null } : undefined;
          },
          run: () => {},
          all: () => [],
        };
      }

      // SELECT with project_id, project_path, workflow_pack_key
      if (upper.includes("PROJECT_ID") && upper.includes("PROJECT_PATH") && upper.includes("WORKFLOW_PACK_KEY")) {
        return {
          get: (id: unknown) => {
            const t = store.tasks[id as string];
            return t
              ? {
                  project_id: t.project_id ?? null,
                  project_path: t.project_path ?? null,
                  workflow_pack_key: t.workflow_pack_key ?? null,
                }
              : undefined;
          },
          run: () => {},
          all: () => [],
        };
      }

      // SELECT * FROM tasks WHERE id
      if (upper.startsWith("SELECT * FROM TASKS WHERE ID")) {
        return {
          get: (id: unknown) => store.tasks[id as string] ?? null,
          run: () => {},
          all: () => [],
        };
      }

      // SELECT ... FROM tasks WHERE id (various field subsets)
      if (upper.includes("FROM TASKS") && upper.includes("WHERE ID") && upper.includes("SELECT")) {
        return {
          get: (id: unknown) => {
            const t = store.tasks[id as string];
            return t ?? undefined;
          },
          run: () => {},
          all: () => [],
        };
      }

      // SELECT ... FROM tasks WHERE source_task_id ... status IN (active)
      if (upper.includes("SOURCE_TASK_ID") && upper.includes("STATUS IN")) {
        if (upper.includes("'DONE'")) {
          // Done children
          return {
            get: () => null,
            run: () => {},
            all: (parentId: unknown) => {
              const children = childTasksBySource.get(parentId as string) ?? [];
              return children.filter((c) => c.status === "done").map((c) => ({ department_id: c.department_id }));
            },
          };
        }
        // Active siblings check
        return {
          get: (parentId: unknown) => {
            const children = childTasksBySource.get(parentId as string) ?? [];
            const active = children.find((c) =>
              ["planned", "pending", "collaborating", "in_progress", "review"].includes(c.status as string),
            );
            return active ? { "1": 1 } : undefined;
          },
          run: () => {},
          all: () => [],
        };
      }

      // SELECT target_department_id FROM subtasks
      if (upper.includes("TARGET_DEPARTMENT_ID") && upper.includes("SUBTASKS")) {
        return {
          get: () => null,
          run: () => {},
          all: (parentId: unknown) => {
            const sts = subtasksByTaskId.get(parentId as string) ?? [];
            return sts
              .filter((s) => s.target_department_id)
              .map((s) => ({ target_department_id: s.target_department_id }));
          },
        };
      }

      // UPDATE tasks
      if (upper.startsWith("UPDATE TASKS")) {
        return {
          get: () => null,
          all: () => [],
          run: (...args: unknown[]) => {
            const taskId = args[args.length - 1] as string;
            const task = store.tasks[taskId];
            if (!task) return;
            if (upper.includes("ASSIGNED_AGENT_ID") && upper.includes("STATUS = 'PLANNED'")) {
              task.assigned_agent_id = args[0];
              task.status = "planned";
            } else if (upper.includes("ASSIGNED_AGENT_ID") && upper.includes("STATUS = 'IN_PROGRESS'")) {
              task.assigned_agent_id = args[0];
              task.status = "in_progress";
              task.started_at = args[1];
            } else if (upper.includes("STATUS = 'COLLABORATING'")) {
              task.status = "collaborating";
            }
            task.updated_at = Date.now();
          },
        };
      }

      // UPDATE agents
      if (upper.startsWith("UPDATE AGENTS")) {
        return {
          get: () => null,
          all: () => [],
          run: () => {},
        };
      }

      // UPDATE projects
      if (upper.startsWith("UPDATE PROJECTS")) {
        return {
          get: () => null,
          all: () => [],
          run: () => {},
        };
      }

      // SELECT * FROM agents
      if (upper.includes("FROM AGENTS")) {
        return {
          get: (id: unknown) => store.agents[id as string] ?? null,
          run: () => {},
          all: (..._args: unknown[]) => {
            // For pickManualPoolAgent: return agents matching given IDs
            return Object.values(store.agents);
          },
        };
      }

      // Fallback
      return {
        get: () => null,
        run: () => {},
        all: () => [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

function createDefaultDeps(dbOverride?: MockDb) {
  const db = dbOverride ?? createMockDb();
  const crossDeptNextCallbacks = new Map<string, () => void>();
  const delegatedTaskToSubtask = new Map<string, string>();

  return {
    db,
    nowMs: () => 1000000,
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    recordTaskCreationAudit: vi.fn(),
    delegatedTaskToSubtask,
    crossDeptNextCallbacks,
    findTeamLeader: vi.fn((_deptId: string, _candidates?: string[] | null) => null as MockAgent | null),
    findBestSubordinate: vi.fn(
      (_deptId: string, _excludeId: string, _candidates?: string[] | null) => null as MockAgent | null,
    ),
    resolveLang: () => "en" as const,
    getDeptName: (id: string) => `Dept:${id}`,
    getAgentDisplayName: (agent: MockAgent, lang: string) => (lang === "ko" ? agent.name_ko || agent.name : agent.name),
    sendAgentMessage: vi.fn(),
    notifyCeo: vi.fn(),
    l: (ko: string[], en: string[], ja: string[] = [], zh: string[] = []) => ({ ko, en, ja, zh, de: [] }),
    pickL: (_pool: unknown, _lang: unknown) => {
      const p = _pool as Record<string, string[]>;
      const lang = _lang as string;
      return p[lang]?.[0] ?? p.en?.[0] ?? "";
    },
    startTaskExecutionForAgent: vi.fn(),
    linkCrossDeptTaskToParentSubtask: vi.fn(() => null as string | null),
    detectProjectPath: vi.fn(() => "/test/project"),
    resolveProjectPath: vi.fn(() => "/test/project"),
    logsDir: "/tmp/test-logs",
    getDeptRoleConstraint: vi.fn(() => ""),
    getRecentConversationContext: vi.fn(() => ""),
    buildAvailableSkillsPromptBlock: vi.fn(() => ""),
    buildTaskExecutionPrompt: vi.fn((..._args: unknown[]) => "test prompt"),
    hasExplicitWarningFixRequest: vi.fn(() => false),
    ensureTaskExecutionSession: vi.fn(() => ({
      sessionId: "session-1",
      agentId: "agent-1",
      provider: "claude",
    })),
    getProviderModelConfig: vi.fn(() => ({})),
    spawnCliAgent: vi.fn(() => {
      // Return a fake child process with an `on` method
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
        },
        _emit: (event: string, ...args: unknown[]) => {
          for (const h of handlers[event] ?? []) h(...args);
        },
      };
    }),
    handleSubtaskDelegationComplete: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    startProgressTimer: vi.fn(),
  };
}

function createMockDeps(overrides?: Partial<ReturnType<typeof createDefaultDeps>>, dbOverride?: MockDb) {
  const base = createDefaultDeps(dbOverride);
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCrossDeptCooperationTools", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockResolveConstrainedAgentScope.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // startCrossDeptCooperation
  // =========================================================================

  describe("startCrossDeptCooperation", () => {
    it("calls onAllDone immediately when index is past the end of deptIds", () => {
      const deps = createMockDeps();
      const tools = createCrossDeptCooperationTools(deps as any);
      const onAllDone = vi.fn();

      tools.startCrossDeptCooperation(["design", "qa"], 2, makeCrossDeptContext(), onAllDone);

      expect(onAllDone).toHaveBeenCalledOnce();
      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
    });

    it("calls onAllDone when deptIds is empty", () => {
      const deps = createMockDeps();
      const tools = createCrossDeptCooperationTools(deps as any);
      const onAllDone = vi.fn();

      tools.startCrossDeptCooperation([], 0, makeCrossDeptContext(), onAllDone);

      expect(onAllDone).toHaveBeenCalledOnce();
    });

    it("skips a department when no team leader is found and proceeds to next", () => {
      const designLeader = makeAgent({ id: "design-lead", name: "Dana", name_ko: "다나", department_id: "design" });
      const deps = createMockDeps({
        findTeamLeader: vi.fn((deptId: string) => {
          if (deptId === "qa") return null;
          if (deptId === "design") return designLeader as any;
          return null;
        }),
      });
      const tools = createCrossDeptCooperationTools(deps as any);
      const onAllDone = vi.fn();

      // Try qa first (no leader), then design (has leader)
      tools.startCrossDeptCooperation(["qa", "design"], 0, makeCrossDeptContext(), onAllDone);

      // qa was skipped, design should proceed => sendAgentMessage is called for design
      expect(deps.sendAgentMessage).toHaveBeenCalled();
      const firstCall = (deps.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      // The cooperation message mentions Dana or the cross dept
      expect(firstCall).toBeDefined();
    });

    it("sends a cooperation request message from the team leader to the cross-dept coordinator", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const deps = createMockDeps({
        findTeamLeader: vi.fn(() => crossLeader as any),
      });
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext();

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      // Cooperation request sent
      expect(deps.sendAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: ctx.teamLeader.id }),
        expect.any(String),
        "chat",
        "agent",
        // recipient is crossCoordinator if different from teamLeader, else null
        expect.anything(),
        ctx.taskId,
      );
    });

    it("broadcasts cross_dept_delivery event for UI animation", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const deps = createMockDeps({
        findTeamLeader: vi.fn(() => crossLeader as any),
      });
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext();

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      expect(deps.broadcast).toHaveBeenCalledWith("cross_dept_delivery", {
        from_agent_id: ctx.teamLeader.id,
        to_agent_id: crossLeader.id,
        task_title: ctx.taskTitle,
      });
    });

    it("notifies CEO about queue progress when multiple departments are involved", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const deps = createMockDeps({
        findTeamLeader: vi.fn(() => crossLeader as any),
      });
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext();

      tools.startCrossDeptCooperation(["qa", "design"], 0, ctx);

      expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Dept:qa"), ctx.taskId);
    });

    it("does not notify CEO about queue when there is only one department", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const deps = createMockDeps({
        findTeamLeader: vi.fn(() => crossLeader as any),
      });
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext();

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      // notifyCeo should not be called for queue progress (only for agent start later)
      expect(deps.notifyCeo).not.toHaveBeenCalled();
    });

    it("creates a cross-dept task and spawns CLI agent after acknowledgement delay", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build the feature",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      // Advance past crossAckDelay (1500 + up to 1000ms)
      vi.advanceTimersByTime(3000);

      // A new cross-dept task should have been created
      const taskIds = Object.keys(db.store.tasks).filter((id) => id !== "parent-task-1");
      expect(taskIds).toHaveLength(1);

      const crossTask = db.store.tasks[taskIds[0]];
      expect(crossTask.department_id).toBe("qa");
      expect(crossTask.source_task_id).toBe("parent-task-1");
      expect(crossTask.title as string).toContain("[Collaboration]");
      expect(crossTask.description as string).toContain("[Cross-dept from Dept:dev]");

      // Should have recorded the audit
      expect(deps.recordTaskCreationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "workflow.cross_dept_cooperation",
          triggerDetail: expect.stringContaining("from_dept=dev"),
        }),
      );

      // Should spawn CLI agent
      expect(deps.spawnCliAgent).toHaveBeenCalled();

      // Should notify CEO about the agent starting
      expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Quinn"), expect.any(String));

      // Should start progress timer
      expect(deps.startProgressTimer).toHaveBeenCalled();
    });

    it("registers a callback for the next department when more departments remain", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa", "design"], 0, ctx);

      // Advance past crossAckDelay
      vi.advanceTimersByTime(3000);

      // The crossDeptNextCallbacks map should have an entry for the cross-task
      expect(deps.crossDeptNextCallbacks.size).toBe(1);
    });

    it("registers onAllDone callback for the last department in queue", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const onAllDone = vi.fn();
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx, onAllDone);

      // Advance past crossAckDelay
      vi.advanceTimersByTime(3000);

      // Callback registered for the single cross-task
      expect(deps.crossDeptNextCallbacks.size).toBe(1);

      // Trigger the callback (simulating task completion)
      const cb = [...deps.crossDeptNextCallbacks.values()][0];
      cb();

      // Advance past the onAllDone delay
      vi.advanceTimersByTime(3000);

      expect(onAllDone).toHaveBeenCalledOnce();
    });

    it("logs error and skips CLI spawn when no project path is resolved", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          resolveProjectPath: vi.fn((): string | null => null),
          detectProjectPath: vi.fn((): string | null => null),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Task was created but CLI was not spawned
      expect(deps.spawnCliAgent).not.toHaveBeenCalled();
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        expect.stringContaining("no project path"),
      );
    });

    it("delegates to subordinate if one is available in the cross department", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const crossSub = makeAgent({
        id: "qa-sub-1",
        name: "Sam",
        name_ko: "샘",
        role: "senior",
        department_id: "qa",
      });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          findBestSubordinate: vi.fn(() => crossSub as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // The spawned agent should be the subordinate, not the leader
      const spawnCalls = (deps.spawnCliAgent as ReturnType<typeof vi.fn>).mock.calls;
      expect(spawnCalls.length).toBe(1);

      // Check that the cross-task was assigned to the subordinate
      const crossTaskId = Object.keys(db.store.tasks).find((id) => id !== "parent-task-1")!;
      const crossTask = db.store.tasks[crossTaskId];
      expect(crossTask.assigned_agent_id).toBe("qa-sub-1");
    });

    it("sends an acknowledgement message where coordinator delegates to someone else", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const crossSub = makeAgent({
        id: "qa-sub-1",
        name: "Sam",
        name_ko: "샘",
        role: "senior",
        department_id: "qa",
      });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          findBestSubordinate: vi.fn(() => crossSub as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Second sendAgentMessage call should be the ack from cross coordinator
      const msgCalls = (deps.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls;
      // First call: cooperation request, second call: ack message
      expect(msgCalls.length).toBeGreaterThanOrEqual(2);
      const ackCall = msgCalls[1];
      expect(ackCall[0]).toEqual(expect.objectContaining({ id: crossLeader.id }));
      // Ack message should mention Sam (the subordinate)
      expect(ackCall[1]).toContain("Sam");
    });

    it("handles unsupported CLI provider by not spawning", () => {
      const crossLeader = makeAgent({
        id: "qa-lead",
        name: "Quinn",
        name_ko: "퀸",
        department_id: "qa",
        cli_provider: "unsupported_provider",
      });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Task created but CLI not spawned for unsupported provider
      expect(deps.spawnCliAgent).not.toHaveBeenCalled();
    });

    it("links cross-dept task to parent subtask when linkage exists", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          linkCrossDeptTaskToParentSubtask: vi.fn(() => "subtask-linked-1"),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Should have set the delegated task mapping
      const crossTaskId = Object.keys(db.store.tasks).find((id) => id !== "parent-task-1")!;
      expect(deps.delegatedTaskToSubtask.get(crossTaskId)).toBe("subtask-linked-1");
    });

    it("calls handleSubtaskDelegationComplete on CLI close when subtask is linked", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      let fakeChild: {
        on: (e: string, h: (...a: unknown[]) => void) => void;
        _emit: (e: string, ...a: unknown[]) => void;
      };
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          linkCrossDeptTaskToParentSubtask: vi.fn(() => "subtask-linked-1"),
          spawnCliAgent: vi.fn(() => {
            const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
            fakeChild = {
              on: (event: string, handler: (...args: unknown[]) => void) => {
                if (!handlers[event]) handlers[event] = [];
                handlers[event].push(handler);
              },
              _emit: (event: string, ...args: unknown[]) => {
                for (const h of handlers[event] ?? []) h(...args);
              },
            };
            return fakeChild;
          }),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Simulate CLI process close
      fakeChild!._emit("close", 0);

      const crossTaskId = Object.keys(db.store.tasks).find((id) => id !== "parent-task-1")!;
      expect(deps.handleSubtaskDelegationComplete).toHaveBeenCalledWith(crossTaskId, "subtask-linked-1", 0);
      expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
    });

    it("calls handleTaskRunComplete on CLI close when no subtask is linked", () => {
      const crossLeader = makeAgent({ id: "qa-lead", name: "Quinn", name_ko: "퀸", department_id: "qa" });
      const db = createMockDb({
        tasks: {
          "parent-task-1": {
            id: "parent-task-1",
            title: "Test Task",
            description: "[CEO] Build it",
            department_id: "dev",
            project_id: null,
            project_path: "/test/project",
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
        },
      });
      let fakeChild: {
        on: (e: string, h: (...a: unknown[]) => void) => void;
        _emit: (e: string, ...a: unknown[]) => void;
      };
      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => crossLeader as any),
          linkCrossDeptTaskToParentSubtask: vi.fn(() => null),
          spawnCliAgent: vi.fn(() => {
            const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
            fakeChild = {
              on: (event: string, handler: (...args: unknown[]) => void) => {
                if (!handlers[event]) handlers[event] = [];
                handlers[event].push(handler);
              },
              _emit: (event: string, ...args: unknown[]) => {
                for (const h of handlers[event] ?? []) h(...args);
              },
            };
            return fakeChild;
          }),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);
      const ctx = makeCrossDeptContext({ taskId: "parent-task-1" });

      tools.startCrossDeptCooperation(["qa"], 0, ctx);

      vi.advanceTimersByTime(3000);

      // Simulate CLI process close
      fakeChild!._emit("close", 1);

      const crossTaskId = Object.keys(db.store.tasks).find((id) => id !== "parent-task-1")!;
      expect(deps.handleTaskRunComplete).toHaveBeenCalledWith(crossTaskId, 1);
      expect(deps.handleSubtaskDelegationComplete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // recoverCrossDeptQueueAfterMissingCallback
  // =========================================================================

  describe("recoverCrossDeptQueueAfterMissingCallback", () => {
    it("does nothing when child task has no source_task_id", () => {
      const db = createMockDb({
        tasks: {
          "child-1": {
            id: "child-1",
            source_task_id: null,
            status: "done",
            department_id: "qa",
          },
        },
      });
      const deps = createMockDeps({}, db);
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
      expect(deps.broadcast).not.toHaveBeenCalled();
    });

    it("does nothing when child task does not exist", () => {
      const db = createMockDb();
      const deps = createMockDeps({}, db);
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("nonexistent");

      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
    });

    it("does nothing when parent task is not in collaborating status", () => {
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent",
            description: "desc",
            department_id: "dev",
            project_id: null,
            workflow_pack_key: null,
            status: "done",
            assigned_agent_id: null,
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
        },
      });
      const deps = createMockDeps({}, db);
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
    });

    it("does nothing when parent has no department_id", () => {
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent",
            description: "desc",
            department_id: null,
            project_id: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
        },
      });
      const deps = createMockDeps({}, db);
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
    });

    it("does nothing when there are still active sibling tasks", () => {
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent",
            description: "desc",
            department_id: "dev",
            project_id: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
          "child-2": {
            id: "child-2",
            source_task_id: "parent-1",
            status: "in_progress",
            department_id: "design",
          },
        },
      });

      // Need to handle the activeSibling query
      const originalPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string) {
        const upper = sql.trim().toUpperCase();
        if (upper.includes("SOURCE_TASK_ID") && upper.includes("STATUS IN") && !upper.includes("'DONE'")) {
          return {
            get: () => ({ "1": 1 }), // Active sibling exists
            run: () => {},
            all: () => [],
          };
        }
        return originalPrepare(sql);
      };

      const deps = createMockDeps({}, db);
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    });

    it("does nothing when no team leader can be found for parent department", () => {
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent",
            description: "desc",
            department_id: "dev",
            project_id: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
        },
        subtasks: [{ task_id: "parent-1", target_department_id: "qa", created_at: 100 }],
      });

      // Override to handle the active sibling query returning null (no active siblings)
      const originalPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string) {
        const upper = sql.trim().toUpperCase();
        if (
          upper.includes("SOURCE_TASK_ID") &&
          upper.includes("STATUS IN") &&
          !upper.includes("'DONE'") &&
          upper.includes("LIMIT 1")
        ) {
          return {
            get: () => undefined, // No active siblings
            run: () => {},
            all: () => [],
          };
        }
        if (upper.includes("SOURCE_TASK_ID") && upper.includes("STATUS") && upper.includes("'DONE'")) {
          return {
            get: () => null,
            run: () => {},
            all: () => [{ department_id: "qa" }],
          };
        }
        return originalPrepare(sql);
      };

      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => null),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
      expect(deps.sendAgentMessage).not.toHaveBeenCalled();
    });

    it("delegates main task when all cross-dept tasks are done (no remaining)", () => {
      const leader = makeAgent({ id: "dev-lead", name: "Alice", name_ko: "앨리스", department_id: "dev" });
      const sub = makeAgent({ id: "dev-sub", name: "Bob", name_ko: "밥", role: "senior", department_id: "dev" });
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent Task",
            description: "desc",
            department_id: "dev",
            project_id: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: null,
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
        },
        subtasks: [{ task_id: "parent-1", target_department_id: "qa", created_at: 100 }],
      });

      // Override for specific queries
      const originalPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string) {
        const upper = sql.trim().toUpperCase();
        if (
          upper.includes("SOURCE_TASK_ID") &&
          upper.includes("STATUS IN") &&
          !upper.includes("'DONE'") &&
          upper.includes("LIMIT 1")
        ) {
          return {
            get: () => undefined,
            run: () => {},
            all: () => [],
          };
        }
        if (upper.includes("SOURCE_TASK_ID") && upper.includes("'DONE'") && upper.includes("DEPARTMENT_ID")) {
          return {
            get: () => null,
            run: () => {},
            all: () => [{ department_id: "qa" }],
          };
        }
        return originalPrepare(sql);
      };

      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => leader as any),
          findBestSubordinate: vi.fn(() => sub as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      // All depts done => nextIndex === -1 => delegateMainTask is called
      expect(deps.broadcast).toHaveBeenCalledWith("task_update", expect.anything());
      // agent_status is broadcast with db lookup result (null in mock since agents aren't seeded)
      expect(deps.broadcast).toHaveBeenCalledWith("agent_status", null);
      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
        "parent-1",
        expect.objectContaining({ id: "dev-sub" }),
        "dev",
        "Dept:dev",
      );

      // Parent task should now be planned
      expect(db.store.tasks["parent-1"].status).toBe("planned");
      expect(db.store.tasks["parent-1"].assigned_agent_id).toBe("dev-sub");
    });

    it("does not delegate main task when it already has an assigned agent", () => {
      const leader = makeAgent({ id: "dev-lead", name: "Alice", name_ko: "앨리스", department_id: "dev" });
      const db = createMockDb({
        tasks: {
          "parent-1": {
            id: "parent-1",
            title: "Parent Task",
            description: "desc",
            department_id: "dev",
            project_id: null,
            workflow_pack_key: null,
            status: "collaborating",
            assigned_agent_id: "already-assigned",
            started_at: null,
          },
          "child-1": {
            id: "child-1",
            source_task_id: "parent-1",
            status: "done",
            department_id: "qa",
          },
        },
        subtasks: [{ task_id: "parent-1", target_department_id: "qa", created_at: 100 }],
      });

      const originalPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string) {
        const upper = sql.trim().toUpperCase();
        if (
          upper.includes("SOURCE_TASK_ID") &&
          upper.includes("STATUS IN") &&
          !upper.includes("'DONE'") &&
          upper.includes("LIMIT 1")
        ) {
          return {
            get: () => undefined,
            run: () => {},
            all: () => [],
          };
        }
        if (upper.includes("SOURCE_TASK_ID") && upper.includes("'DONE'") && upper.includes("DEPARTMENT_ID")) {
          return {
            get: () => null,
            run: () => {},
            all: () => [{ department_id: "qa" }],
          };
        }
        return originalPrepare(sql);
      };

      const deps = createMockDeps(
        {
          findTeamLeader: vi.fn(() => leader as any),
        },
        db,
      );
      const tools = createCrossDeptCooperationTools(deps as any);

      tools.recoverCrossDeptQueueAfterMissingCallback("child-1");

      // delegateMainTask is called but bails because assigned_agent_id is set
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCrossDeptContext(
  overrides: Partial<{
    teamLeader: MockAgent;
    taskTitle: string;
    ceoMessage: string;
    leaderDeptId: string;
    leaderDeptName: string;
    leaderName: string;
    lang: "ko" | "en" | "ja" | "zh" | "de";
    taskId: string;
    projectId: string | null;
    projectCandidateAgentIds: string[] | null;
  }> = {},
) {
  return {
    teamLeader: makeAgent(),
    taskTitle: "Test Task",
    ceoMessage: "Build the feature",
    leaderDeptId: "dev",
    leaderDeptName: "Dept:dev",
    leaderName: "Alice",
    lang: "en" as const,
    taskId: "parent-task-1",
    projectId: null,
    projectCandidateAgentIds: null,
    ...overrides,
  };
}
