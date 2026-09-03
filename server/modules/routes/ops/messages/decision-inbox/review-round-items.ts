import type { ReviewRoundDecisionItem, ReviewRoundDecisionItemDeps, ReviewRoundDecisionItems } from "./types.ts";

const DECISION_COLLECTING_STALE_MS = 20_000;

export function createReviewRoundDecisionItems(deps: ReviewRoundDecisionItemDeps): ReviewRoundDecisionItems {
  const {
    db,
    nowMs,
    getPreferredLanguage,
    pickL,
    l,
    buildReviewRoundSnapshotHash,
    getReviewRoundDecisionState,
    upsertReviewRoundDecisionState,
    resolvePlanningLeadMeta,
    formatPlannerSummaryForDisplay,
    queueReviewRoundPlanningConsolidation,
  } = deps;

  function getReviewDecisionFallbackLabel(lang: string): string {
    return pickL(l(["기존 작업 이어서 진행"], ["Continue Existing Work"], ["既存作業を継続"], ["继续现有工作"]), lang);
  }

  function getReviewDecisionNotes(taskId: string, reviewRound: number, limit = 6): string[] {
    const boundedLimit = Math.max(1, Math.min(limit, 12));
    const rawRows = db
      .prepare(
        `
      SELECT raw_note
      FROM review_revision_history
      WHERE task_id = ?
        AND first_round <= ?
      ORDER BY
        CASE WHEN first_round = ? THEN 0 ELSE 1 END ASC,
        first_round DESC,
        id DESC
      LIMIT ?
    `,
      )
      .all(taskId, reviewRound, reviewRound, Math.max(boundedLimit * 3, boundedLimit)) as Array<{
      raw_note: string | null;
    }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rawRows) {
      const normalized = String(row.raw_note ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= limit) break;
    }
    return out;
  }

  function buildReviewRoundDecisionItems(): ReviewRoundDecisionItem[] {
    const lang = getPreferredLanguage();
    const t = (ko: string, en: string, ja: string, zh: string) => pickL(l([ko], [en], [ja], [zh]), lang);
    const rows = db
      .prepare(
        `
      SELECT
        t.id AS task_id,
        t.title AS task_title,
        t.project_id AS project_id,
        p.name AS project_name,
        t.project_path AS project_path,
        mm.id AS meeting_id,
        mm.round AS meeting_round,
        mm.started_at AS meeting_started_at,
        mm.completed_at AS meeting_completed_at
      FROM tasks t
      JOIN meeting_minutes mm ON mm.task_id = t.id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'review'
        AND t.source_task_id IS NULL
        AND mm.meeting_type = 'review'
        AND mm.round IN (1, 2)
        AND mm.status = 'revision_requested'
        AND mm.id = (
          SELECT mm2.id
          FROM meeting_minutes mm2
          WHERE mm2.task_id = t.id
            AND mm2.meeting_type = 'review'
          ORDER BY mm2.started_at DESC, mm2.created_at DESC
          LIMIT 1
        )
      ORDER BY COALESCE(mm.completed_at, mm.started_at) DESC
      LIMIT 120
    `,
      )
      .all() as Array<{
      task_id: string;
      task_title: string | null;
      project_id: string | null;
      project_name: string | null;
      project_path: string | null;
      meeting_id: string;
      meeting_round: number;
      meeting_started_at: number | null;
      meeting_completed_at: number | null;
    }>;

    const out: ReviewRoundDecisionItem[] = [];
    for (const row of rows) {
      const notesRaw = getReviewDecisionNotes(row.task_id, row.meeting_round, 6);
      const notes = notesRaw.length > 0 ? notesRaw : [getReviewDecisionFallbackLabel(lang)];

      const taskTitle = (row.task_title || row.task_id).trim();
      const projectName = row.project_name ? row.project_name.trim() : null;
      const nextRound = Math.max(2, row.meeting_round + 1);
      const options = notes.map((note, index) => {
        return {
          number: index + 1,
          action: "apply_review_pick",
          label: note,
        };
      });
      options.push({
        number: notes.length + 1,
        action: "skip_to_next_round",
        label: t("다음 라운드로 SKIP", "Skip to Next Round", "次ラウンドへスキップ", "跳到下一轮"),
      });

      const summary = t(
        `라운드 ${row.meeting_round} 팀장 의견이 취합되었습니다.\n작업: '${taskTitle}'\n${projectName ? `프로젝트: '${projectName}'\n` : ""}필요한 의견을 여러 개 체리피킹하고, 추가 의견도 함께 입력해 보완 작업을 진행할 수 있습니다.\n또는 '다음 라운드로 SKIP'을 선택해 라운드 ${nextRound}(으)로 바로 진행할 수 있습니다.`,
        `Round ${row.meeting_round} team-lead opinions are consolidated.\nTask: '${taskTitle}'\n${projectName ? `Project: '${projectName}'\n` : ""}You can cherry-pick multiple opinions and include an extra note for remediation in one batch.\nOr choose 'Skip to Next Round' to move directly to round ${nextRound}.`,
        `ラウンド${row.meeting_round}のチームリーダー意見が集約されました。\nタスク: '${taskTitle}'\n${projectName ? `プロジェクト: '${projectName}'\n` : ""}必要な意見を複数チェリーピックし、追加意見も入力して一括補完できます。\nまたは「次ラウンドへスキップ」でラウンド${nextRound}へ進めます。`,
        `第 ${row.meeting_round} 轮组长意见已汇总。\n任务：'${taskTitle}'\n${projectName ? `项目：'${projectName}'\n` : ""}可多选意见并追加输入补充意见，一次性执行整改。\n也可选择“跳到下一轮”直接进入第 ${nextRound} 轮。`,
      );

      const snapshotHash = buildReviewRoundSnapshotHash(row.meeting_id, row.meeting_round, notes);
      const existingState = getReviewRoundDecisionState(row.meeting_id);
      const now = nowMs();
      const stateNeedsReset = !existingState || existingState.snapshot_hash !== snapshotHash;
      if (stateNeedsReset) {
        upsertReviewRoundDecisionState(row.meeting_id, snapshotHash, "collecting", null, null, null);
      } else if (existingState.status === "failed" && now - (existingState.updated_at ?? 0) > 3000) {
        upsertReviewRoundDecisionState(row.meeting_id, snapshotHash, "collecting", null, null, null);
      }
      const decisionState = getReviewRoundDecisionState(row.meeting_id);
      const planningLeadMeta = resolvePlanningLeadMeta(lang, decisionState);
      const collectingElapsedMs =
        decisionState?.status === "collecting"
          ? now - (decisionState.updated_at ?? decisionState.created_at ?? now)
          : 0;
      const useCollectingFallback = Boolean(
        decisionState && decisionState.status === "collecting" && collectingElapsedMs >= DECISION_COLLECTING_STALE_MS,
      );
      if (!decisionState || (decisionState.status !== "ready" && !useCollectingFallback)) {
        queueReviewRoundPlanningConsolidation({
          projectId: row.project_id,
          projectName: row.project_name,
          projectPath: row.project_path,
          taskId: row.task_id,
          taskTitle,
          meetingId: row.meeting_id,
          reviewRound: row.meeting_round,
          optionNotes: notes,
          snapshotHash,
          lang,
        });
        const collectingSummary = t(
          `라운드 ${row.meeting_round} 팀장 의견이 취합되었습니다.\n작업: '${taskTitle}'\n${projectName ? `프로젝트: '${projectName}'\n` : ""}기획팀장 의견 취합중...\n취합 완료 후 팀별 의견 요약과 권장 선택안이 표시됩니다.`,
          `Round ${row.meeting_round} team-lead opinions are consolidated.\nTask: '${taskTitle}'\n${projectName ? `Project: '${projectName}'\n` : ""}Planning lead is consolidating recommendations...\nTeam summary and recommended picks will appear after consolidation.`,
          `ラウンド${row.meeting_round}のチームリーダー意見が集約されました。\nタスク: '${taskTitle}'\n${projectName ? `プロジェクト: '${projectName}'\n` : ""}企画リードが推奨案を集約中...\n集約完了後、チーム別要約と推奨選択が表示されます。`,
          `第 ${row.meeting_round} 轮组长意见已汇总。\n任务：'${taskTitle}'\n${projectName ? `项目：'${projectName}'\n` : ""}规划负责人正在汇总建议...\n完成后将显示各团队摘要与推荐选项。`,
        );
        out.push({
          id: `review-round-pick:${row.task_id}:${row.meeting_id}`,
          kind: "review_round_pick",
          created_at: row.meeting_completed_at ?? row.meeting_started_at ?? now,
          summary: collectingSummary,
          agent_id: planningLeadMeta.agent_id,
          agent_name: planningLeadMeta.agent_name,
          agent_name_ko: planningLeadMeta.agent_name_ko,
          agent_avatar: planningLeadMeta.agent_avatar,
          project_id: row.project_id,
          project_name: row.project_name,
          project_path: row.project_path,
          task_id: row.task_id,
          task_title: row.task_title,
          meeting_id: row.meeting_id,
          review_round: row.meeting_round,
          options: [],
        });
        continue;
      }

      const plannerHeader = useCollectingFallback
        ? t(
            "기획팀장 취합 지연 - 기본 선택지로 진행",
            "Planning consolidation delayed - proceeding with baseline options",
            "企画リード集約遅延 - 基本選択肢で進行",
            "规划汇总延迟 - 以基础选项继续",
          )
        : t(
            "기획팀장 의견 취합 완료",
            "Planning consolidation complete",
            "企画リード意見集約完了",
            "规划负责人意见汇总完成",
          );
      const plannerSummary = useCollectingFallback
        ? ""
        : formatPlannerSummaryForDisplay(String(decisionState?.planner_summary ?? "").trim());
      const optionGuide = options.map((option) => `${option.number}. ${option.label}`).join("\n");
      const optionGuideBlock = optionGuide
        ? t(
            `현재 선택 가능한 항목:\n${optionGuide}`,
            `Available options now:\n${optionGuide}`,
            `現在選択可能な項目:\n${optionGuide}`,
            `当前可选项:\n${optionGuide}`,
          )
        : "";
      const combinedSummaryBase = plannerSummary
        ? `${plannerHeader}\n${plannerSummary}\n\n${summary}`
        : `${plannerHeader}\n\n${summary}`;
      const combinedSummary = optionGuideBlock ? `${combinedSummaryBase}\n\n${optionGuideBlock}` : combinedSummaryBase;

      out.push({
        id: `review-round-pick:${row.task_id}:${row.meeting_id}`,
        kind: "review_round_pick",
        created_at: row.meeting_completed_at ?? row.meeting_started_at ?? now,
        summary: combinedSummary,
        agent_id: planningLeadMeta.agent_id,
        agent_name: planningLeadMeta.agent_name,
        agent_name_ko: planningLeadMeta.agent_name_ko,
        agent_avatar: planningLeadMeta.agent_avatar,
        project_id: row.project_id,
        project_name: row.project_name,
        project_path: row.project_path,
        task_id: row.task_id,
        task_title: row.task_title,
        meeting_id: row.meeting_id,
        review_round: row.meeting_round,
        options,
      });
    }
    return out;
  }

  return {
    getReviewDecisionFallbackLabel,
    getReviewDecisionNotes,
    buildReviewRoundDecisionItems,
  };
}
