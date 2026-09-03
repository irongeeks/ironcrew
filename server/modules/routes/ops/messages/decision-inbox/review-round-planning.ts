import type { ReviewRoundPlanningDeps, ReviewRoundPlanningHelpers } from "./types.ts";

export function createReviewRoundPlanningHelpers(deps: ReviewRoundPlanningDeps): ReviewRoundPlanningHelpers {
  const {
    db,
    nowMs,
    l,
    pickL,
    findTeamLeader,
    runAgentOneShot,
    chooseSafeReply,
    getAgentDisplayName,
    getReviewRoundDecisionState,
    formatPlannerSummaryForDisplay,
    recordProjectReviewDecisionEvent,
    getProjectReviewDecisionState,
  } = deps;
  const reviewRoundDecisionConsolidationInFlight = new Set<string>();

  function buildReviewRoundPlanningFallbackSummary(
    lang: string,
    taskTitle: string,
    reviewRound: number,
    optionNotes: string[],
    projectName?: string | null,
  ): string {
    const clip = (text: string, max = 240) => {
      const normalized = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "";
      return normalized.length > max ? `${normalized.slice(0, max - 3).trimEnd()}...` : normalized;
    };
    const lines = optionNotes
      .slice(0, 6)
      .map((note, idx) => `${idx + 1}. ${clip(note)}`)
      .filter(Boolean);
    const optionBlock =
      lines.length > 0
        ? lines.join("\n")
        : pickL(
            l(
              ["- 취합할 라운드 의견이 없습니다."],
              ["- No round opinions to consolidate."],
              ["- 集約対象のラウンド意見がありません。"],
              ["- 暂无可汇总的轮次意见。"],
            ),
            lang,
          );
    return pickL(
      l(
        [
          `라운드 ${reviewRound} 의견을 기획팀장이 우선 취합했습니다.\n작업: '${taskTitle}'\n${projectName ? `프로젝트: '${projectName}'\n` : ""}아래 번호 중 우선순위가 높은 보완 항목을 먼저 선택하고, 필요 시 추가 의견을 함께 넣어 보완 라운드를 여세요.\n\n검토 선택지:\n${optionBlock}`,
        ],
        [
          `Planning lead pre-consolidated round ${reviewRound} opinions.\nTask: '${taskTitle}'\n${projectName ? `Project: '${projectName}'\n` : ""}Pick the highest-priority remediation options first, and add an extra note only when needed.\n\nCandidate options:\n${optionBlock}`,
        ],
        [
          `企画リードがラウンド${reviewRound}意見を先行集約しました。\nタスク: '${taskTitle}'\n${projectName ? `プロジェクト: '${projectName}'\n` : ""}優先度の高い補完項目から選択し、必要な場合のみ追加意見を入力してください。\n\n候補選択肢:\n${optionBlock}`,
        ],
        [
          `规划负责人已先行汇总第 ${reviewRound} 轮意见。\n任务：'${taskTitle}'\n${projectName ? `项目：'${projectName}'\n` : ""}请先选择优先级最高的补充整改项，必要时再补充追加意见。\n\n候选选项：\n${optionBlock}`,
        ],
      ),
      lang,
    );
  }

  function queueReviewRoundPlanningConsolidation(input: {
    projectId: string | null;
    projectName: string | null;
    projectPath: string | null;
    taskId: string;
    taskTitle: string;
    meetingId: string;
    reviewRound: number;
    optionNotes: string[];
    snapshotHash: string;
    lang: string;
  }): void {
    const inFlightKey = `${input.meetingId}:${input.snapshotHash}`;
    if (reviewRoundDecisionConsolidationInFlight.has(inFlightKey)) return;
    reviewRoundDecisionConsolidationInFlight.add(inFlightKey);

    void (async () => {
      try {
        const currentState = getReviewRoundDecisionState(input.meetingId);
        if (!currentState || currentState.snapshot_hash !== input.snapshotHash) return;
        if (currentState.status !== "collecting") return;

        const planningLeader = findTeamLeader("planning");
        const clip = (text: string, max = 240) => {
          const normalized = String(text ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (!normalized) return "-";
          return normalized.length > max ? `${normalized.slice(0, max - 3).trimEnd()}...` : normalized;
        };
        const fallbackSummary = buildReviewRoundPlanningFallbackSummary(
          input.lang,
          input.taskTitle,
          input.reviewRound,
          input.optionNotes,
          input.projectName,
        );

        let plannerSummary = fallbackSummary;
        if (planningLeader) {
          const sourceBlock =
            input.optionNotes.length > 0
              ? input.optionNotes.map((note, idx) => `${idx + 1}) ${clip(note, 320)}`).join("\n")
              : pickL(
                  l(["- 라운드 의견 없음"], ["- No round opinions"], ["- ラウンド意見なし"], ["- 无轮次意见"]),
                  input.lang,
                );
          const prompt = [
            `You are the planning lead (${planningLeader.name}).`,
            `Task: '${input.taskTitle}'`,
            `Review round: ${input.reviewRound}`,
            input.projectName ? `Project: '${input.projectName}'` : "Project: (none)",
            `Language: ${input.lang}`,
            "Goal:",
            "- Read all round options and summarize each team's stance.",
            "- Recommend which option numbers the CEO should pick (multiple allowed), or explicitly recommend SKIP.",
            "- Keep it concise and decision-oriented.",
            "",
            "Round option sources:",
            sourceBlock,
          ].join("\n");
          try {
            const run = await runAgentOneShot(planningLeader, prompt, {
              projectPath: input.projectPath || process.cwd(),
              timeoutMs: 45_000,
              noTools: true,
            });
            const preferred = String(chooseSafeReply(run, input.lang, "summary", planningLeader) || "").trim();
            const raw = String(run?.text || "").trim();
            const merged = preferred || raw;
            if (merged) {
              const clipped = merged.length > 1800 ? `${merged.slice(0, 1797).trimEnd()}...` : merged;
              plannerSummary = formatPlannerSummaryForDisplay(clipped);
            }
          } catch {
            plannerSummary = fallbackSummary;
          }
        }
        plannerSummary = formatPlannerSummaryForDisplay(plannerSummary);

        const updateResult = db
          .prepare(
            `
          UPDATE review_round_decision_states
          SET status = 'ready',
              planner_summary = ?,
              planner_agent_id = ?,
              planner_agent_name = ?,
              updated_at = ?
          WHERE meeting_id = ?
            AND snapshot_hash = ?
            AND status = 'collecting'
        `,
          )
          .run(
            plannerSummary,
            planningLeader?.id ?? null,
            planningLeader ? getAgentDisplayName(planningLeader, input.lang) : null,
            nowMs(),
            input.meetingId,
            input.snapshotHash,
          ) as { changes?: number } | undefined;

        if ((updateResult?.changes ?? 0) > 0 && input.projectId) {
          recordProjectReviewDecisionEvent({
            project_id: input.projectId,
            snapshot_hash: getProjectReviewDecisionState(input.projectId)?.snapshot_hash ?? null,
            event_type: "planning_summary",
            summary: pickL(
              l(
                [`라운드 ${input.reviewRound} 기획팀장 취합\n${plannerSummary}`],
                [`Round ${input.reviewRound} planning consolidation\n${plannerSummary}`],
                [`ラウンド${input.reviewRound} 企画リード集約\n${plannerSummary}`],
                [`第 ${input.reviewRound} 轮规划负责人汇总\n${plannerSummary}`],
              ),
              input.lang,
            ),
            task_id: input.taskId,
            meeting_id: input.meetingId,
          });
        }
      } catch {
        const failMsg = pickL(
          l(
            ["리뷰 라운드 기획팀장 취합이 일시 지연되었습니다. 자동 재시도 중입니다."],
            ["Review-round planning consolidation is temporarily delayed. Auto retry in progress."],
            ["レビューラウンド企画リード集約が一時遅延しました。自動再試行中です。"],
            ["评审轮次规划汇总暂时延迟，正在自动重试。"],
          ),
          input.lang,
        );
        const ts = nowMs();
        db.prepare(
          `
          UPDATE review_round_decision_states
          SET status = 'failed',
              planner_summary = ?,
              updated_at = ?
          WHERE meeting_id = ?
            AND snapshot_hash = ?
        `,
        ).run(failMsg, ts, input.meetingId, input.snapshotHash);
      } finally {
        reviewRoundDecisionConsolidationInFlight.delete(inFlightKey);
      }
    })();
  }

  return {
    queueReviewRoundPlanningConsolidation,
  };
}
