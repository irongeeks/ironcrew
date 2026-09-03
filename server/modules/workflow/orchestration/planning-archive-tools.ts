import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "orchestration" });

type CreatePlanningArchiveToolsDeps = Record<string, any>;

export function createPlanningArchiveTools(deps: CreatePlanningArchiveToolsDeps) {
  const {
    db,
    nowMs,
    randomUUID,
    appendTaskLog,
    sendAgentMessage,
    broadcast,
    pickL,
    l,
    resolveLang,
    runAgentOneShot,
    normalizeConversationReply,
    findTeamLeader,
  } = deps;

  function cleanArchiveText(value: unknown): string {
    const raw = typeof value === "string" ? value : "";
    if (!raw) return "";
    const normalized = raw
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "");
    const lines = normalized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^{"type":/i.test(line)) return false;
        if (/^{"id":"item_/i.test(line)) return false;
        if (
          /"type":"(item\.completed|command_execution|reasoning|agent_message|item\.started|item\.in_progress)"/i.test(
            line,
          )
        )
          return false;
        if (/"aggregated_output"|"exit_code"|"session_id"|"total_cost_usd"|"usage"/i.test(line)) return false;
        if (/^\(Use `node --trace-warnings/i.test(line)) return false;
        if (/^command\s+["'`]/i.test(line)) return false;
        if (/^\[[A-Za-z-]+\]\s+/.test(line) && line.includes("listening on http://")) return false;
        return true;
      });
    const text = lines
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return text;
  }

  function clipArchiveText(value: unknown, maxChars = 1800): string {
    const text = cleanArchiveText(value);
    if (!text) return "";
    if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}...`;
  }

  function buildFallbackPlanningArchive(
    rootTask: Record<string, unknown>,
    entries: Array<Record<string, unknown>>,
    lang: string,
  ): string {
    const header = pickL(
      l(
        [`# ${rootTask.title ?? "프로젝트"} 최종 취합 보고서`],
        [`# Final Consolidated Report: ${rootTask.title ?? "Project"}`],
        [`# 最終統合レポート: ${rootTask.title ?? "プロジェクト"}`],
        [`# 最终汇总报告：${rootTask.title ?? "项目"}`],
      ),
      lang,
    );
    const summaryTitle = pickL(l(["## 요약"], ["## Executive Summary"], ["## 要約"], ["## 执行摘要"]), lang);
    const teamTitle = pickL(l(["## 팀별 취합"], ["## Team Consolidation"], ["## チーム別統合"], ["## 团队汇总"]), lang);
    const lines = [
      header,
      "",
      summaryTitle,
      pickL(
        l(
          ["프로젝트 완료 기준으로 팀별 결과를 취합했습니다. 아래 섹션에서 팀별 최신 보고/결과 스니펫을 확인하세요."],
          [
            "Compiled team outputs at project completion. See the sections below for latest team report/result snippets.",
          ],
          ["プロジェクト完了時点でチーム成果を統合しました。以下で各チームの最新報告/結果要約を確認してください。"],
          ["已在项目完成时汇总各团队产出。请在下方查看各团队最新报告/结果摘要。"],
        ),
        lang,
      ),
      "",
      teamTitle,
      "",
    ];
    entries.forEach((entry, idx) => {
      const dept = String(entry.dept_name ?? entry.department_id ?? "-");
      const agent = String(entry.agent_name ?? "-");
      const status = String(entry.status ?? "-");
      const completedAt = Number(entry.completed_at ?? 0);
      const latestReport = String(entry.latest_report ?? "");
      const resultSnippet = String(entry.result_snippet ?? "");
      lines.push(`### ${idx + 1}. ${entry.title ?? "Task"}`);
      lines.push(`- Department: ${dept}`);
      lines.push(`- Agent: ${agent}`);
      lines.push(`- Status: ${status}`);
      lines.push(`- Completed: ${completedAt > 0 ? new Date(completedAt).toISOString() : "-"}`);
      lines.push(`- Latest report: ${latestReport || "-"}`);
      lines.push(`- Result snippet: ${resultSnippet || "-"}`);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  async function archivePlanningConsolidatedReport(rootTaskId: string): Promise<void> {
    try {
      const rootTask = db
        .prepare(
          `
    SELECT id, title, description, project_path, completed_at, department_id
    FROM tasks
    WHERE id = ?
  `,
        )
        .get(rootTaskId) as
        | {
            id: string;
            title: string;
            description: string | null;
            project_path: string | null;
            completed_at: number | null;
            department_id: string | null;
          }
        | undefined;
      if (!rootTask) return;

      const planningLeader = findTeamLeader("planning") || findTeamLeader(rootTask.department_id ?? "");
      if (!planningLeader) return;

      const relatedTasks = db
        .prepare(
          `
    SELECT t.id, t.title, t.status, t.department_id, t.assigned_agent_id, t.result, t.completed_at,
           COALESCE(a.name, '') AS agent_name,
           COALESCE(a.name_ko, '') AS agent_name_ko,
           COALESCE(d.name, '') AS dept_name,
           COALESCE(d.name_ko, '') AS dept_name_ko
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    LEFT JOIN departments d ON d.id = t.department_id
    WHERE t.id = ? OR t.source_task_id = ?
    ORDER BY CASE WHEN t.id = ? THEN 0 ELSE 1 END, t.created_at ASC
  `,
        )
        .all(rootTaskId, rootTaskId, rootTaskId) as Array<{
        id: string;
        title: string;
        status: string;
        department_id: string | null;
        dept_name: string;
        agent_name: string;
        completed_at: number | null;
        result: string | null;
      }>;
      if (!relatedTasks.length) return;

      const entries = relatedTasks.map((task) => {
        const latestReport = db
          .prepare(
            `
      SELECT m.content, m.created_at
      FROM messages m
      WHERE m.task_id = ? AND m.message_type = 'report'
        AND m.content NOT LIKE '%최종 취합본을 생성해 아카이빙%'
        AND m.content NOT LIKE '%consolidated final report has been generated and archived%'
        AND m.content NOT LIKE '%最終統合レポートを生成し、アーカイブ%'
        AND m.content NOT LIKE '%最终汇总报告已生成并归档%'
      ORDER BY m.created_at DESC
      LIMIT 1
    `,
          )
          .get(task.id) as { content: string; created_at: number } | undefined;
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          department_id: task.department_id,
          dept_name: task.dept_name,
          agent_name: task.agent_name,
          completed_at: task.completed_at,
          latest_report: clipArchiveText(latestReport?.content ?? "", 0),
          result_snippet: clipArchiveText(task.result ?? "", 0),
        };
      });

      const lang = resolveLang(rootTask.description ?? rootTask.title);
      const projectPath = rootTask.project_path || process.cwd();
      const evidenceBlock = entries
        .map((entry, idx) =>
          [
            `### ${idx + 1}. ${entry.title ?? "Task"}`,
            `- Department: ${entry.dept_name || entry.department_id || "-"}`,
            `- Agent: ${entry.agent_name || "-"}`,
            `- Status: ${entry.status || "-"}`,
            `- Latest report: ${entry.latest_report || "-"}`,
            `- Result snippet: ${entry.result_snippet || "-"}`,
          ].join("\n"),
        )
        .join("\n\n");

      const consolidationPrompt = [
        `You are the planning lead (${planningLeader.name}).`,
        `Create one final consolidated markdown report for the CEO in language: ${lang}.`,
        "Requirements:",
        "- Must be concrete, not generic.",
        "- Include: Executive Summary, Team-by-team Consolidation, Evidence & Logs, Risks, Final Approval Note.",
        "- Mention all participating teams/tasks from the source.",
        "- Output only markdown.",
        `Project title: ${rootTask.title}`,
        `Project root task id: ${rootTaskId}`,
        "",
        "Source material:",
        evidenceBlock,
      ].join("\n");

      let summaryMarkdown = "";
      try {
        const run = await runAgentOneShot(planningLeader, consolidationPrompt, {
          projectPath,
          timeoutMs: 45_000,
          noTools: true,
        });
        summaryMarkdown = cleanArchiveText(
          normalizeConversationReply(run.text || "", 12_000, { maxSentences: 0 }).trim(),
        );
      } catch {
        summaryMarkdown = "";
      }

      if (!summaryMarkdown || summaryMarkdown.length < 240) {
        summaryMarkdown = buildFallbackPlanningArchive(rootTask as Record<string, unknown>, entries, lang);
      }
      const evidenceHeader = pickL(
        l(
          ["## 취합 근거 스냅샷"],
          ["## Consolidation Evidence Snapshot"],
          ["## 統合エビデンス概要"],
          ["## 汇总证据快照"],
        ),
        lang,
      );
      const hasEvidenceHeader = summaryMarkdown.includes(evidenceHeader);
      if (!hasEvidenceHeader) {
        const evidenceLines = entries
          .map((entry, idx) => {
            const dept = String(entry.dept_name || entry.department_id || "-");
            const agent = String(entry.agent_name || "-");
            const latestReport = cleanArchiveText(entry.latest_report ?? "");
            const resultSnippet = cleanArchiveText(entry.result_snippet ?? "");
            return [
              `### ${idx + 1}. ${entry.title ?? "Task"}`,
              `- Department: ${dept}`,
              `- Agent: ${agent}`,
              `- Status: ${entry.status || "-"}`,
              `- Latest report: ${latestReport || "-"}`,
              `- Result snippet: ${resultSnippet || "-"}`,
            ].join("\n");
          })
          .join("\n\n");
        summaryMarkdown = `${summaryMarkdown}\n\n${evidenceHeader}\n\n${evidenceLines}`.trim();
      }

      const t = nowMs();
      const snapshot = JSON.stringify({
        root_task_id: rootTaskId,
        generated_at: t,
        entries,
      });
      db.prepare(
        `
    INSERT INTO task_report_archives (
      id, root_task_id, generated_by_agent_id, summary_markdown, source_snapshot_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root_task_id) DO UPDATE SET
      generated_by_agent_id = excluded.generated_by_agent_id,
      summary_markdown = excluded.summary_markdown,
      source_snapshot_json = excluded.source_snapshot_json,
      updated_at = excluded.updated_at
  `,
      ).run(randomUUID(), rootTaskId, planningLeader.id, summaryMarkdown, snapshot, t, t);

      appendTaskLog(
        rootTaskId,
        "system",
        `Planning consolidated archive updated (${planningLeader.name}, chars=${summaryMarkdown.length})`,
      );
      sendAgentMessage(
        planningLeader,
        pickL(
          l(
            ["대표님, 기획팀장 최종 취합본을 생성해 아카이빙했습니다. 보고서 팝업에서 확인하실 수 있습니다."],
            [
              "CEO, the planning lead consolidated final report has been generated and archived. You can review it from the report popup.",
            ],
            ["CEO、企画リード最終統合レポートを生成し、アーカイブしました。レポートポップアップから確認できます。"],
            ["CEO，规划负责人最终汇总报告已生成并归档，可在报告弹窗中查看。"],
          ),
          lang,
        ),
        "report",
        "all",
        null,
        rootTaskId,
      );
      broadcast("task_report", { task: { id: rootTaskId } });
    } catch (err) {
      log.error({ err }, "planning archive generation error");
    }
  }

  return {
    cleanArchiveText,
    clipArchiveText,
    buildFallbackPlanningArchive,
    archivePlanningConsolidatedReport,
  };
}
