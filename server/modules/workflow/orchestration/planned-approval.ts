import type { DbLike } from "../../../types/db-like.ts";
import { toErrorMessage } from "../../routes/validation.ts";

type CreatePlannedApprovalToolsDeps = {
  reviewInFlight: Set<string>;
  reviewRoundState: Map<string, number>;
  db: DbLike;
  getTaskReviewLeaders: (...args: any[]) => any[];
  resolveProjectPath: (...args: any[]) => any;
  resolveLang: (...args: any[]) => any;
  beginMeetingMinutes: (...args: any[]) => any;
  isTaskWorkflowInterrupted: (...args: any[]) => any;
  getTaskStatusById: (...args: any[]) => any;
  finishMeetingMinutes: (...args: any[]) => any;
  dismissLeadersFromCeoOffice: (...args: any[]) => any;
  clearTaskWorkflowState: (...args: any[]) => any;
  getAgentDisplayName: (...args: any[]) => any;
  getDeptName: (...args: any[]) => any;
  getRoleLabel: (...args: any[]) => any;
  sendAgentMessage: (...args: any[]) => any;
  emitMeetingSpeech: (...args: any[]) => any;
  appendMeetingMinuteEntry: (...args: any[]) => any;
  callLeadersToCeoOffice: (...args: any[]) => any;
  notifyCeo: (...args: any[]) => any;
  pickL: (...args: any[]) => any;
  l: (...args: any[]) => any;
  buildMeetingPrompt: (...args: any[]) => any;
  runAgentOneShot: (...args: any[]) => Promise<any>;
  chooseSafeReply: (...args: any[]) => any;
  sleepMs: (...args: any[]) => Promise<void>;
  randomDelay: (...args: any[]) => any;
  collectPlannedActionItems: (...args: any[]) => any[];
  appendTaskProjectMemo: (...args: any[]) => any;
  appendTaskLog: (...args: any[]) => any;
  reviewMeetingOneShotTimeoutMs?: number;
};

export function createPlannedApprovalTools(deps: CreatePlannedApprovalToolsDeps) {
  const {
    reviewInFlight,
    reviewRoundState,
    db,
    getTaskReviewLeaders,
    resolveProjectPath,
    resolveLang,
    beginMeetingMinutes,
    isTaskWorkflowInterrupted,
    getTaskStatusById,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    clearTaskWorkflowState,
    getAgentDisplayName,
    getDeptName,
    getRoleLabel,
    sendAgentMessage,
    emitMeetingSpeech,
    appendMeetingMinuteEntry,
    callLeadersToCeoOffice,
    notifyCeo,
    pickL,
    l,
    buildMeetingPrompt,
    runAgentOneShot,
    chooseSafeReply,
    sleepMs,
    randomDelay,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskLog,
    reviewMeetingOneShotTimeoutMs,
  } = deps;

  function startPlannedApprovalMeeting(
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: (planningNotes?: string[]) => void,
  ): void {
    const lockKey = `planned:${taskId}`;
    if (reviewInFlight.has(lockKey)) {
      return;
    }
    reviewInFlight.add(lockKey);

    void (async () => {
      let meetingId: string | null = null;
      const leaders = getTaskReviewLeaders(taskId, departmentId);
      if (leaders.length === 0) {
        reviewInFlight.delete(lockKey);
        onApproved([]);
        return;
      }
      try {
        const round = (reviewRoundState.get(lockKey) ?? 0) + 1;
        reviewRoundState.set(lockKey, round);

        const planningLeader = leaders.find((l: any) => l.department_id === "planning") ?? leaders[0];
        const otherLeaders = leaders.filter((l: any) => l.id !== planningLeader.id);
        let hasSupplementSignals = false;
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
        const wantsRevision = (content: string): boolean =>
          /보완|수정|보류|리스크|추가.?필요|hold|revise|revision|required|pending|risk|block|保留|修正|补充|暂缓/i.test(
            content,
          );
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
            `Planned meeting ${phase} timed out (${oneShotTimeoutMs}ms); retrying once with compact prompt`,
          );
          const retryPrompt = compactPromptForRetry(prompt);
          const second = await runAgentOneShot(agent, retryPrompt, oneShotOptions);
          if (isTimeoutRun(second)) {
            appendTaskLog(taskId, "system", `Planned meeting ${phase} retry timed out (${oneShotTimeoutMs}ms)`);
          }
          return second;
        };
        meetingId = beginMeetingMinutes(taskId, "planned", round, taskTitle);
        let minuteSeq = 1;
        const abortIfInactive = (): boolean => {
          if (!isTaskWorkflowInterrupted(taskId)) return false;
          const status = getTaskStatusById(taskId);
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          if (status) {
            appendTaskLog(taskId, "system", `Planned meeting aborted due to task state change (${status})`);
          }
          return true;
        };

        const pushTranscript = (leader: any, content: string) => {
          transcript.push({
            speaker_agent_id: leader.id,
            speaker: getAgentDisplayName(leader, lang),
            department: getDeptName(leader.department_id ?? "", taskWorkflowPackKey),
            role: getRoleLabel(leader.role, lang),
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
          emitMeetingSpeech(leader.id, seatIndex, "kickoff", taskId, content, lang);
          pushTranscript(leader, content);
          if (meetingId) {
            appendMeetingMinuteEntry(meetingId, minuteSeq++, leader, lang, messageType, content, taskWorkflowPackKey);
          }
        };

        if (abortIfInactive()) return;
        callLeadersToCeoOffice(taskId, leaders, "kickoff");
        notifyCeo(
          pickL(
            l(
              [
                `[CEO OFFICE] '${taskTitle}' Planned 계획 라운드 ${round} 시작. 부서별 보완점 수집 후 실행계획(SubTask)으로 정리합니다.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' planned round ${round} started. Collecting supplement points and turning them into executable subtasks.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' のPlanned計画ラウンド${round}を開始。補完項目を収集し、実行SubTaskへ落とし込みます。`,
              ],
              [`[CEO OFFICE] 已开始'${taskTitle}'第${round}轮 Planned 规划，正在收集补充点并转为可执行 SubTask。`],
            ),
            lang,
          ),
          taskId,
        );

        const openingPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "planned",
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective:
            "Open the planned kickoff meeting and ask each leader for concrete supplement points and planning actions.",
          stanceHint: "At Planned stage, do not block kickoff; convert concerns into executable planning items.",
          lang,
        });
        const openingRun = await runMeetingOneShotWithRetry(planningLeader, openingPrompt, "opening");
        if (abortIfInactive()) return;
        const openingText = chooseSafeReply(openingRun, lang, "opening", planningLeader);
        speak(planningLeader, "chat", "all", null, openingText);
        await sleepMs(randomDelay(700, 1260));
        if (abortIfInactive()) return;

        for (const leader of otherLeaders) {
          if (abortIfInactive()) return;
          const feedbackPrompt = buildMeetingPrompt(leader, {
            meetingType: "planned",
            round,
            taskTitle,
            taskDescription,
            workflowPackKey: taskWorkflowPackKey,
            transcript,
            turnObjective: "Share concise readiness feedback plus concrete supplement items to be planned as subtasks.",
            stanceHint: "Do not hold approval here; provide actionable plan additions with evidence/check item.",
            lang,
          });
          const feedbackRun = await runMeetingOneShotWithRetry(leader, feedbackPrompt, "feedback");
          if (abortIfInactive()) return;
          const feedbackText = chooseSafeReply(feedbackRun, lang, "feedback", leader);
          speak(leader, "chat", "agent", planningLeader.id, feedbackText);
          if (wantsRevision(feedbackText)) {
            hasSupplementSignals = true;
          }
          await sleepMs(randomDelay(620, 1080));
          if (abortIfInactive()) return;
        }

        const summaryPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "planned",
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective:
            "Summarize supplement points and announce that they will be converted to subtasks before execution.",
          stanceHint: "Keep kickoff moving and show concrete planned next steps instead of blocking.",
          lang,
        });
        const summaryRun = await runMeetingOneShotWithRetry(planningLeader, summaryPrompt, "summary");
        if (abortIfInactive()) return;
        const summaryText = chooseSafeReply(summaryRun, lang, "summary", planningLeader);
        speak(planningLeader, "report", "all", null, summaryText);
        await sleepMs(randomDelay(640, 1120));
        if (abortIfInactive()) return;

        for (const leader of leaders) {
          if (abortIfInactive()) return;
          const actionPrompt = buildMeetingPrompt(leader, {
            meetingType: "planned",
            round,
            taskTitle,
            taskDescription,
            workflowPackKey: taskWorkflowPackKey,
            transcript,
            turnObjective: "Propose one immediate planning action item for your team in subtask style.",
            stanceHint:
              "State what to do next, what evidence to collect, and who owns it. Do not block kickoff at this stage.",
            lang,
          });
          const actionRun = await runMeetingOneShotWithRetry(leader, actionPrompt, "approval");
          if (abortIfInactive()) return;
          const actionText = chooseSafeReply(actionRun, lang, "approval", leader);
          speak(leader, "status_update", "all", null, actionText);
          if (wantsRevision(actionText)) {
            hasSupplementSignals = true;
          }
          await sleepMs(randomDelay(420, 840));
          if (abortIfInactive()) return;
        }

        await sleepMs(randomDelay(520, 900));
        if (abortIfInactive()) return;
        const planItems = collectPlannedActionItems(transcript, 10);
        appendTaskProjectMemo(taskId, "planned", round, planItems, lang);
        appendTaskLog(
          taskId,
          "system",
          `Planned meeting round ${round}: action items collected (${planItems.length}, supplement-signals=${hasSupplementSignals ? "yes" : "no"})`,
        );
        notifyCeo(
          pickL(
            l(
              [
                `[CEO OFFICE] '${taskTitle}' Planned 회의 종료. 보완점 ${planItems.length}건을 계획 항목으로 기록하고 In Progress로 진행합니다.`,
              ],
              [
                `[CEO OFFICE] Planned meeting for '${taskTitle}' is complete. Recorded ${planItems.length} improvement items and moving to In Progress.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' のPlanned会議が完了。補完項目${planItems.length}件を計画化し、In Progressへ進みます。`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' 的 Planned 会议已结束，已记录 ${planItems.length} 个改进项并转入 In Progress。`,
              ],
            ),
            lang,
          ),
          taskId,
        );
        if (meetingId) finishMeetingMinutes(meetingId, "completed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        reviewRoundState.delete(lockKey);
        reviewInFlight.delete(lockKey);
        onApproved(planItems);
      } catch (err: unknown) {
        if (isTaskWorkflowInterrupted(taskId)) {
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          return;
        }
        const msg = toErrorMessage(err);
        appendTaskLog(taskId, "error", `Planned meeting error: ${msg}`);
        const errLang = resolveLang(taskTitle);
        notifyCeo(
          pickL(
            l(
              [`[CEO OFFICE] '${taskTitle}' Planned 회의 처리 중 오류가 발생했습니다: ${msg}`],
              [`[CEO OFFICE] Error while processing planned meeting for '${taskTitle}': ${msg}`],
              [`[CEO OFFICE] '${taskTitle}' のPlanned会議処理中にエラーが発生しました: ${msg}`],
              [`[CEO OFFICE] 处理'${taskTitle}'的 Planned 会议时发生错误：${msg}`],
            ),
            errLang,
          ),
          taskId,
        );
        if (meetingId) finishMeetingMinutes(meetingId, "failed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        reviewInFlight.delete(lockKey);
      }
    })();
  }

  return {
    startPlannedApprovalMeeting,
  };
}
