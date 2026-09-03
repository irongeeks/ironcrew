import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskDelegationHandler } from "../../../modules/routes/collab/task-delegation.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    acts_as_planning_leader: 0,
    ...overrides,
  };
}

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
  acts_as_planning_leader?: number;
}

interface PreparedStmt {
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => void;
  all: (...args: unknown[]) => unknown[];
}

function createMockDb() {
  const store: Record<string, Record<string, unknown>> = {
    tasks: {},
    agents: {},
    projects: {},
  };

  return {
    store,
    prepare(sql: string): PreparedStmt {
      const upper = sql.trim().toUpperCase();

      if (upper.startsWith("INSERT INTO TASKS")) {
        return {
          get: () => null,
          all: () => [],
          run: (...args: unknown[]) => {
            const id = args[0] as string;
            store.tasks[id] = {
              id,
              title: args[1],
              description: args[2],
              department_id: args[3],
              assigned_agent_id: args[4],
              project_id: args[5],
              status: "planned",
              workflow_pack_key: args[6],
              project_path: args[7],
              created_at: args[8],
              updated_at: args[9],
            };
          },
        };
      }

      if (upper.startsWith("SELECT * FROM TASKS WHERE ID")) {
        return {
          get: (id: unknown) => store.tasks[id as string] ?? null,
          run: () => {},
          all: () => [],
        };
      }

      if (upper.startsWith("UPDATE TASKS")) {
        return {
          get: () => null,
          all: () => [],
          run: (...args: unknown[]) => {
            // Simplistic: find the task id (last arg) and update status
            const taskId = args[args.length - 1] as string;
            const task = store.tasks[taskId];
            if (task) {
              if (upper.includes("ASSIGNED_AGENT_ID")) {
                (task as Record<string, unknown>).assigned_agent_id = args[0];
                (task as Record<string, unknown>).status = "planned";
              }
              if (upper.includes("STATUS = 'COLLABORATING'")) {
                (task as Record<string, unknown>).status = "collaborating";
              }
              (task as Record<string, unknown>).updated_at = args[args.length - 2] ?? Date.now();
            }
          },
        };
      }

      if (upper.startsWith("UPDATE AGENTS")) {
        return {
          get: () => null,
          all: () => [],
          run: () => {},
        };
      }

      if (upper.startsWith("UPDATE PROJECTS")) {
        return {
          get: () => null,
          all: () => [],
          run: () => {},
        };
      }

      if (upper.startsWith("SELECT * FROM AGENTS")) {
        return {
          get: () => null,
          run: () => {},
          all: () => [],
        };
      }

      if (upper.startsWith("SELECT STATUS FROM TASKS")) {
        return {
          get: (id: unknown) => {
            const t = store.tasks[id as string];
            return t ? { status: (t as Record<string, unknown>).status } : undefined;
          },
          run: () => {},
          all: () => [],
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

// Mock the external modules
vi.mock("../../../modules/workflow/packs/task-pack-resolver.ts", () => ({
  resolveWorkflowPackKeyForTask: () => null,
}));

vi.mock("../../../modules/workflow/packs/definitions.ts", () => ({
  isWorkflowPackKey: (key: string) => key === "development" || key === "web_research_report",
}));

const mockResolveConstrainedAgentScope = vi.fn().mockReturnValue(null);
vi.mock("../../../modules/routes/core/tasks/execution-run-auto-assign.ts", () => ({
  resolveConstrainedAgentScopeForTask: (...args: unknown[]) => mockResolveConstrainedAgentScope(...args),
}));

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<ReturnType<typeof createDefaultDeps>>) {
  const base = createDefaultDeps();
  return { ...base, ...overrides };
}

function createDefaultDeps() {
  const db = createMockDb();
  return {
    db: db as unknown as ReturnType<typeof createMockDb>,
    nowMs: () => 1000000,
    resolveLang: () => "en" as const,
    getDeptName: (id: string) => `Dept:${id}`,
    getRoleLabel: (role: string) => role,
    detectTargetDepartments: () => [] as string[],
    findBestSubordinate: () => null as MockAgent | null,
    normalizeTextField: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
    resolveProjectFromOptions: () => ({
      id: null as string | null,
      name: null as string | null,
      projectPath: null as string | null,
      coreGoal: null as string | null,
    }),
    buildRoundGoal: (_coreGoal: string | null, ceoMessage: string) => ceoMessage,
    resolveDirectiveProjectPath: () => ({ projectPath: null as string | null, source: "none" }),
    recordTaskCreationAudit: vi.fn(),
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    l: (ko: string[], en: string[]) => ({ ko, en, ja: [], zh: [], de: [] }),
    pickL: (_pool: unknown, _lang: unknown) => {
      const p = _pool as Record<string, string[]>;
      const lang = _lang as string;
      return p[lang]?.[0] ?? p.en?.[0] ?? "";
    },
    notifyCeo: vi.fn(),
    isTaskWorkflowInterrupted: () => false,
    hasOpenForeignSubtasks: () => false,
    processSubtaskDelegations: vi.fn(),
    startCrossDeptCooperation: vi.fn(),
    seedApprovedPlanSubtasks: vi.fn(),
    startPlannedApprovalMeeting: vi.fn(),
    sendAgentMessage: vi.fn(),
    registerTaskMessengerRoute: vi.fn(),
    startTaskExecutionForAgent: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTaskDelegationHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Task creation
  // -------------------------------------------------------------------------

  describe("task creation", () => {
    it("creates a task in the DB and broadcasts task_update", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Build the feature", "msg-1");

      // Advance past ackDelay (max 2s)
      vi.advanceTimersByTime(2500);

      const db = deps.db as ReturnType<typeof createMockDb>;
      const taskIds = Object.keys(db.store.tasks);
      expect(taskIds).toHaveLength(1);

      const task = db.store.tasks[taskIds[0]] as Record<string, unknown>;
      expect(task.title).toBe("Build the feature");
      expect(task.department_id).toBe("dev");
      expect(task.status).toBe("planned");

      expect(deps.broadcast).toHaveBeenCalledWith("task_update", expect.anything());
      expect(deps.registerTaskMessengerRoute).toHaveBeenCalled();
      expect(deps.recordTaskCreationAudit).toHaveBeenCalled();
    });

    it("truncates long task titles to 60 chars", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();
      const longMsg = "A".repeat(80);

      handler(leader as any, longMsg, "msg-1");
      vi.advanceTimersByTime(2500);

      const db = deps.db as ReturnType<typeof createMockDb>;
      const task = Object.values(db.store.tasks)[0] as Record<string, unknown>;
      expect((task.title as string).length).toBe(60);
      expect((task.title as string).endsWith("...")).toBe(true);
    });

    it("appends task log for CEO message", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Do something", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.appendTaskLog).toHaveBeenCalledWith(expect.any(String), "system", expect.stringContaining("CEO →"));
    });

    it("appends project-related logs when project is resolved", () => {
      const deps = createMockDeps({
        resolveProjectFromOptions: () => ({
          id: "proj-1",
          name: "MyProject",
          projectPath: "/home/user/project",
          coreGoal: "Build great software",
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Fix the bug", "msg-1");
      vi.advanceTimersByTime(2500);

      const logCalls = (deps.appendTaskLog as ReturnType<typeof vi.fn>).mock.calls;
      const logMessages = logCalls.map((c: unknown[]) => c[2] as string);
      expect(logMessages.some((m: string) => m.includes("Project linked"))).toBe(true);
      expect(logMessages.some((m: string) => m.includes("Round goal"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Self-execution (no subordinate)
  // -------------------------------------------------------------------------

  describe("self-execution (no subordinate)", () => {
    it("leader handles task themselves when no subordinate is available", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Solo task", "msg-1");
      vi.advanceTimersByTime(2500);

      // Leader sends self-execution message
      expect(deps.sendAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agent-leader-1" }),
        expect.any(String),
        "chat",
        "agent",
        null,
        expect.any(String),
      );

      // Should start planned approval meeting by default
      expect(deps.startPlannedApprovalMeeting).toHaveBeenCalled();
    });

    it("skips planned meeting when skipPlannedMeeting is set", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Quick task", "msg-1", { skipPlannedMeeting: true });
      vi.advanceTimersByTime(2500);

      expect(deps.startPlannedApprovalMeeting).not.toHaveBeenCalled();
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        expect.any(String),
        "system",
        "Planned meeting skipped by CEO directive",
      );
    });

    it("seeds plan subtasks when planned meeting is skipped but skipPlanSubtasks is false", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Quick with plan", "msg-1", { skipPlannedMeeting: true });
      vi.advanceTimersByTime(2500);

      expect(deps.seedApprovedPlanSubtasks).toHaveBeenCalledWith(expect.any(String), "dev", []);
    });

    it("does NOT seed plan subtasks when both skip flags are set", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Quick no plan", "msg-1", {
        skipPlannedMeeting: true,
        skipPlanSubtasks: true,
      });
      vi.advanceTimersByTime(2500);

      expect(deps.seedApprovedPlanSubtasks).not.toHaveBeenCalled();
    });

    it("calls startTaskExecutionForAgent after planning phase completes", () => {
      const deps = createMockDeps({
        startPlannedApprovalMeeting: vi.fn((_taskId, _title, _deptId, onApproved) => {
          onApproved([]);
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Execute after plan", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ id: "agent-leader-1" }),
        "dev",
        "Dept:dev",
      );
    });

    it("logs manual fallback notice when manualFallbackToLeader is triggered via constrained scope", () => {
      // To trigger manualFallbackToLeader, projectCandidateAgentIds must be an Array AND subordinate must be null.
      mockResolveConstrainedAgentScope.mockReturnValue(["other-agent-1"]);

      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Constrained task", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("safeguard"), expect.any(String));
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        expect.any(String),
        "system",
        expect.stringContaining("Manual assignment fallback"),
      );

      // Restore mock
      mockResolveConstrainedAgentScope.mockReturnValue(null);
    });
  });

  // -------------------------------------------------------------------------
  // Delegation to subordinate
  // -------------------------------------------------------------------------

  describe("delegation to subordinate", () => {
    const subordinate = makeAgent({
      id: "agent-sub-1",
      name: "Bob",
      name_ko: "밥",
      role: "developer",
    });

    it("delegates task to subordinate through full flow", () => {
      const deps = createMockDeps({
        findBestSubordinate: () => subordinate as any,
        startPlannedApprovalMeeting: vi.fn((_taskId, _title, _deptId, onApproved) => {
          onApproved([]);
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Delegated task", "msg-1");

      // Step 1: ack delay (up to 2s)
      vi.advanceTimersByTime(2500);

      // Leader should have sent ack message
      expect(deps.sendAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agent-leader-1" }),
        expect.any(String),
        "chat",
        "agent",
        null,
        expect.any(String),
      );

      // Planning phase should run (since no skip)
      expect(deps.startPlannedApprovalMeeting).toHaveBeenCalled();

      // Step 2: delegate delay (up to 3s)
      vi.advanceTimersByTime(3500);

      // Leader sends delegate message to subordinate
      const delegateCalls = (deps.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[2] === "task_assign",
      );
      expect(delegateCalls.length).toBeGreaterThanOrEqual(1);

      // Step 3: sub ack delay (up to 2s)
      vi.advanceTimersByTime(2500);

      // Subordinate should acknowledge
      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ id: "agent-sub-1" }),
        "dev",
        "Dept:dev",
      );
    });

    it("skips planning meeting and delegates directly when skipPlannedMeeting is true", () => {
      const deps = createMockDeps({
        findBestSubordinate: () => subordinate as any,
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Fast delegation", "msg-1", { skipPlannedMeeting: true });

      // Ack delay
      vi.advanceTimersByTime(2500);

      expect(deps.startPlannedApprovalMeeting).not.toHaveBeenCalled();

      // Delegate delay
      vi.advanceTimersByTime(3500);

      // Sub ack delay
      vi.advanceTimersByTime(2500);

      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ id: "agent-sub-1" }),
        "dev",
        "Dept:dev",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Planning lead with cross-department
  // -------------------------------------------------------------------------

  describe("planning lead with cross-department collaboration", () => {
    it("identifies related departments and notifies CEO when leader is planning lead", () => {
      const deps = createMockDeps({
        detectTargetDepartments: () => ["design", "qa"],
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent({ department_id: "planning" });

      handler(leader as any, "Plan the project involving design and qa", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Planning"), expect.any(String));
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        expect.any(String),
        "system",
        expect.stringContaining("Planning pre-check"),
      );
    });

    it("starts cross-dept cooperation before delegation for planning lead", () => {
      const deps = createMockDeps({
        detectTargetDepartments: () => ["design"],
        startPlannedApprovalMeeting: vi.fn((_taskId, _title, _deptId, onApproved) => {
          onApproved([]);
        }),
        startCrossDeptCooperation: vi.fn((_depts, _idx, _ctx, onComplete) => {
          if (onComplete) onComplete();
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent({ department_id: "planning" });

      handler(leader as any, "Cross dept work", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.startCrossDeptCooperation).toHaveBeenCalledWith(
        ["design"],
        0,
        expect.objectContaining({ leaderDeptId: "planning" }),
        expect.any(Function),
      );
    });

    it("uses subtask dispatcher when open foreign subtasks exist", () => {
      const deps = createMockDeps({
        detectTargetDepartments: () => ["design"],
        hasOpenForeignSubtasks: () => true,
        startPlannedApprovalMeeting: vi.fn((_taskId, _title, _deptId, onApproved) => {
          onApproved([]);
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent({ department_id: "planning" });

      handler(leader as any, "Subtask dispatch", "msg-1");
      vi.advanceTimersByTime(2500);

      expect(deps.processSubtaskDelegations).toHaveBeenCalled();
      expect(deps.startCrossDeptCooperation).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-planning lead with cross-department (after main)
  // -------------------------------------------------------------------------

  describe("non-planning lead with cross-department collaboration", () => {
    it("starts cross-dept cooperation after main delegation for non-planning leads", () => {
      const deps = createMockDeps({
        detectTargetDepartments: () => ["qa"],
        startPlannedApprovalMeeting: vi.fn(
          (_taskId: string, _title: string, _deptId: string, onApproved: (notes: string[]) => void) => {
            onApproved([]);
          },
        ),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent({ department_id: "dev" });

      handler(leader as any, "Dev task mentioning qa", "msg-1");

      // ack delay
      vi.advanceTimersByTime(2500);

      // After main delegation completes, cross-dept runs with 3-4s delay
      vi.advanceTimersByTime(5000);

      expect(deps.startCrossDeptCooperation).toHaveBeenCalledWith(
        ["qa"],
        0,
        expect.objectContaining({ leaderDeptId: "dev" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Workflow interruption
  // -------------------------------------------------------------------------

  describe("workflow interruption", () => {
    it("aborts delegation when workflow is interrupted during delegate step", () => {
      let interruptAfterAck = false;
      const deps = createMockDeps({
        findBestSubordinate: () => makeAgent({ id: "sub-1", name: "Bob", name_ko: "밥", role: "dev" }) as any,
        startPlannedApprovalMeeting: vi.fn((_taskId, _title, _deptId, onApproved) => {
          onApproved([]);
        }),
        isTaskWorkflowInterrupted: () => interruptAfterAck,
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Interrupted task", "msg-1", { skipPlannedMeeting: true });

      // Ack delay completes
      vi.advanceTimersByTime(2500);

      // Now set interrupted
      interruptAfterAck = true;

      // Delegate delay
      vi.advanceTimersByTime(3500);

      // startTaskExecutionForAgent should NOT be called because interrupted
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // inferPackKeyFromAgentId (via behavior)
  // -------------------------------------------------------------------------

  describe("pack key inference from agent id", () => {
    it("does not infer pack key from a normal agent id", () => {
      const deps = createMockDeps();
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent({ id: "agent-leader-1" });

      handler(leader as any, "Normal task", "msg-1");
      vi.advanceTimersByTime(2500);

      const db = deps.db as ReturnType<typeof createMockDb>;
      const task = Object.values(db.store.tasks)[0] as Record<string, unknown>;
      // workflow_pack_key comes from resolveWorkflowPackKeyForTask mock which returns null
      expect(task.workflow_pack_key).toBe(null);
    });
  });

  // -------------------------------------------------------------------------
  // Language handling
  // -------------------------------------------------------------------------

  describe("language handling", () => {
    it("uses Korean name when lang is ko", () => {
      const deps = createMockDeps({
        resolveLang: (() => "ko") as unknown as () => "en",
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "한국어 작업", "msg-1");
      vi.advanceTimersByTime(2500);

      // Check that the task log uses Korean name
      const logCalls = (deps.appendTaskLog as ReturnType<typeof vi.fn>).mock.calls;
      const ceoLogMsg = logCalls.find((c: unknown[]) => (c[2] as string).includes("CEO →"));
      expect(ceoLogMsg).toBeDefined();
      expect((ceoLogMsg as unknown[])[2]).toContain("앨리스");
    });

    it("uses English name when lang is en", () => {
      const deps = createMockDeps({
        resolveLang: () => "en" as const,
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "English task", "msg-1");
      vi.advanceTimersByTime(2500);

      const logCalls = (deps.appendTaskLog as ReturnType<typeof vi.fn>).mock.calls;
      const ceoLogMsg = logCalls.find((c: unknown[]) => (c[2] as string).includes("CEO →"));
      expect((ceoLogMsg as unknown[])[2]).toContain("Alice");
    });
  });

  // -------------------------------------------------------------------------
  // Task description construction
  // -------------------------------------------------------------------------

  describe("task description", () => {
    it("includes project info in task description when project is resolved", () => {
      const deps = createMockDeps({
        resolveProjectFromOptions: () => ({
          id: "proj-1",
          name: "SuperProject",
          projectPath: "/home/user/super",
          coreGoal: "Build an amazing app",
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Work on the project", "msg-1");
      vi.advanceTimersByTime(2500);

      const db = deps.db as ReturnType<typeof createMockDb>;
      const task = Object.values(db.store.tasks)[0] as Record<string, unknown>;
      const desc = task.description as string;

      expect(desc).toContain("[CEO] Work on the project");
      expect(desc).toContain("[PROJECT] SuperProject");
      expect(desc).toContain("[PROJECT CORE GOAL] Build an amazing app");
      expect(desc).toContain("[ROUND GOAL]");
    });

    it("includes project context hint when different from core goal", () => {
      const deps = createMockDeps({
        resolveProjectFromOptions: () => ({
          id: "proj-1",
          name: "P",
          projectPath: null,
          coreGoal: "Core goal A",
        }),
      });
      const handler = createTaskDelegationHandler(deps as any);
      const leader = makeAgent();

      handler(leader as any, "Do work", "msg-1", { projectContext: "Extra context B" });
      vi.advanceTimersByTime(2500);

      const db = deps.db as ReturnType<typeof createMockDb>;
      const task = Object.values(db.store.tasks)[0] as Record<string, unknown>;
      const desc = task.description as string;

      expect(desc).toContain("[PROJECT CONTEXT] Extra context B");
    });
  });
});
