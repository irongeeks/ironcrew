import type { Lang } from "../../../../types/lang.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { processReviewConsensusOutcome } from "./review-consensus-outcome.ts";
import { toErrorMessage } from "../../../routes/validation.ts";

export type ReviewConsensusDeps = Pick<
  RuntimeContext,
  | "db"
  | "reviewInFlight"
  | "reviewRoundState"
  | "getTaskReviewLeaders"
  | "getTaskStatusById"
  | "getReviewRoundMode"
  | "scheduleNextReviewRound"
  | "resolveProjectPath"
  | "resolveLang"
  | "runAgentOneShot"
  | "chooseSafeReply"
  | "appendTaskLog"
  | "notifyCeo"
  | "pickL"
  | "l"
  | "sendAgentMessage"
  | "emitMeetingSpeech"
  | "getAgentDisplayName"
  | "getDeptName"
  | "getRoleLabel"
  | "appendMeetingMinuteEntry"
  | "beginMeetingMinutes"
  | "finishMeetingMinutes"
  | "callLeadersToCeoOffice"
  | "dismissLeadersFromCeoOffice"
  | "wantsReviewRevision"
  | "meetingReviewDecisionByAgent"
  | "findLatestTranscriptContentByAgent"
  | "isDeferrableReviewHold"
  | "summarizeForMeetingBubble"
  | "appendTaskProjectMemo"
  | "appendTaskReviewFinalMemo"
  | "collectRevisionMemoItems"
  | "reserveReviewRevisionMemoItems"
  | "loadRecentReviewRevisionMemoItems"
  | "clearTaskWorkflowState"
  | "isTaskWorkflowInterrupted"
  | "randomDelay"
  | "sleepMs"
  | "buildMeetingPrompt"
> & {
  reviewMeetingOneShotTimeoutMs: number;
  REVIEW_MAX_ROUNDS: number;
  REVIEW_MAX_MEMO_ITEMS_PER_ROUND: number;
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT: number;
  REVIEW_MAX_REMEDIATION_REQUESTS: number;
  REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND: number;
  REVIEW_MAX_REVISION_SIGNALS_PER_ROUND: number;
};

export function createReviewConsensusTools(deps: ReviewConsensusDeps) {
  const {
    db,
    reviewInFlight,
    reviewRoundState,
    getTaskReviewLeaders,
    getTaskStatusById,
    getReviewRoundMode,
    scheduleNextReviewRound,
    resolveProjectPath,
    resolveLang,
    runAgentOneShot,
    chooseSafeReply,
    appendTaskLog,
    notifyCeo,
    pickL,
    l,
    sendAgentMessage,
    emitMeetingSpeech,
    getAgentDisplayName,
    getDeptName,
    getRoleLabel,
    appendMeetingMinuteEntry,
    beginMeetingMinutes,
    finishMeetingMinutes,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    wantsReviewRevision,
    meetingReviewDecisionByAgent,
    findLatestTranscriptContentByAgent,
    isDeferrableReviewHold,
    summarizeForMeetingBubble,
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
    collectRevisionMemoItems,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    clearTaskWorkflowState,
    isTaskWorkflowInterrupted,
    randomDelay,
    sleepMs,
    buildMeetingPrompt,
    reviewMeetingOneShotTimeoutMs,
    REVIEW_MAX_ROUNDS,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    REVIEW_MAX_REMEDIATION_REQUESTS,
    REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
    REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
  } = deps;

  function startReviewConsensusMeeting(
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: () => void,
  ): void {
    if (reviewInFlight.has(taskId)) return;
    reviewInFlight.add(taskId);

    void (async () => {
      let meetingId: string | null = null;
      const leaders = getTaskReviewLeaders(taskId, departmentId);
      if (leaders.length === 0) {
        reviewInFlight.delete(taskId);
        onApproved();
        return;
      }
      try {
        const latestMeeting = db
          .prepare(
            `
        SELECT id, round, status
        FROM meeting_minutes
        WHERE task_id = ?
          AND meeting_type = 'review'
        ORDER BY started_at DESC, created_at DESC
        LIMIT 1
      `,
          )
          .get(taskId) as { id: string; round: number; status: string } | undefined;
        const resumeMeeting = latestMeeting?.status === "in_progress";
        const round = resumeMeeting ? (latestMeeting?.round ?? 1) : (latestMeeting?.round ?? 0) + 1;
        reviewRoundState.set(taskId, round);
        if (!resumeMeeting && round > REVIEW_MAX_ROUNDS) {
          const cappedLang = resolveLang(taskTitle);
          appendTaskLog(
            taskId,
            "system",
            `Review round ${round} exceeds max_rounds=${REVIEW_MAX_ROUNDS}; forcing final decision`,
          );
          notifyCeo(
            pickL(
              l(
                [
                  `[CEO OFFICE] '${taskTitle}' 리뷰 라운드가 최대치(${REVIEW_MAX_ROUNDS})를 초과해 추가 보완은 중단하고 최종 승인 판단으로 전환합니다.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' exceeded max review rounds (${REVIEW_MAX_ROUNDS}). Additional revision rounds are closed and we are moving to final approval decision.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' はレビュー上限(${REVIEW_MAX_ROUNDS}回)を超えたため、追加補完を停止して最終承認判断へ移行します。`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' 的评审轮次已超过上限（${REVIEW_MAX_ROUNDS}）。现停止追加整改并转入最终审批判断。`,
                ],
              ),
              cappedLang,
            ),
            taskId,
          );
          reviewRoundState.delete(taskId);
          reviewInFlight.delete(taskId);
          onApproved();
          return;
        }

        const roundMode = getReviewRoundMode(round);
        const isRound1Remediation = roundMode === "parallel_remediation";
        const isRound2Merge = roundMode === "merge_synthesis";
        const isFinalDecisionRound = roundMode === "final_decision";

        const planningLeader = leaders.find((l: any) => l.department_id === "planning") ?? leaders[0];
        const otherLeaders = leaders.filter((l: any) => l.id !== planningLeader.id);
        let needsRevision = false;
        let reviseOwner: any = null;
        const seatIndexByAgent = new Map(leaders.slice(0, 6).map((leader: any, idx: number) => [leader.id, idx]));

        const taskCtx = db
          .prepare("SELECT description, project_path, workflow_pack_key FROM tasks WHERE id = ?")
          .get(taskId) as
          | { description: string | null; project_path: string | null; workflow_pack_key: string | null }
          | undefined;
        const taskDescription = taskCtx?.description ?? null;
        const taskWorkflowPackKey = taskCtx?.workflow_pack_key ?? null;
        const projectPath =
          resolveProjectPath({
            title: taskTitle,
            description: taskDescription,
            project_path: taskCtx?.project_path ?? null,
          }) ?? process.cwd();
        const lang = resolveLang(taskDescription ?? taskTitle);
        const transcript: any[] = [];
        const oneShotTimeoutMs = Math.max(5_000, Number(reviewMeetingOneShotTimeoutMs ?? 65_000));
        const oneShotOptions = { projectPath, timeoutMs: oneShotTimeoutMs, noTools: true };
        const isTimeoutRun = (run: { text?: string; error?: string } | null | undefined): boolean => {
          const source = `${run?.error ?? ""}\n${run?.text ?? ""}`;
          return /timeout after|timed out|request timed out|aborted/i.test(source);
        };
        const compactPromptForRetry = (prompt: string): string => {
          const raw = String(prompt ?? "");
          const maxHead = 2600;
          const maxTail = 1400;
          const compacted =
            raw.length > maxHead + maxTail + 64
              ? `${raw.slice(0, maxHead)}\n\n[...timeout retry compacted...]\n\n${raw.slice(-maxTail)}`
              : raw;
          return `${compacted}\n\n[retry] Previous attempt timed out. Respond concisely in short actionable points.`;
        };
        const runMeetingOneShotWithRetry = async (
          agent: any,
          prompt: string,
          phase: "opening" | "feedback" | "summary" | "approval",
        ): Promise<any> => {
          const first = await runAgentOneShot(agent, prompt, oneShotOptions);
          if (!isTimeoutRun(first)) return first;
          appendTaskLog(
            taskId,
            "system",
            `Review meeting ${phase} timed out (${oneShotTimeoutMs}ms); retrying once with compact prompt`,
          );
          const retryPrompt = compactPromptForRetry(prompt);
          const second = await runAgentOneShot(agent, retryPrompt, oneShotOptions);
          if (isTimeoutRun(second)) {
            appendTaskLog(taskId, "system", `Review meeting ${phase} retry timed out (${oneShotTimeoutMs}ms)`);
          }
          return second;
        };
        meetingId = resumeMeeting
          ? (latestMeeting?.id ?? null)
          : beginMeetingMinutes(taskId, "review", round, taskTitle);
        let minuteSeq = 1;
        if (meetingId) {
          const seqRow = db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM meeting_minute_entries WHERE meeting_id = ?")
            .get(meetingId) as { max_seq: number } | undefined;
          minuteSeq = (seqRow?.max_seq ?? 0) + 1;
        }
        const abortIfInactive = (): boolean => {
          if (!isTaskWorkflowInterrupted(taskId)) return false;
          const status = getTaskStatusById(taskId);
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          if (status) {
            appendTaskLog(taskId, "system", `Review meeting aborted due to task state change (${status})`);
          }
          return true;
        };

        const pushTranscript = (leader: any, content: string) => {
          transcript.push({
            speaker_agent_id: leader.id,
            speaker: getAgentDisplayName(leader, lang),
            department: getDeptName(leader.department_id ?? "", taskWorkflowPackKey),
            role: getRoleLabel(leader.role, lang as Lang),
            content,
          });
        };
        const speak = (
          leader: any,
          messageType: string,
          receiverType: string,
          receiverId: string | null,
          content: string,
        ) => {
          if (isTaskWorkflowInterrupted(taskId)) return;
          sendAgentMessage(leader, content, messageType, receiverType, receiverId, taskId);
          const seatIndex = seatIndexByAgent.get(leader.id) ?? 0;
          emitMeetingSpeech(leader.id, seatIndex, "review", taskId, content, lang);
          pushTranscript(leader, content);
          if (meetingId) {
            appendMeetingMinuteEntry(meetingId, minuteSeq++, leader, lang, messageType, content, taskWorkflowPackKey);
          }
        };

        if (abortIfInactive()) return;
        callLeadersToCeoOffice(taskId, leaders, "review");
        const resumeNotice = isRound2Merge
          ? l(
              [`[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 재개. 라운드1 보완 결과 취합/머지 판단을 이어갑니다.`],
              [
                `[CEO OFFICE] '${taskTitle}' review round ${round} resumed. Continuing consolidation and merge-readiness judgment from round 1 remediation.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}を再開。ラウンド1補完結果の集約とマージ可否判断を続行します。`,
              ],
              [`[CEO OFFICE] 已恢复'${taskTitle}'第${round}轮 Review，继续汇总第1轮整改结果并判断合并准备度。`],
            )
          : isFinalDecisionRound
            ? l(
                [
                  `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 재개. 추가 보완 없이 최종 승인과 문서 확정을 진행합니다.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' review round ${round} resumed. Final approval and documentation will be completed without additional remediation.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}を再開。追加補完なしで最終承認と文書確定を進めます。`,
                ],
                [
                  `[CEO OFFICE] 已恢复'${taskTitle}'第${round}轮 Review，将在不新增整改的前提下完成最终审批与文档确认。`,
                ],
              )
            : l(
                [`[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 재개. 팀장 의견 수집 및 상호 승인 재진행합니다.`],
                [
                  `[CEO OFFICE] '${taskTitle}' review round ${round} resumed. Continuing team-lead feedback and mutual approvals.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}を再開しました。チームリーダー意見収集と相互承認を続行します。`,
                ],
                [`[CEO OFFICE] 已恢复'${taskTitle}'第${round}轮 Review，继续收集团队负责人意见与相互审批。`],
              );
        const startNotice = isRound2Merge
          ? l(
              [
                `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 시작. 라운드1 보완 작업 결과를 팀장회의에서 취합하고 머지 판단을 진행합니다.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' review round ${round} started. Team leads are consolidating round 1 remediation outputs and making merge-readiness decisions.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}開始。ラウンド1補完結果をチームリーダー会議で集約し、マージ可否を判断します。`,
              ],
              [`[CEO OFFICE] 已开始'${taskTitle}'第${round}轮 Review，团队负责人将汇总第1轮整改结果并进行合并判断。`],
            )
          : isFinalDecisionRound
            ? l(
                [
                  `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 시작. 추가 보완 없이 최종 승인 결과와 문서 패키지를 확정합니다.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' review round ${round} started. Final approval and documentation package will be finalized without additional remediation.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}開始。追加補完なしで最終承認結果と文書パッケージを確定します。`,
                ],
                [
                  `[CEO OFFICE] 已开始'${taskTitle}'第${round}轮 Review，在不新增整改的前提下确定最终审批结果与文档包。`,
                ],
              )
            : l(
                [`[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 시작. 팀장 의견 수집 및 상호 승인 진행합니다.`],
                [
                  `[CEO OFFICE] '${taskTitle}' review round ${round} started. Collecting team-lead feedback and mutual approvals.`,
                ],
                [
                  `[CEO OFFICE] '${taskTitle}' レビューラウンド${round}を開始しました。チームリーダー意見収集と相互承認を進めます。`,
                ],
                [`[CEO OFFICE] 已开始'${taskTitle}'第${round}轮 Review，正在收集团队负责人意见并进行相互审批。`],
              );
        notifyCeo(pickL(resumeMeeting ? resumeNotice : startNotice, lang), taskId);

        const openingPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "review",
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective: isRound2Merge
            ? "Kick off round 2 merge-synthesis discussion and ask each leader to verify consolidated remediation output."
            : isFinalDecisionRound
              ? "Kick off round 3 final decision discussion and confirm that no additional remediation round will be opened."
              : "Kick off round 1 review discussion and ask each leader for all required remediation items in one pass.",
          stanceHint: isRound2Merge
            ? "Focus on consolidation and merge readiness. Convert concerns into documented residual risks instead of new subtasks."
            : isFinalDecisionRound
              ? "Finalize approval decision and documentation package. Do not ask for new remediation subtasks."
              : "Capture every remediation requirement now so execution can proceed in parallel once.",
          lang,
        });
        const openingRun = await runMeetingOneShotWithRetry(planningLeader, openingPrompt, "opening");
        if (abortIfInactive()) return;
        const openingText = chooseSafeReply(openingRun, lang, "opening", planningLeader);
        speak(planningLeader, "chat", "all", null, openingText);
        await sleepMs(randomDelay(720, 1300));
        if (abortIfInactive()) return;

        for (const leader of otherLeaders) {
          if (abortIfInactive()) return;
          const feedbackPrompt = buildMeetingPrompt(leader, {
            meetingType: "review",
            round,
            taskTitle,
            taskDescription,
            workflowPackKey: taskWorkflowPackKey,
            transcript,
            turnObjective: isRound2Merge
              ? "Validate merged remediation output and state whether it is ready for final-round sign-off."
              : isFinalDecisionRound
                ? "Provide final approval opinion with documentation-ready rationale."
                : "Provide concise review feedback and list all revision requirements that must be addressed in round 1.",
            stanceHint: isRound2Merge
              ? "Do not ask for a new remediation round; if concerns remain, describe residual risks for final documentation."
              : isFinalDecisionRound
                ? "No additional remediation is allowed in this final round. Choose final approve or approve-with-residual-risk."
                : "If revision is needed, explicitly state what must be fixed before approval.",
            lang,
          });
          const feedbackRun = await runMeetingOneShotWithRetry(leader, feedbackPrompt, "feedback");
          if (abortIfInactive()) return;
          const feedbackText = chooseSafeReply(feedbackRun, lang, "feedback", leader);
          speak(leader, "chat", "agent", planningLeader.id, feedbackText);
          if (wantsReviewRevision(feedbackText)) {
            needsRevision = true;
            if (!reviseOwner) reviseOwner = leader;
          }
          await sleepMs(randomDelay(650, 1180));
          if (abortIfInactive()) return;
        }

        if (otherLeaders.length === 0) {
          if (abortIfInactive()) return;
          const soloPrompt = buildMeetingPrompt(planningLeader, {
            meetingType: "review",
            round,
            taskTitle,
            taskDescription,
            workflowPackKey: taskWorkflowPackKey,
            transcript,
            turnObjective: isRound2Merge
              ? "As the only reviewer, decide whether round 1 remediation is fully consolidated and merge-ready."
              : isFinalDecisionRound
                ? "As the only reviewer, publish the final approval conclusion and documentation note."
                : "As the only reviewer, provide your single-party review conclusion with complete remediation checklist.",
            stanceHint: isFinalDecisionRound
              ? "No further remediation round is allowed. Conclude with final decision and documented residual risks if any."
              : "Summarize risks, dependencies, and confidence level in one concise message.",
            lang,
          });
          const soloRun = await runMeetingOneShotWithRetry(planningLeader, soloPrompt, "feedback");
          if (abortIfInactive()) return;
          const soloText = chooseSafeReply(soloRun, lang, "feedback", planningLeader);
          speak(planningLeader, "chat", "all", null, soloText);
          await sleepMs(randomDelay(620, 980));
          if (abortIfInactive()) return;
        }

        const summaryPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "review",
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective: isRound2Merge
            ? "Synthesize round 2 consolidation, clarify merge readiness, and announce move to final decision round."
            : isFinalDecisionRound
              ? "Synthesize final review outcome and publish final documentation/approval direction."
              : needsRevision
                ? "Synthesize feedback and announce concrete remediation subtasks and execution handoff."
                : "Synthesize feedback and request final all-leader approval.",
          stanceHint: isRound2Merge
            ? "No new remediation subtasks in round 2. Convert concerns into documented residual-risk notes."
            : isFinalDecisionRound
              ? "Finalize now. Additional remediation rounds are not allowed."
              : needsRevision
                ? "State that remediation starts immediately and review will restart only after remediation is completed."
                : "State that the final review package is ready for immediate approval.",
          lang,
        });
        const summaryRun = await runMeetingOneShotWithRetry(planningLeader, summaryPrompt, "summary");
        if (abortIfInactive()) return;
        const summaryText = chooseSafeReply(summaryRun, lang, "summary", planningLeader);
        speak(planningLeader, "report", "all", null, summaryText);
        await sleepMs(randomDelay(680, 1120));
        if (abortIfInactive()) return;

        for (const leader of leaders) {
          if (abortIfInactive()) return;
          const isReviseOwner = reviseOwner?.id === leader.id;
          const approvalPrompt = buildMeetingPrompt(leader, {
            meetingType: "review",
            round,
            taskTitle,
            taskDescription,
            workflowPackKey: taskWorkflowPackKey,
            transcript,
            turnObjective: isRound2Merge
              ? "State whether this consolidated package is ready to proceed into final decision round."
              : isFinalDecisionRound
                ? "State your final approval decision and documentation conclusion for this task."
                : "State your final approval decision for this review round.",
            stanceHint: isRound2Merge
              ? "If concerns remain, record residual risk only. Do not request a new remediation subtask round."
              : isFinalDecisionRound
                ? "This is the final round. Additional remediation is not allowed; conclude with approve or approve-with-documented-risk."
                : !needsRevision
                  ? "Approve the current review package if ready; otherwise hold approval with concrete revision items."
                  : isReviseOwner
                    ? "Hold approval until your requested revision is reflected."
                    : "Agree with conditional approval pending revision reflection.",
            lang,
          });
          const approvalRun = await runMeetingOneShotWithRetry(leader, approvalPrompt, "approval");
          if (abortIfInactive()) return;
          const approvalText = chooseSafeReply(approvalRun, lang, "approval", leader);
          speak(leader, "status_update", "all", null, approvalText);
          if (wantsReviewRevision(approvalText)) {
            needsRevision = true;
            if (!reviseOwner) reviseOwner = leader;
          }
          await sleepMs(randomDelay(420, 860));
          if (abortIfInactive()) return;
        }

        const shouldReturn = await processReviewConsensusOutcome({
          taskId,
          taskTitle,
          round,
          roundMode,
          isRound1Remediation,
          isRound2Merge,
          isFinalDecisionRound,
          leaders,
          transcript,
          lang,
          workflowPackKey: taskWorkflowPackKey,
          meetingId,
          onApproved,
          abortIfInactive,
          meetingReviewDecisionByAgent,
          findLatestTranscriptContentByAgent,
          isDeferrableReviewHold,
          summarizeForMeetingBubble,
          getDeptName,
          getAgentDisplayName,
          appendTaskLog,
          REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
          REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
          appendTaskProjectMemo,
          sleepMs,
          randomDelay,
          collectRevisionMemoItems,
          REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
          REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
          reserveReviewRevisionMemoItems,
          loadRecentReviewRevisionMemoItems,
          pickL,
          l,
          db,
          REVIEW_MAX_REMEDIATION_REQUESTS,
          notifyCeo,
          finishMeetingMinutes,
          dismissLeadersFromCeoOffice,
          reviewRoundState,
          reviewInFlight,
          appendTaskReviewFinalMemo,
          scheduleNextReviewRound,
        });
        if (shouldReturn) return;
      } catch (err: unknown) {
        if (isTaskWorkflowInterrupted(taskId)) {
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          return;
        }
        const msg = toErrorMessage(err);
        appendTaskLog(taskId, "error", `Review consensus meeting error: ${msg}`);
        const errLang = resolveLang(taskTitle);
        notifyCeo(
          pickL(
            l(
              [`[CEO OFFICE] '${taskTitle}' 리뷰 라운드 처리 중 오류가 발생했습니다: ${msg}`],
              [`[CEO OFFICE] Error while processing review round for '${taskTitle}': ${msg}`],
              [`[CEO OFFICE] '${taskTitle}' のレビューラウンド処理中にエラーが発生しました: ${msg}`],
              [`[CEO OFFICE] 处理'${taskTitle}'评审轮次时发生错误：${msg}`],
            ),
            errLang,
          ),
          taskId,
        );
        if (meetingId) finishMeetingMinutes(meetingId, "failed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        reviewInFlight.delete(taskId);
      }
    })();
  }

  return {
    startReviewConsensusMeeting,
  };
}
