import type { SQLInputValue } from "node:sqlite";

type DbLike = {
  prepare: (sql: string) => {
    all: (...params: SQLInputValue[]) => any[];
    get: (...params: SQLInputValue[]) => any;
    run: (...params: SQLInputValue[]) => any;
  };
};

type AgentRow = {
  id: string;
  name: string;
  role: string;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  cli_provider: string | null;
  personality: string | null;
  created_at?: number;
};

type ParentTaskShape = {
  id: string;
  title: string;
  description: string | null;
  department_id: string | null;
  workflow_pack_key?: string | null;
  project_id?: string | null;
};

type SubtaskShape = {
  id: string;
  title: string;
  description: string | null;
  target_department_id: string | null;
};

type AgentSpecialization = "browser" | "design" | "docs" | "code";

type RoutingChainStep = {
  step: "origin_to_coordinator" | "coordinator_to_executor";
  from_agent_id: string | null;
  to_agent_id: string;
  status: "planned" | "in_progress" | "completed" | "rolled_back";
  note: string;
  ts: number;
};

export type CrossAgentRoutingPlan = {
  routing_version: 1;
  router: {
    target_department_id: string;
    required_specializations: AgentSpecialization[];
    keyword_hits: string[];
    selected_rule: "keyword+skills+department+workload";
  };
  registry: Array<{
    agent_id: string;
    department_id: string | null;
    role: string;
    status: string;
    specialties: AgentSpecialization[];
    workload: number;
    score: number;
  }>;
  selected: {
    coordinator_agent_id: string;
    executor_agent_id: string;
  };
  chain: {
    chain_id: string;
    steps: RoutingChainStep[];
  };
  handoff: {
    context_version: 1;
    parent_task_id: string;
    parent_summary: string;
    delegated_subtask_ids: string[];
    delegated_subtask_titles: string[];
  };
};

const SPECIALIZATION_KEYWORDS: Record<AgentSpecialization, string[]> = {
  browser: [
    "browser",
    "web",
    "crawl",
    "scrape",
    "search",
    "site",
    "url",
    "playwright",
    "selenium",
    "웹",
    "브라우저",
    "검색",
    "크롤",
    "スクレイプ",
    "ブラウザ",
    "検索",
    "爬虫",
    "浏览器",
    "检索",
  ],
  design: ["ui", "ux", "design", "figma", "mock", "wireframe", "디자인", "画面", "設計", "设计", "视觉"],
  docs: [
    "doc",
    "docs",
    "documentation",
    "spec",
    "readme",
    "guide",
    "manual",
    "문서",
    "명세",
    "가이드",
    "仕様",
    "文書",
    "说明",
    "文档",
  ],
  code: [
    "code",
    "implement",
    "fix",
    "bug",
    "test",
    "refactor",
    "api",
    "server",
    "client",
    "코드",
    "개발",
    "버그",
    "테스트",
    "実装",
    "修正",
    "代码",
    "开发",
    "修复",
  ],
};

function collectKeywordMatches(text: string): Map<AgentSpecialization, string[]> {
  const normalized = text.toLowerCase();
  const matches = new Map<AgentSpecialization, string[]>();
  for (const [spec, keywords] of Object.entries(SPECIALIZATION_KEYWORDS) as Array<[AgentSpecialization, string[]]>) {
    const hits = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
    if (hits.length > 0) matches.set(spec, hits);
  }
  return matches;
}

function inferDepartmentSpecialization(targetDepartmentId: string): AgentSpecialization | null {
  if (targetDepartmentId === "design") return "design";
  if (targetDepartmentId === "planning" || targetDepartmentId === "research") return "docs";
  if (
    targetDepartmentId === "dev" ||
    targetDepartmentId === "qa" ||
    targetDepartmentId === "testing" ||
    targetDepartmentId === "review"
  )
    return "code";
  return null;
}

function parseTaskMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildSpecializations(agent: AgentRow): Set<AgentSpecialization> {
  const result = new Set<AgentSpecialization>();
  const dept = String(agent.department_id ?? "")
    .trim()
    .toLowerCase();
  const provider = String(agent.cli_provider ?? "")
    .trim()
    .toLowerCase();
  const personality = String(agent.personality ?? "").toLowerCase();
  const role = String(agent.role ?? "").toLowerCase();
  const hintBlob = `${agent.name} ${personality}`.toLowerCase();

  if (dept === "design") result.add("design");
  if (dept === "planning" || dept === "research") result.add("docs");
  if (dept === "dev" || dept === "qa" || dept === "testing" || dept === "review") result.add("code");
  if (provider === "gemini" || provider === "claude" || provider === "codex") result.add("docs");
  if (provider === "codex" || provider === "claude" || provider === "opencode" || provider === "copilot") {
    result.add("code");
  }
  if (provider === "gemini" || hintBlob.includes("research") || hintBlob.includes("browser")) result.add("browser");
  if (hintBlob.includes("design") || hintBlob.includes("figma")) result.add("design");
  if (hintBlob.includes("docs") || hintBlob.includes("documentation")) result.add("docs");
  if (role === "team_leader" && !result.has("docs")) result.add("docs");
  return result;
}

function workloadPenalty(status: string): number {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (normalized === "idle") return 0;
  if (normalized === "break") return 1.5;
  if (normalized === "working") return 3.5;
  return 2.5;
}

export function createCrossAgentTaskRouter(deps: { db: DbLike; nowMs: () => number }) {
  const { db, nowMs } = deps;

  function loadWorkload(agentIds: string[]): Map<string, number> {
    if (agentIds.length === 0) return new Map();
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
      SELECT assigned_agent_id AS agent_id, COUNT(*) AS cnt
      FROM tasks
      WHERE assigned_agent_id IN (${placeholders})
        AND status IN ('planned', 'collaborating', 'in_progress', 'review')
      GROUP BY assigned_agent_id
    `,
      )
      .all(...(agentIds as SQLInputValue[])) as Array<{ agent_id: string; cnt: number }>;
    return new Map(rows.map((row) => [row.agent_id, Number(row.cnt || 0)]));
  }

  function loadCandidateAgents(targetDepartmentId: string, candidateAgentIds: string[] | null): AgentRow[] {
    if (Array.isArray(candidateAgentIds) && candidateAgentIds.length > 0) {
      const placeholders = candidateAgentIds.map(() => "?").join(",");
      return db
        .prepare(
          `
        SELECT id, name, role, status, department_id, current_task_id, cli_provider, personality, created_at
        FROM agents
        WHERE id IN (${placeholders})
      `,
        )
        .all(...(candidateAgentIds as SQLInputValue[])) as AgentRow[];
    }
    return db
      .prepare(
        `
      SELECT id, name, role, status, department_id, current_task_id, cli_provider, personality, created_at
      FROM agents
      WHERE department_id = ?
    `,
      )
      .all(targetDepartmentId) as AgentRow[];
  }

  function planRouting(input: {
    parentTask: ParentTaskShape;
    subtasks: SubtaskShape[];
    targetDepartmentId: string;
    coordinator: AgentRow;
    executorFallback: AgentRow;
    originLeaderId: string | null;
    candidateAgentIds: string[] | null;
  }): CrossAgentRoutingPlan {
    const {
      parentTask,
      subtasks,
      targetDepartmentId,
      coordinator,
      executorFallback,
      originLeaderId,
      candidateAgentIds,
    } = input;
    const textBlob = `${parentTask.title}\n${parentTask.description ?? ""}\n${subtasks
      .map((subtask) => `${subtask.title}\n${subtask.description ?? ""}`)
      .join("\n")}`.toLowerCase();
    const keywordMatches = collectKeywordMatches(textBlob);
    const requiredSpecializations = new Set<AgentSpecialization>();
    for (const specialization of keywordMatches.keys()) requiredSpecializations.add(specialization);
    const deptSpecialization = inferDepartmentSpecialization(targetDepartmentId);
    if (deptSpecialization) requiredSpecializations.add(deptSpecialization);
    if (requiredSpecializations.size === 0) requiredSpecializations.add("code");

    const candidateAgents = loadCandidateAgents(targetDepartmentId, candidateAgentIds);
    const workloadByAgent = loadWorkload(candidateAgents.map((agent) => agent.id));

    const ranked = candidateAgents.map((agent) => {
      const specialties = buildSpecializations(agent);
      const matchedSpecialties = [...requiredSpecializations].filter((specialization) =>
        specialties.has(specialization),
      ).length;
      const activeTasks = workloadByAgent.get(agent.id) ?? 0;
      const rolePenalty = agent.role === "team_leader" ? 0.8 : 0;
      const departmentPenalty = agent.department_id === targetDepartmentId ? 0 : 1.2;
      const score =
        activeTasks * 4 + workloadPenalty(agent.status) + rolePenalty + departmentPenalty - matchedSpecialties * 2;
      return {
        agent,
        specialties,
        activeTasks,
        score,
        matchedSpecialties,
      };
    });

    const qualified = ranked
      .filter((entry) => entry.matchedSpecialties > 0 || requiredSpecializations.size === 0)
      .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.activeTasks - b.activeTasks));
    const fallbackRanked = [...ranked].sort((a, b) =>
      a.score !== b.score ? a.score - b.score : a.activeTasks - b.activeTasks,
    );

    const best = (qualified[0] ?? fallbackRanked[0])?.agent ?? executorFallback;
    const chainId = `${parentTask.id}:${targetDepartmentId}:${nowMs().toString(36)}`;
    const timestamp = nowMs();

    return {
      routing_version: 1,
      router: {
        target_department_id: targetDepartmentId,
        required_specializations: [...requiredSpecializations],
        keyword_hits: [...new Set([...keywordMatches.values()].flat())].slice(0, 12),
        selected_rule: "keyword+skills+department+workload",
      },
      registry: ranked
        .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.activeTasks - b.activeTasks))
        .map((entry) => ({
          agent_id: entry.agent.id,
          department_id: entry.agent.department_id,
          role: entry.agent.role,
          status: entry.agent.status,
          specialties: [...entry.specialties],
          workload: entry.activeTasks,
          score: Number(entry.score.toFixed(2)),
        })),
      selected: {
        coordinator_agent_id: coordinator.id,
        executor_agent_id: best.id,
      },
      chain: {
        chain_id: chainId,
        steps: [
          {
            step: "origin_to_coordinator",
            from_agent_id: originLeaderId,
            to_agent_id: coordinator.id,
            status: "in_progress",
            note: "Cross-department intake handoff",
            ts: timestamp,
          },
          {
            step: "coordinator_to_executor",
            from_agent_id: coordinator.id,
            to_agent_id: best.id,
            status: coordinator.id === best.id ? "completed" : "planned",
            note: "Specialized execution handoff",
            ts: timestamp,
          },
        ],
      },
      handoff: {
        context_version: 1,
        parent_task_id: parentTask.id,
        parent_summary: (parentTask.description ?? parentTask.title).slice(0, 4000),
        delegated_subtask_ids: subtasks.map((subtask) => subtask.id),
        delegated_subtask_titles: subtasks.map((subtask) => subtask.title),
      },
    };
  }

  function attachDelegationMeta(taskId: string, plan: CrossAgentRoutingPlan): void {
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as
      | { workflow_meta_json?: string | null }
      | undefined;
    const nextMeta = {
      ...parseTaskMeta(row?.workflow_meta_json ?? null),
      cross_agent_routing: plan,
    };
    db.prepare("UPDATE tasks SET workflow_meta_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(nextMeta),
      nowMs(),
      taskId,
    );
  }

  function updateChainStep(
    taskId: string,
    step: RoutingChainStep["step"],
    status: RoutingChainStep["status"],
    note?: string,
  ): void {
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as
      | { workflow_meta_json?: string | null }
      | undefined;
    const current = parseTaskMeta(row?.workflow_meta_json ?? null);
    const routeRaw = current.cross_agent_routing;
    if (!routeRaw || typeof routeRaw !== "object" || Array.isArray(routeRaw)) return;
    const route = routeRaw as CrossAgentRoutingPlan;
    if (!route.chain?.steps || !Array.isArray(route.chain.steps)) return;
    const steps = route.chain.steps.map((entry) => {
      if (!entry || entry.step !== step) return entry;
      return {
        ...entry,
        status,
        note: note || entry.note,
        ts: nowMs(),
      };
    });
    const nextMeta = {
      ...current,
      cross_agent_routing: {
        ...route,
        chain: {
          ...route.chain,
          steps,
        },
      },
    };
    db.prepare("UPDATE tasks SET workflow_meta_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(nextMeta),
      nowMs(),
      taskId,
    );
  }

  function markRollback(taskId: string, reason: string): void {
    updateChainStep(taskId, "coordinator_to_executor", "rolled_back", reason);
  }

  return {
    planRouting,
    attachDelegationMeta,
    updateChainStep,
    markRollback,
  };
}
