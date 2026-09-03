import { randomUUID } from "node:crypto";
import { resolveWorkflowPackKeyForTask } from "../../../workflow/packs/task-pack-resolver.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "./types.ts";

type ReportOutputFormat = "md";

export type ReportRoutingDeps = Pick<
  RuntimeContext,
  | "db"
  | "nowMs"
  | "randomDelay"
  | "resolveLang"
  | "normalizeTextField"
  | "recordTaskCreationAudit"
  | "appendTaskLog"
  | "getAgentDisplayName"
  | "sendAgentMessage"
  | "notifyCeo"
  | "l"
  | "pickL"
  | "broadcast"
  | "isTaskWorkflowInterrupted"
  | "startTaskExecutionForAgent"
> & {
  detectProjectPath: (message: string) => string | null;
};

const REPORT_CLAUDE_PRIORITY_DEPTS = ["planning", "dev", "design", "qa"] as const;
const REPORT_PLAYWRIGHT_MCP_REPO = "https://github.com/microsoft/playwright-mcp.git";
const REPORT_PLAYWRIGHT_MCP_DIR = "tools/playwright-mcp";

const REPORT_DEPT_PRIORITY: Record<string, number> = {
  planning: 0,
  dev: 1,
  design: 2,
  qa: 3,
  operations: 4,
};

const REPORT_DEPT_LABELS: Record<string, string> = {
  planning: "Planning",
  dev: "Development",
  design: "Design",
  qa: "QA",
  operations: "Operations",
};

const REPORT_STATUS_PRIORITY: Record<string, number> = {
  idle: 0,
  break: 1,
  working: 2,
  offline: 3,
};

const REPORT_ROLE_PRIORITY: Record<string, number> = {
  team_leader: 0,
  senior: 1,
  junior: 2,
  intern: 3,
};

export function createReportRoutingTools(deps: ReportRoutingDeps) {
  const {
    db,
    nowMs,
    randomDelay,
    resolveLang,
    detectProjectPath,
    normalizeTextField,
    recordTaskCreationAudit,
    appendTaskLog,
    getAgentDisplayName,
    sendAgentMessage,
    notifyCeo,
    l,
    pickL,
    broadcast,
    isTaskWorkflowInterrupted,
    startTaskExecutionForAgent,
  } = deps;

  function stripReportRequestPrefix(content: string): string {
    return content.replace(/^\s*\[(보고 요청|Report Request|レポート依頼|报告请求)\]\s*/i, "").trim();
  }

  function detectReportOutputFormat(_requestText: string): ReportOutputFormat {
    return "md";
  }

  function sortReportCandidates(candidates: AgentRow[]): AgentRow[] {
    return [...candidates].sort((a, b) => {
      const ad = REPORT_DEPT_PRIORITY[a.department_id || ""] ?? 99;
      const bd = REPORT_DEPT_PRIORITY[b.department_id || ""] ?? 99;
      if (ad !== bd) return ad - bd;

      const as = REPORT_STATUS_PRIORITY[a.status || ""] ?? 99;
      const bs = REPORT_STATUS_PRIORITY[b.status || ""] ?? 99;
      if (as !== bs) return as - bs;

      const ar = REPORT_ROLE_PRIORITY[a.role || ""] ?? 99;
      const br = REPORT_ROLE_PRIORITY[b.role || ""] ?? 99;
      if (ar !== br) return ar - br;

      return a.name.localeCompare(b.name);
    });
  }

  function fetchAgentById(agentId: string | null): AgentRow | null {
    if (!agentId) return null;
    return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as AgentRow | null;
  }

  function fetchClaudePriorityCandidates(): AgentRow[] {
    const placeholders = REPORT_CLAUDE_PRIORITY_DEPTS.map(() => "?").join(",");
    return sortReportCandidates(
      db
        .prepare(
          `
      SELECT * FROM agents
      WHERE status != 'offline'
        AND cli_provider = 'claude'
        AND department_id IN (${placeholders})
    `,
        )
        .all(...REPORT_CLAUDE_PRIORITY_DEPTS) as unknown as AgentRow[],
    );
  }

  function fetchFallbackCandidates(): AgentRow[] {
    return sortReportCandidates(
      db
        .prepare(
          `
      SELECT * FROM agents
      WHERE status != 'offline'
    `,
        )
        .all() as unknown as AgentRow[],
    );
  }

  function pickTopRecommendationsByDept(candidates: AgentRow[]): AgentRow[] {
    const used = new Set<string>();
    const out: AgentRow[] = [];
    for (const agent of candidates) {
      const deptId = String(agent.department_id || "");
      if (!Object.prototype.hasOwnProperty.call(REPORT_DEPT_PRIORITY, deptId)) continue;
      if (used.has(deptId)) continue;
      used.add(deptId);
      out.push(agent);
    }
    return out;
  }

  function formatRecommendationList(candidates: AgentRow[]): string {
    if (candidates.length === 0) return "none";
    return candidates
      .map((agent, idx) => {
        const deptId = String(agent.department_id || "");
        const dept = REPORT_DEPT_LABELS[deptId] || deptId || "Unknown";
        return `${idx + 1}. ${dept}:${agent.name}`;
      })
      .join(" / ");
  }

  function resolveReportAssignee(targetAgentId: string | null): {
    requestedAgent: AgentRow | null;
    assignee: AgentRow | null;
    claudeRecommendations: AgentRow[];
    reroutedToClaude: boolean;
    claudeUnavailable: boolean;
  } {
    const requestedAgent = fetchAgentById(targetAgentId);
    const claudeCandidates = fetchClaudePriorityCandidates();
    const claudeRecommendations = pickTopRecommendationsByDept(claudeCandidates);

    if (claudeCandidates.length > 0) {
      if (requestedAgent && requestedAgent.status !== "offline" && requestedAgent.cli_provider === "claude") {
        return {
          requestedAgent,
          assignee: requestedAgent,
          claudeRecommendations,
          reroutedToClaude: false,
          claudeUnavailable: false,
        };
      }
      return {
        requestedAgent,
        assignee: claudeRecommendations[0] ?? claudeCandidates[0] ?? null,
        claudeRecommendations,
        reroutedToClaude: Boolean(requestedAgent && requestedAgent.cli_provider !== "claude"),
        claudeUnavailable: false,
      };
    }

    const fallbackCandidates = fetchFallbackCandidates();
    const fallbackAssignee =
      requestedAgent && requestedAgent.status !== "offline" ? requestedAgent : (fallbackCandidates[0] ?? null);

    return {
      requestedAgent,
      assignee: fallbackAssignee,
      claudeRecommendations: [],
      reroutedToClaude: false,
      claudeUnavailable: true,
    };
  }

  function pickPlanningReportAssignee(preferredAgentId: string | null): AgentRow | null {
    return resolveReportAssignee(preferredAgentId).assignee;
  }

  function handleReportRequest(targetAgentId: string, ceoMessage: string): boolean {
    const routing = resolveReportAssignee(targetAgentId);
    const reportAssignee = routing.assignee;
    if (!reportAssignee) return false;

    const lang = resolveLang(ceoMessage);
    const cleanRequest = stripReportRequestPrefix(ceoMessage) || ceoMessage.trim();
    const outputFormat: ReportOutputFormat = "md";
    const outputLabel = "MD";
    const taskType = "documentation";
    const t = nowMs();
    const taskId = randomUUID();
    const assigneeDeptId = reportAssignee.department_id || "planning";
    const assigneeDeptName = REPORT_DEPT_LABELS[assigneeDeptId] || assigneeDeptId || "Planning";
    const requestPreview = cleanRequest.length > 64 ? `${cleanRequest.slice(0, 61).trimEnd()}...` : cleanRequest;
    const taskTitle = `보고 문서(MD) 작성: ${requestPreview}`;
    const detectedPath = detectProjectPath(cleanRequest);
    const fileStamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 16);
    const outputPath = `docs/reports/${fileStamp}-report.md`;
    const researchNotesPath = `docs/reports/${fileStamp}-research-notes.md`;
    let linkedProjectId: string | null = null;
    let linkedProjectPath: string | null = detectedPath ?? null;
    if (detectedPath) {
      const projectByPath = db
        .prepare(
          `
      SELECT id, project_path
      FROM projects
      WHERE project_path = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
        )
        .get(detectedPath) as { id: string; project_path: string } | undefined;
      if (projectByPath) {
        linkedProjectId = projectByPath.id;
        linkedProjectPath = projectByPath.project_path;
      }
    }
    if (!linkedProjectId && routing.requestedAgent?.current_task_id) {
      const currentProject = db
        .prepare(
          `
      SELECT t.project_id, p.project_path
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
      LIMIT 1
    `,
        )
        .get(routing.requestedAgent.current_task_id) as
        | {
            project_id: string | null;
            project_path: string | null;
          }
        | undefined;
      linkedProjectId = normalizeTextField(currentProject?.project_id);
      if (!linkedProjectPath) linkedProjectPath = normalizeTextField(currentProject?.project_path);
    }
    const workflowPackKey = resolveWorkflowPackKeyForTask({
      db: db as any,
      projectId: linkedProjectId,
      fallbackPackKey: "web_research_report",
    });
    const recommendationText = formatRecommendationList(routing.claudeRecommendations);

    const description = [
      `[REPORT REQUEST] ${cleanRequest}`,
      "[REPORT FLOW] review_meeting=skip_for_report",
      "[REPORT FLOW] design_review=not_required",
      "[REPORT FLOW] final_regen=not_required",
      "",
      `Primary output format: ${outputLabel}`,
      `Target file path: ${outputPath}`,
      `Research notes path: ${researchNotesPath}`,
      "Tool preset: web-search + playwright-mcp",
      "",
      "Default Tooling (must apply):",
      "- Web search: research the requested topic first and include source URLs + access date for major claims.",
      `- Browser MCP tool: playwright-mcp (${REPORT_PLAYWRIGHT_MCP_REPO})`,
      `- Local browser MCP workspace: ${REPORT_PLAYWRIGHT_MCP_DIR}`,
      `- This repository tracks playwright-mcp as a pinned git submodule at ${REPORT_PLAYWRIGHT_MCP_DIR}; do not auto-clone from runtime.`,
      `- If submodule content is missing: git submodule update --init --recursive ${REPORT_PLAYWRIGHT_MCP_DIR}`,
      "Rules:",
      "- This is a report/documentation request only; do not execute implementation work.",
      "- Follow sequence: research -> evidence notes -> output artifact.",
      "- Create a complete markdown report with structured headings and evidence.",
      routing.claudeUnavailable
        ? "- Claude Code assignee is unavailable in the priority departments; fallback assignment used."
        : "- Claude Code priority routing is enabled.",
      "- Include executive summary, key findings, quantitative evidence, risks, and next actions.",
    ].join("\n");

    db.prepare(
      `
    INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type, workflow_pack_key, project_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?, ?, ?, ?)
  `,
    ).run(
      taskId,
      taskTitle,
      description,
      assigneeDeptId,
      reportAssignee.id,
      linkedProjectId,
      taskType,
      workflowPackKey,
      linkedProjectPath,
      t,
      t,
    );
    recordTaskCreationAudit({
      taskId,
      taskTitle,
      taskStatus: "planned",
      departmentId: assigneeDeptId,
      assignedAgentId: reportAssignee.id,
      taskType,
      projectPath: linkedProjectPath,
      trigger: "workflow.report_request",
      triggerDetail: `format=${outputFormat}; assignee=${reportAssignee.name}`,
      actorType: "agent",
      actorId: reportAssignee.id,
      actorName: reportAssignee.name,
      body: {
        clean_request: cleanRequest,
        output_format: outputFormat,
        output_path: outputPath,
        research_notes_path: researchNotesPath,
      },
    });
    if (linkedProjectId) {
      db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(t, t, linkedProjectId);
    }

    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, reportAssignee.id);
    appendTaskLog(taskId, "system", `Report request received via chat: ${cleanRequest}`);
    appendTaskLog(
      taskId,
      "system",
      `Report routing: assignee=${reportAssignee.name} provider=${reportAssignee.cli_provider || "unknown"} format=${outputLabel}`,
    );
    if (routing.reroutedToClaude && routing.requestedAgent) {
      appendTaskLog(
        taskId,
        "system",
        `Claude Code recommendation applied (requested=${routing.requestedAgent.name}/${routing.requestedAgent.cli_provider || "unknown"}): ${recommendationText}`,
      );
    }
    if (routing.claudeUnavailable) {
      appendTaskLog(
        taskId,
        "system",
        "No Claude Code candidate found in priority departments; fallback assignment used.",
      );
    }
    if (detectedPath) {
      appendTaskLog(taskId, "system", `Project path detected: ${detectedPath}`);
    }

    const assigneeName = getAgentDisplayName(reportAssignee, lang);
    const providerLabel = reportAssignee.cli_provider || "claude";
    sendAgentMessage(
      reportAssignee,
      pickL(
        l(
          [`${assigneeName}입니다. 보고 요청을 접수했습니다. ${outputLabel} 형식으로 작성해 제출하겠습니다.`],
          [`${assigneeName} here. Report request received. I'll deliver it in ${outputLabel} format.`],
          [`${assigneeName}です。レポート依頼を受領しました。${outputLabel}形式で作成して提出します。`],
          [`${assigneeName}收到报告请求，将按${outputLabel}格式完成并提交。`],
        ),
        lang,
      ),
      "report",
      "all",
      null,
      taskId,
    );

    notifyCeo(
      pickL(
        l(
          [
            `[REPORT ROUTING] '${taskTitle}' 요청을 ${assigneeName}(${providerLabel})에게 배정했습니다. 출력 형식: ${outputLabel}`,
          ],
          [
            `[REPORT ROUTING] Assigned '${taskTitle}' to ${assigneeName} (${providerLabel}). Output format: ${outputLabel}`,
          ],
          [
            `[REPORT ROUTING] '${taskTitle}' を ${assigneeName} (${providerLabel}) に割り当てました。出力形式: ${outputLabel}`,
          ],
          [`[REPORT ROUTING] 已将'${taskTitle}'分配给${assigneeName}（${providerLabel}）。输出格式：${outputLabel}`],
        ),
        lang,
      ),
      taskId,
    );
    if (routing.reroutedToClaude && routing.requestedAgent) {
      const requestedName = getAgentDisplayName(routing.requestedAgent, lang);
      notifyCeo(
        pickL(
          l(
            [
              `[CLAUDE RECOMMENDATION] 요청 대상 ${requestedName}(${routing.requestedAgent.cli_provider || "unknown"})는 Claude Code가 아니어서 Claude Code 우선 라우팅을 적용했습니다. 우선순위 추천: ${recommendationText}`,
            ],
            [
              `[CLAUDE RECOMMENDATION] Requested agent ${requestedName} (${routing.requestedAgent.cli_provider || "unknown"}) is not on Claude Code, so Claude-priority routing was applied. Priority recommendations: ${recommendationText}`,
            ],
            [
              `[CLAUDE RECOMMENDATION] 依頼先 ${requestedName}（${routing.requestedAgent.cli_provider || "unknown"}）は Claude Code ではないため、Claude 優先ルーティングを適用しました。優先候補: ${recommendationText}`,
            ],
            [
              `[CLAUDE RECOMMENDATION] 请求目标 ${requestedName}（${routing.requestedAgent.cli_provider || "unknown"}）不是 Claude Code，已启用 Claude 优先路由。优先推荐：${recommendationText}`,
            ],
          ),
          lang,
        ),
        taskId,
      );
    }
    if (routing.claudeUnavailable) {
      notifyCeo(
        pickL(
          l(
            [
              "[CLAUDE RECOMMENDATION] 우선순위 부서(기획>개발>디자인>QA>운영)에서 Claude Code 에이전트를 찾지 못해 현재 담당자에게 마크다운 보고서를 작성하도록 지시했습니다.",
            ],
            [
              "[CLAUDE RECOMMENDATION] No Claude Code agent was found in priority departments (Planning>Development>Design>QA>Operations). The current assignee was instructed to produce a markdown report.",
            ],
            [
              "[CLAUDE RECOMMENDATION] 優先部門（企画>開発>デザイン>QA>運用）に Claude Code エージェントがいないため、現担当者にマークダウン形式のレポート作成を指示しました。",
            ],
            [
              "[CLAUDE RECOMMENDATION] 在优先部门（企划>开发>设计>QA>运营）中未找到 Claude Code 代理，已要求当前负责人输出 Markdown 报告。",
            ],
          ),
          lang,
        ),
        taskId,
      );
    }

    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(reportAssignee.id));

    setTimeout(
      () => {
        if (isTaskWorkflowInterrupted(taskId)) return;
        startTaskExecutionForAgent(taskId, reportAssignee, assigneeDeptId, assigneeDeptName);
      },
      randomDelay(900, 1600),
    );

    return true;
  }

  return {
    stripReportRequestPrefix,
    detectReportOutputFormat,
    pickPlanningReportAssignee,
    handleReportRequest,
  };
}
