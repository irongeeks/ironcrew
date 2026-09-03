import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubtaskRoutingTools } from "../../../modules/workflow/agents/subtask-routing.ts";

// ---------------------------------------------------------------------------
// Mock: resolveConstrainedAgentScopeForTask — must be hoisted before import
// ---------------------------------------------------------------------------
vi.mock("../../../modules/routes/core/tasks/execution-run-auto-assign.ts", () => ({
  resolveConstrainedAgentScopeForTask: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../modules/routes/validation.ts", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// ---------------------------------------------------------------------------
// Helpers — lightweight in-memory DB stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const DEPT_ROWS: Row[] = [
  { id: "planning", name: "Planning", name_ko: "기획팀", sort_order: 1 },
  { id: "dev", name: "Development", name_ko: "개발팀", sort_order: 2 },
  { id: "design", name: "Design", name_ko: "디자인팀", sort_order: 3 },
  { id: "qa", name: "QA/QC", name_ko: "품질관리팀", sort_order: 4 },
  { id: "ops", name: "Operations", name_ko: "운영팀", sort_order: 5 },
];

function createMockDb() {
  const tables: Record<string, Row[]> = {
    tasks: [],
    subtasks: [],
    departments: [...DEPT_ROWS],
  };

  function prepare(sql: string) {
    const n = sql.replace(/\s+/g, " ").trim();

    return {
      get(...params: unknown[]): Row | undefined {
        if (n.includes("FROM tasks") && n.includes("WHERE id")) {
          return tables.tasks.find((r) => r.id === params[0]);
        }
        if (n.includes("FROM subtasks") && n.includes("WHERE id =")) {
          return tables.subtasks.find((r) => r.id === params[0]);
        }
        return undefined;
      },
      all(...params: unknown[]): Row[] {
        if (n.includes("FROM departments")) {
          return tables.departments;
        }
        if (n.includes("FROM subtasks") && n.includes("WHERE task_id")) {
          return tables.subtasks.filter(
            (r) =>
              r.task_id === params[0] &&
              (r.status === "pending" || r.status === "blocked") &&
              (!r.delegated_task_id || r.delegated_task_id === ""),
          );
        }
        return [];
      },
      run(..._params: unknown[]) {
        // UPDATE subtasks
        if (n.startsWith("UPDATE subtasks")) {
          const st = tables.subtasks.find((r) => r.id === _params[4]);
          if (st) {
            st.target_department_id = _params[0];
            st.status = _params[1];
            st.blocked_reason = _params[2];
            st.assigned_agent_id = _params[3];
          }
        }
      },
    };
  }

  return { prepare, _tables: tables };
}

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

function createDefaultDeps(overrides: Partial<ReturnType<typeof createDefaultDepsRaw>> = {}) {
  return { ...createDefaultDepsRaw(), ...overrides };
}

function createDefaultDepsRaw() {
  const mockDb = createMockDb();
  return {
    db: mockDb,
    DEPT_KEYWORDS: {
      dev: ["development", "code", "implement", "backend", "frontend", "api"],
      design: ["design", "ui", "ux", "mockup", "figma"],
      qa: ["test", "qa", "quality", "bug", "verify"],
      planning: ["plan", "strategy", "roadmap"],
      ops: ["deploy", "ci", "infrastructure", "devops"],
    } as Record<string, string[]>,
    detectTargetDepartments: vi.fn().mockReturnValue([]),
    runAgentOneShot: vi.fn().mockResolvedValue({ text: "" }),
    resolveProjectPath: vi.fn().mockReturnValue("/tmp/test-project"),
    resolveLang: vi.fn().mockReturnValue("en" as const),
    findTeamLeader: vi.fn().mockReturnValue({ id: "agent-leader", name: "Leader" }),
    getDeptName: vi.fn().mockImplementation((id: string) => {
      const found = DEPT_ROWS.find((d) => d.id === id);
      return found ? (found.name as string) : id;
    }),
    pickL: vi.fn().mockImplementation((choices: any, _lang: string) => {
      if (Array.isArray(choices)) return choices[0] ?? "";
      return choices?.en?.[0] ?? choices?.ko?.[0] ?? "";
    }),
    l: vi.fn().mockImplementation((ko: string[], en: string[], _ja: string[], _zh: string[]) => ({
      ko,
      en,
      ja: _ja,
      zh: _zh,
    })),
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    notifyCeo: vi.fn(),
  };
}

// ===========================================================================
// analyzeSubtaskDepartment
// ===========================================================================

describe("analyzeSubtaskDepartment", () => {
  let deps: ReturnType<typeof createDefaultDeps>;
  let analyzeSubtaskDepartment: ReturnType<typeof createSubtaskRoutingTools>["analyzeSubtaskDepartment"];

  beforeEach(() => {
    deps = createDefaultDeps();
    ({ analyzeSubtaskDepartment } = createSubtaskRoutingTools(deps));
  });

  it("returns null for empty input", () => {
    expect(analyzeSubtaskDepartment("", null)).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(analyzeSubtaskDepartment("   ", null)).toBeNull();
  });

  it("returns null when text is only bracket tags", () => {
    expect(analyzeSubtaskDepartment("[tag1] [tag2]", null)).toBeNull();
  });

  it("strips bracket tags before analysis", () => {
    // After stripping [Design], leftover is "Create mockup" — no dept mention
    deps.detectTargetDepartments.mockReturnValue([]);
    expect(analyzeSubtaskDepartment("[Design] Create mockup", null)).toBeNull();
  });

  // --- findExplicitDepartmentByMention via prefix ---

  it("finds department by English name in prefix (before colon)", () => {
    const result = analyzeSubtaskDepartment("Development: implement API endpoint", null);
    expect(result).toBe("dev");
  });

  it("finds department by Korean name in prefix", () => {
    const result = analyzeSubtaskDepartment("개발팀: API 엔드포인트 구현", null);
    expect(result).toBe("dev");
  });

  it("finds department by Korean name without 팀 suffix", () => {
    const result = analyzeSubtaskDepartment("개발: API 엔드포인트 구현", null);
    expect(result).toBe("dev");
  });

  it("skips the parent department", () => {
    // "Development" matches dev, but dev is the parent — so should not match
    deps.detectTargetDepartments.mockReturnValue([]);
    const result = analyzeSubtaskDepartment("Development: implement endpoint", "dev");
    expect(result).toBeNull();
  });

  it("uses earliest match when multiple departments appear in text", () => {
    // "Design review for Development" — Design appears first
    const result = analyzeSubtaskDepartment("Design review for Development team", null);
    expect(result).toBe("design");
  });

  it("uses longest match at the same index", () => {
    // "QA/QC" is longer than "QA" if both started at same position
    // We test by placing "QA/QC" at the start
    const result = analyzeSubtaskDepartment("QA/QC: run integration tests", null);
    expect(result).toBe("qa");
  });

  // --- prefix vs whole text ---

  it("checks prefix first then whole text", () => {
    // No dept in prefix ("Task"), but "Design" appears in the rest
    const result = analyzeSubtaskDepartment("Task: request Design team mockup", null);
    expect(result).toBe("design");
  });

  // --- keyword scoring fallback ---

  it("falls back to keyword scoring when multiple foreign depts match", () => {
    deps.detectTargetDepartments.mockReturnValue(["dev", "design"]);
    // No explicit department mention in text, so it goes to keyword scoring
    // "implement the frontend api" has "implement", "frontend", "api" matching dev keywords
    deps.db._tables.departments = [{ id: "ops", name: "Ops", name_ko: "운영팀", sort_order: 1 }];
    const result = analyzeSubtaskDepartment("implement the frontend api", null);
    // dev has 3 keyword matches, design has 0 → dev wins
    expect(result).toBe("dev");
  });

  it("picks department with earliest keyword hit on tie score", () => {
    deps.detectTargetDepartments.mockReturnValue(["dev", "qa"]);
    deps.db._tables.departments = [];
    // "verify the code" → qa has "verify" at 0, dev has "code" at 11
    // Each has score 1, but qa has firstHit=0 < dev firstHit=11
    const result = analyzeSubtaskDepartment("verify the code", null);
    expect(result).toBe("qa");
  });

  it("returns null when no foreign department is detected", () => {
    deps.detectTargetDepartments.mockReturnValue([]);
    deps.db._tables.departments = [];
    const result = analyzeSubtaskDepartment("do something generic", null);
    expect(result).toBeNull();
  });

  it("returns null when only the parent department is detected", () => {
    deps.detectTargetDepartments.mockReturnValue(["dev"]);
    deps.db._tables.departments = [];
    const result = analyzeSubtaskDepartment("do something generic", "dev");
    expect(result).toBeNull();
  });

  it("returns single foreign department without keyword scoring", () => {
    deps.detectTargetDepartments.mockReturnValue(["design"]);
    deps.db._tables.departments = [];
    const result = analyzeSubtaskDepartment("create a mockup", null);
    expect(result).toBe("design");
  });
});

// ===========================================================================
// parsePlannerSubtaskAssignments (tested indirectly via rerouteSubtasksByPlanningLeader,
// but we can also test it by calling the returned reroute function with controlled agent output)
// Below we test parse behavior by triggering rerouteSubtasksByPlanningLeader with known agent output.
// ===========================================================================

describe("parsePlannerSubtaskAssignments (via rerouteSubtasksByPlanningLeader)", () => {
  // Since parsePlannerSubtaskAssignments is internal, we test it indirectly by
  // feeding various runAgentOneShot outputs and observing DB mutations.

  function setupDeps() {
    const deps = createDefaultDeps();
    deps.db._tables.tasks.push({
      id: "task-1",
      title: "Test Task",
      description: "Test description",
      project_path: "/tmp/project",
      assigned_agent_id: "agent-owner",
      department_id: "dev",
      project_id: null,
      workflow_pack_key: null,
    });
    deps.db._tables.subtasks.push({
      id: "st-1",
      task_id: "task-1",
      title: "Fix bug",
      description: null,
      status: "pending",
      blocked_reason: null,
      target_department_id: null,
      assigned_agent_id: null,
      delegated_task_id: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    return deps;
  }

  it("parses JSON from fenced code block", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '```json\n{"assignments":[{"subtask_id":"st-1","target_department_id":"design","reason":"needs mockup"}]}\n```',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
    expect(st!.status).toBe("blocked");
  });

  it("parses bare JSON array", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("parses assignments wrapper object", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '{"assignments":[{"subtask_id":"st-1","target_department_id":"qa"}]}',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("qa");
  });

  it("handles text with embedded JSON object", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: 'Here is my analysis:\n{"assignments":[{"subtask_id":"st-1","target_department_id":"design"}]}\nThank you.',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("normalizes field name variants (target_department, department_id, department)", async () => {
    const deps = setupDeps();
    // Using "department" variant
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","department":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("returns empty (no updates) for invalid JSON", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({ text: "I cannot produce valid JSON" });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("parser found no assignment payload"),
    );
  });

  it("returns empty for empty text", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({ text: "" });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("parser found no assignment payload"),
    );
  });

  it("skips rows without subtask_id", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"target_department_id":"design"},{"subtask_id":"st-1","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("clamps confidence between 0 and 1", async () => {
    const deps = setupDeps();
    // confidence > 1 should be clamped to 1 — no crash
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design","confidence":5.0}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });
});

// ===========================================================================
// normalizePlannerTargetDeptId (tested via rerouteSubtasksByPlanningLeader)
// ===========================================================================

describe("normalizePlannerTargetDeptId (via rerouteSubtasksByPlanningLeader)", () => {
  function setupDeps() {
    const deps = createDefaultDeps();
    deps.db._tables.tasks.push({
      id: "task-1",
      title: "Test Task",
      description: "desc",
      project_path: "/tmp/project",
      assigned_agent_id: "agent-owner",
      department_id: "dev",
      project_id: null,
      workflow_pack_key: null,
    });
    deps.db._tables.subtasks.push({
      id: "st-1",
      task_id: "task-1",
      title: "Subtask 1",
      description: null,
      status: "pending",
      blocked_reason: null,
      target_department_id: null,
      assigned_agent_id: null,
      delegated_task_id: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    return deps;
  }

  const NULL_ALIASES = [
    "null",
    "none",
    "owner",
    "owner_dept",
    "자체",
    "내부",
    "동일부서",
    "원부서",
    "없음",
    "无",
    "同部门",
  ];

  for (const alias of NULL_ALIASES) {
    it(`maps "${alias}" to null (no reroute)`, async () => {
      const deps = setupDeps();
      deps.runAgentOneShot.mockResolvedValue({
        text: `[{"subtask_id":"st-1","target_department_id":"${alias}"}]`,
      });
      const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
      await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

      const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
      // target_department_id should remain null (not rerouted)
      expect(st!.target_department_id).toBeNull();
    });
  }

  it("matches department by id", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("matches department by English name", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"Design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("matches department by Korean name", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"디자인팀"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
  });

  it("returns null when matched dept is same as owner", async () => {
    const deps = setupDeps();
    // Owner is "dev", target is also "dev" → should normalize to null
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"dev"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBeNull();
  });

  it("returns null for unrecognized department string", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"nonexistent-dept"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBeNull();
  });
});

// ===========================================================================
// rerouteSubtasksByPlanningLeader
// ===========================================================================

describe("rerouteSubtasksByPlanningLeader", () => {
  function setupDeps(subtaskOverrides: Partial<Row>[] = [{}]) {
    const deps = createDefaultDeps();
    deps.db._tables.tasks.push({
      id: "task-1",
      title: "Build feature X",
      description: "Implement feature X",
      project_path: "/tmp/project",
      assigned_agent_id: "agent-owner",
      department_id: "dev",
      project_id: null,
      workflow_pack_key: null,
    });
    for (let i = 0; i < subtaskOverrides.length; i++) {
      deps.db._tables.subtasks.push({
        id: `st-${i + 1}`,
        task_id: "task-1",
        title: `Subtask ${i + 1}`,
        description: null,
        status: "pending",
        blocked_reason: null,
        target_department_id: null,
        assigned_agent_id: null,
        delegated_task_id: null,
        created_at: `2026-01-01T00:00:0${i}Z`,
        ...subtaskOverrides[i],
      });
    }
    return deps;
  }

  it("skips if already in-flight (lock key)", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: '[{"subtask_id":"st-1","target_department_id":"design"}]' }), 50),
        ),
    );
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);

    // Fire two concurrent calls with same phase+taskId
    const p1 = rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");
    const p2 = rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");
    await Promise.all([p1, p2]);

    // runAgentOneShot should only be called once (second call was skipped)
    expect(deps.runAgentOneShot).toHaveBeenCalledTimes(1);
  });

  it("allows different phase keys concurrently", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);

    await Promise.all([
      rerouteSubtasksByPlanningLeader("task-1", "dev", "planned"),
      rerouteSubtasksByPlanningLeader("task-1", "dev", "review"),
    ]);

    expect(deps.runAgentOneShot).toHaveBeenCalledTimes(2);
  });

  it("skips if task does not exist", async () => {
    const deps = createDefaultDeps();
    // No task in DB
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("nonexistent-task", "dev", "planned");

    expect(deps.runAgentOneShot).not.toHaveBeenCalled();
  });

  it("skips if no subtasks match", async () => {
    const deps = setupDeps();
    // Clear subtasks
    deps.db._tables.subtasks.length = 0;
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.runAgentOneShot).not.toHaveBeenCalled();
  });

  it("skips subtasks with delegated_task_id", async () => {
    const deps = setupDeps([{ delegated_task_id: "other-task" }]);
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    // No eligible subtasks after filtering
    expect(deps.runAgentOneShot).not.toHaveBeenCalled();
  });

  it("skips if no planning team leader found", async () => {
    const deps = setupDeps();
    deps.findTeamLeader.mockReturnValue(null);
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.runAgentOneShot).not.toHaveBeenCalled();
  });

  it("calls runAgentOneShot with correct prompt structure", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({ text: "[]" });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.runAgentOneShot).toHaveBeenCalledTimes(1);
    const [agent, prompt, options] = deps.runAgentOneShot.mock.calls[0];
    expect(agent).toEqual({ id: "agent-leader", name: "Leader" });
    expect(prompt).toContain("planning team leader");
    expect(prompt).toContain("Build feature X");
    expect(prompt).toContain("Owner department id: dev");
    expect(prompt).toContain("Workflow phase: planned");
    expect(prompt).toContain("st-1");
    expect(options.timeoutMs).toBe(180_000);
    expect(options.rawOutput).toBe(true);
    expect(options.noTools).toBe(true);
  });

  it("updates subtask to blocked with target department when rerouted", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design","reason":"needs mockup","confidence":0.9}]',
    });
    deps.findTeamLeader.mockImplementation((deptId: string) => {
      if (deptId === "planning") return { id: "agent-leader", name: "Leader" };
      if (deptId === "design") return { id: "agent-designer", name: "Designer" };
      return null;
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.target_department_id).toBe("design");
    expect(st!.status).toBe("blocked");
    expect(st!.assigned_agent_id).toBe("agent-designer");
  });

  it("resets blocked subtask to pending when target is owner dept", async () => {
    const deps = setupDeps([{ status: "blocked", blocked_reason: "Was blocked" }]);
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":null}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    expect(st!.status).toBe("pending");
    expect(st!.blocked_reason).toBeNull();
    expect(st!.assigned_agent_id).toBe("agent-owner");
  });

  it("sends summary notification when subtasks are updated", async () => {
    const deps = setupDeps();
    deps.pickL.mockReturnValue("Planning leader rerouted 1 subtasks for 'Build feature X'. (design:1)");
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Planning leader rerouted 1 subtasks"),
    );
    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.any(String), "task-1");
    expect(deps.broadcast).toHaveBeenCalledWith("subtask_update", expect.objectContaining({ id: "st-1" }));
  });

  it("does not send notification when no subtasks are changed", async () => {
    const deps = setupDeps([{ target_department_id: null, status: "pending", assigned_agent_id: "agent-owner" }]);
    // Assignment says keep in owner dept (null) — but subtask is already null/pending/agent-owner
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":null}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.notifyCeo).not.toHaveBeenCalled();
  });

  it("skips assignment for unknown subtask ids", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-nonexistent","target_department_id":"design"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    // No updates happened
    expect(deps.notifyCeo).not.toHaveBeenCalled();
  });

  it("handles runAgentOneShot errors gracefully", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot.mockRejectedValue(new Error("Agent timeout"));
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Planning reroute failed"),
    );
  });

  it("releases lock after error so subsequent calls can proceed", async () => {
    const deps = setupDeps();
    deps.runAgentOneShot
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce({ text: '[{"subtask_id":"st-1","target_department_id":"design"}]' });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);

    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.runAgentOneShot).toHaveBeenCalledTimes(2);
  });

  it("handles multiple subtasks in a single reroute call", async () => {
    const deps = setupDeps([{}, {}]);
    deps.findTeamLeader.mockImplementation((deptId: string) => {
      if (deptId === "planning") return { id: "agent-leader", name: "Leader" };
      if (deptId === "design") return { id: "agent-designer", name: "Designer" };
      if (deptId === "qa") return { id: "agent-qa", name: "QA" };
      return null;
    });
    deps.runAgentOneShot.mockResolvedValue({
      text: '[{"subtask_id":"st-1","target_department_id":"design"},{"subtask_id":"st-2","target_department_id":"qa"}]',
    });
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    const st1 = deps.db._tables.subtasks.find((r: Row) => r.id === "st-1");
    const st2 = deps.db._tables.subtasks.find((r: Row) => r.id === "st-2");
    expect(st1!.target_department_id).toBe("design");
    expect(st2!.target_department_id).toBe("qa");
    expect(deps.broadcast).toHaveBeenCalledTimes(2);
    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", expect.stringContaining("rerouted 2 subtasks"));
  });

  it("skips if departments table is empty", async () => {
    const deps = setupDeps();
    deps.db._tables.departments.length = 0;
    const { rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools(deps);
    await rerouteSubtasksByPlanningLeader("task-1", "dev", "planned");

    expect(deps.runAgentOneShot).not.toHaveBeenCalled();
  });
});
