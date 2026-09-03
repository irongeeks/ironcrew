import type {
  ProjectAndTimeoutDecisionItemDeps,
  ProjectAndTimeoutDecisionItems,
  ProjectReviewDecisionItem,
  ProjectReviewTaskChoice,
  TimeoutResumeDecisionItem,
} from "./types.ts";

const DECISION_COLLECTING_STALE_MS = 20_000;

export function createProjectAndTimeoutDecisionItems(
  deps: ProjectAndTimeoutDecisionItemDeps,
): ProjectAndTimeoutDecisionItems {
  const {
    db,
    nowMs,
    getPreferredLanguage,
    pickL,
    l,
    buildProjectReviewSnapshotHash,
    getProjectReviewDecisionState,
    upsertProjectReviewDecisionState,
    resolvePlanningLeadMeta,
    formatPlannerSummaryForDisplay,
    queueProjectReviewPlanningConsolidation,
    PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX,
  } = deps;

  function getProjectReviewTaskChoices(projectId: string): ProjectReviewTaskChoice[] {
    const selectionPattern = `${PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX}%`;
    const rows = db
      .prepare(
        `
      SELECT
        t.id,
        t.title,
        t.updated_at,
        (
          SELECT MAX(tl.created_at)
          FROM task_logs tl
          WHERE tl.task_id = t.id
            AND tl.kind = 'system'
            AND tl.message LIKE ?
        ) AS selected_at
      FROM tasks t
      WHERE t.project_id = ?
        AND t.status = 'review'
        AND t.source_task_id IS NULL
      ORDER BY t.updated_at ASC, t.created_at ASC
    `,
      )
      .all(selectionPattern, projectId) as Array<{
      id: string;
      title: string;
      updated_at: number;
      selected_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      selected: (row.selected_at ?? 0) >= (row.updated_at ?? 0),
    }));
  }

  function buildProjectReviewDecisionItems(): ProjectReviewDecisionItem[] {
    const lang = getPreferredLanguage();
    const t = (ko: string, en: string, ja: string, zh: string) => pickL(l([ko], [en], [ja], [zh]), lang);

    const rows = db
      .prepare(
        `
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        p.project_path AS project_path,
        MAX(t.updated_at) AS updated_at,
        SUM(CASE WHEN t.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS active_total,
        SUM(CASE WHEN t.status NOT IN ('done', 'cancelled') AND t.status = 'review' THEN 1 ELSE 0 END) AS active_review,
        SUM(CASE WHEN t.status = 'review' AND t.source_task_id IS NULL THEN 1 ELSE 0 END) AS root_review_total
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id IS NOT NULL
      GROUP BY p.id, p.name, p.project_path
    `,
      )
      .all() as Array<{
      project_id: string;
      project_name: string | null;
      project_path: string | null;
      updated_at: number | null;
      active_total: number | null;
      active_review: number | null;
      root_review_total: number | null;
    }>;

    const out: ProjectReviewDecisionItem[] = [];
    for (const row of rows) {
      const activeTotal = row.active_total ?? 0;
      const activeReview = row.active_review ?? 0;
      const rootReviewTotal = row.root_review_total ?? 0;
      if (activeTotal <= 0) continue;
      if (activeTotal !== activeReview) continue;
      if (rootReviewTotal <= 0) continue;

      const inProgressMeeting = db
        .prepare(
          `
        SELECT COUNT(*) AS cnt
        FROM meeting_minutes mm
        JOIN tasks t ON t.id = mm.task_id
        WHERE t.project_id = ?
          AND t.status = 'review'
          AND t.source_task_id IS NULL
          AND mm.meeting_type = 'review'
          AND mm.status = 'in_progress'
      `,
        )
        .get(row.project_id) as { cnt: number } | undefined;
      if ((inProgressMeeting?.cnt ?? 0) > 0) continue;

      // Do not show project-level decision while any round 1/2 review decision is pending.
      // Round-level cherry-pick/skip should be resolved first to avoid simultaneous mixed cards.
      const pendingRoundDecision = db
        .prepare(
          `
        SELECT COUNT(*) AS cnt
        FROM tasks t
        JOIN meeting_minutes mm ON mm.task_id = t.id
        WHERE t.project_id = ?
          AND t.status = 'review'
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
      `,
        )
        .get(row.project_id) as { cnt: number } | undefined;
      if ((pendingRoundDecision?.cnt ?? 0) > 0) continue;

      const reviewTaskChoices = getProjectReviewTaskChoices(row.project_id);
      if (reviewTaskChoices.length <= 0) continue;
      const requiresRepresentativeSelection = reviewTaskChoices.length > 1;
      const pendingChoices = requiresRepresentativeSelection ? reviewTaskChoices.filter((task) => !task.selected) : [];
      const selectedCount = reviewTaskChoices.length - pendingChoices.length;
      const decisionTargetTotal = reviewTaskChoices.length;
      const projectName = (row.project_name || row.project_id).trim();
      const taskProgressLine = t(
        `항목 선택 진행: ${selectedCount}/${reviewTaskChoices.length}`,
        `Selection progress: ${selectedCount}/${reviewTaskChoices.length}`,
        `選択進捗: ${selectedCount}/${reviewTaskChoices.length}`,
        `选择进度: ${selectedCount}/${reviewTaskChoices.length}`,
      );
      const continueExistingLabel = t(
        "기존 작업 이어서 진행",
        "Continue Existing Work",
        "既存作業を継続",
        "继续现有工作",
      );
      const pendingList =
        pendingChoices.length > 0
          ? pendingChoices.length === 1
            ? `- ${continueExistingLabel}`
            : pendingChoices
                .slice(0, 6)
                .map((task) => `- ${task.title}`)
                .join("\n")
          : t(
              "모든 활성 항목 선택이 완료되었습니다.",
              "All active items are selected.",
              "すべてのアクティブ項目の選択が完了しました。",
              "所有活跃项已完成选择。",
            );
      const summary =
        pendingChoices.length > 0
          ? t(
              `프로젝트 '${projectName}'의 활성 항목 ${activeTotal}건이 모두 Review 상태입니다.\n대표 선택 대상 ${decisionTargetTotal}건을 먼저 선택해 주세요.\n${taskProgressLine}\n${pendingList}`,
              `Project '${projectName}' has all ${activeTotal} active items in Review.\nSelect the ${decisionTargetTotal} target item(s) first.\n${taskProgressLine}\n${pendingList}`,
              `プロジェクト'${projectName}'のアクティブ項目${activeTotal}件はすべてReview状態です。\n代表者の選択対象${decisionTargetTotal}件を先に選択してください。\n${taskProgressLine}\n${pendingList}`,
              `项目'${projectName}'的 ${activeTotal} 个活跃项已全部进入 Review。\n请先选择代表决策目标 ${decisionTargetTotal} 项。\n${taskProgressLine}\n${pendingList}`,
            )
          : requiresRepresentativeSelection
            ? t(
                `프로젝트 '${projectName}'의 활성 항목 ${activeTotal}건이 모두 Review 상태입니다.\n대표 선택 대상 ${decisionTargetTotal}건 선택이 완료되었습니다.\n아래 선택지에서 다음 단계를 선택해 주세요.`,
                `Project '${projectName}' has all ${activeTotal} active items in Review.\nSelection for ${decisionTargetTotal} target item(s) is complete.\nChoose the next step from the options below.`,
                `プロジェクト'${projectName}'のアクティブ項目${activeTotal}件はすべてReview状態です。\n代表者の選択対象${decisionTargetTotal}件の選択が完了しました。\n以下の選択肢から次のステップを選んでください。`,
                `项目'${projectName}'的 ${activeTotal} 个活跃项已全部进入 Review。\n代表决策目标 ${decisionTargetTotal} 项已选择完成。\n请从下方选项中选择下一步。`,
              )
            : t(
                `프로젝트 '${projectName}'의 활성 항목 ${activeTotal}건이 모두 Review 상태입니다.\n대표 선택 단계는 필요하지 않습니다.\n아래 선택지에서 진행 방식을 선택해 주세요.`,
                `Project '${projectName}' has all ${activeTotal} active items in Review.\nA representative pick step is not required.\nChoose how to proceed from the options below.`,
                `プロジェクト'${projectName}'のアクティブ項目${activeTotal}件はすべてReview状態です。\n代表選択ステップは不要です。\n以下の選択肢から進行方法を選択してください。`,
                `项目'${projectName}'的 ${activeTotal} 个活跃项已全部进入 Review。\n无需代表选择步骤。\n请从下方选项中选择推进方式。`,
              );
      const readyOptions =
        pendingChoices.length > 0
          ? [
              ...pendingChoices.map((task, index) => ({
                number: index + 1,
                action: `approve_task_review:${task.id}`,
                label:
                  pendingChoices.length === 1
                    ? continueExistingLabel
                    : t(
                        `항목 선택: ${task.title}`,
                        `Select Item: ${task.title}`,
                        `項目選択: ${task.title}`,
                        `选择项: ${task.title}`,
                      ),
              })),
              {
                number: pendingChoices.length + 1,
                action: "add_followup_request",
                label: t("추가요청 입력", "Add Follow-up Request", "追加要請を入力", "输入追加请求"),
              },
            ]
          : [
              {
                number: 1,
                action: "start_project_review",
                label: t("팀장 회의 진행", "Start Team-Lead Meeting", "チームリーダー会議を進行", "启动组长评审会议"),
              },
              {
                number: 2,
                action: "add_followup_request",
                label: t("추가요청 입력", "Add Follow-up Request", "追加要請を入力", "输入追加请求"),
              },
            ];

      const snapshotHash = buildProjectReviewSnapshotHash(
        row.project_id,
        reviewTaskChoices.map((task) => ({ id: task.id, updated_at: task.updated_at })),
      );
      const existingState = getProjectReviewDecisionState(row.project_id);
      const now = nowMs();
      const stateNeedsReset = !existingState || existingState.snapshot_hash !== snapshotHash;
      if (stateNeedsReset) {
        upsertProjectReviewDecisionState(row.project_id, snapshotHash, "collecting", null, null, null);
      } else if (existingState.status === "failed" && now - (existingState.updated_at ?? 0) > 3000) {
        upsertProjectReviewDecisionState(row.project_id, snapshotHash, "collecting", null, null, null);
      }
      const decisionState = getProjectReviewDecisionState(row.project_id);
      const planningLeadMeta = resolvePlanningLeadMeta(lang, decisionState);
      const collectingElapsedMs =
        decisionState?.status === "collecting"
          ? now - (decisionState.updated_at ?? decisionState.created_at ?? now)
          : 0;
      const useCollectingFallback = Boolean(
        decisionState && decisionState.status === "collecting" && collectingElapsedMs >= DECISION_COLLECTING_STALE_MS,
      );
      if (!decisionState || (decisionState.status !== "ready" && !useCollectingFallback)) {
        queueProjectReviewPlanningConsolidation(row.project_id, projectName, row.project_path, snapshotHash, lang);
        const collectingSummary = t(
          `프로젝트 '${projectName}'의 활성 항목 ${activeTotal}건이 모두 Review 상태입니다.\n기획팀장 의견 취합중...\n취합 완료 후 대표 선택지와 회의 진행 선택지가 나타납니다.`,
          `Project '${projectName}' has all ${activeTotal} active items in Review.\nPlanning lead is consolidating opinions...\nRepresentative options and meeting action will appear after consolidation.`,
          `プロジェクト'${projectName}'のアクティブ項目${activeTotal}件はすべてReview状態です。\n企画リードが意見を集約中...\n集約完了後に代表選択肢と会議進行選択肢が表示されます。`,
          `项目'${projectName}'的 ${activeTotal} 个活跃项已全部进入 Review。\n规划负责人正在汇总意见...\n汇总完成后将显示代表选择项与会议启动选项。`,
        );
        out.push({
          id: `project-review-ready:${row.project_id}`,
          kind: "project_review_ready",
          created_at: row.updated_at ?? now,
          summary: collectingSummary,
          agent_id: planningLeadMeta.agent_id,
          agent_name: planningLeadMeta.agent_name,
          agent_name_ko: planningLeadMeta.agent_name_ko,
          agent_avatar: planningLeadMeta.agent_avatar,
          project_id: row.project_id,
          project_name: row.project_name,
          project_path: row.project_path,
          task_id: null,
          task_title: null,
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
      const optionGuide =
        pendingChoices.length <= 0 ? readyOptions.map((option) => `${option.number}. ${option.label}`).join("\n") : "";
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
        id: `project-review-ready:${row.project_id}`,
        kind: "project_review_ready",
        created_at: row.updated_at ?? now,
        summary: combinedSummary,
        agent_id: planningLeadMeta.agent_id,
        agent_name: planningLeadMeta.agent_name,
        agent_name_ko: planningLeadMeta.agent_name_ko,
        agent_avatar: planningLeadMeta.agent_avatar,
        project_id: row.project_id,
        project_name: row.project_name,
        project_path: row.project_path,
        task_id: reviewTaskChoices.length > 0 ? reviewTaskChoices[reviewTaskChoices.length - 1].id : null,
        task_title: reviewTaskChoices.length > 0 ? reviewTaskChoices[reviewTaskChoices.length - 1].title : null,
        options: readyOptions,
      });
    }

    return out;
  }

  function buildTimeoutResumeDecisionItems(): TimeoutResumeDecisionItem[] {
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
        t.updated_at AS updated_at,
        (
          SELECT MAX(tl.created_at)
          FROM task_logs tl
          WHERE tl.task_id = t.id
            AND tl.message LIKE '%RUN TIMEOUT%'
        ) AS timeout_at
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'inbox'
        AND EXISTS (
          SELECT 1
          FROM task_logs tl
          WHERE tl.task_id = t.id
            AND tl.message LIKE '%RUN TIMEOUT%'
        )
      ORDER BY COALESCE(timeout_at, t.updated_at) DESC, t.updated_at DESC
      LIMIT 200
    `,
      )
      .all() as Array<{
      task_id: string;
      task_title: string;
      project_id: string | null;
      project_name: string | null;
      project_path: string | null;
      updated_at: number | null;
      timeout_at: number | null;
    }>;

    return rows.map((row) => ({
      id: `task-timeout-resume:${row.task_id}`,
      kind: "task_timeout_resume",
      created_at: row.timeout_at ?? row.updated_at ?? nowMs(),
      summary: t(
        `작업 '${row.task_title}' 이(가) timeout 후 Inbox로 이동했습니다. 이어서 진행할까요?`,
        `Task '${row.task_title}' moved to Inbox after timeout. Continue from where it left off?`,
        `タスク'${row.task_title}'はタイムアウト後にInboxへ移動しました。続行しますか？`,
        `任务'${row.task_title}'超时后已移至 Inbox，是否继续执行？`,
      ),
      project_id: row.project_id,
      project_name: row.project_name,
      project_path: row.project_path,
      task_id: row.task_id,
      task_title: row.task_title,
      options: [
        {
          number: 1,
          action: "resume_timeout_task",
          label: t("이어서 진행 (재개)", "Resume Task", "続行する（再開）", "继续执行（恢复）"),
        },
        {
          number: 2,
          action: "keep_inbox",
          label: t("Inbox 유지", "Keep in Inbox", "Inboxで保留", "保留在 Inbox"),
        },
      ],
    }));
  }

  return {
    getProjectReviewTaskChoices,
    buildProjectReviewDecisionItems,
    buildTimeoutResumeDecisionItems,
  };
}
