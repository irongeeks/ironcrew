import type { RuntimeContext } from "../../../types/runtime-context.ts";
import {
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
  REVIEW_MAX_REMEDIATION_REQUESTS,
  REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
  REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
  REVIEW_MAX_ROUNDS,
} from "../../../db/runtime.ts";
import { createMeetingLeaderSelectionTools } from "./meetings/leader-selection.ts";
import { createMeetingMinutesTools } from "./meetings/minutes.ts";
import { createMeetingPresenceTools } from "./meetings/presence.ts";
import { createReviewConsensusTools } from "./meetings/review-consensus.ts";

export function initializeWorkflowMeetingTools(ctx: RuntimeContext): any {
  const __ctx: RuntimeContext = ctx;
  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const broadcast = __ctx.broadcast;
  const appendTaskLog = __ctx.appendTaskLog;
  const detectTargetDepartments =
    typeof __ctx.detectTargetDepartments === "function" ? __ctx.detectTargetDepartments : (_text: string) => [];
  const findTeamLeader = __ctx.findTeamLeader;
  const getAgentDisplayName = __ctx.getAgentDisplayName;
  const getDeptName = __ctx.getDeptName;
  const getRoleLabel = __ctx.getRoleLabel;
  const l = __ctx.l;
  const pickL = __ctx.pickL;
  const summarizeForMeetingBubble = __ctx.summarizeForMeetingBubble;
  const classifyMeetingReviewDecision = __ctx.classifyMeetingReviewDecision;
  const meetingPresenceUntil = __ctx.meetingPresenceUntil;
  const meetingSeatIndexByAgent = __ctx.meetingSeatIndexByAgent;
  const meetingPhaseByAgent = __ctx.meetingPhaseByAgent;
  const meetingTaskIdByAgent = __ctx.meetingTaskIdByAgent;
  const meetingReviewDecisionByAgent = __ctx.meetingReviewDecisionByAgent;
  const reviewRoundState = __ctx.reviewRoundState;
  const reviewInFlight = __ctx.reviewInFlight;
  const getTaskStatusById = __ctx.getTaskStatusById;
  const getReviewRoundMode = __ctx.getReviewRoundMode;
  const scheduleNextReviewRound = __ctx.scheduleNextReviewRound;
  const notifyCeo = __ctx.notifyCeo;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const resolveProjectPath = __ctx.resolveProjectPath;
  const resolveLang = __ctx.resolveLang;
  const chooseSafeReply = __ctx.chooseSafeReply;
  const sendAgentMessage = __ctx.sendAgentMessage;
  const randomDelay = __ctx.randomDelay;
  const sleepMs = __ctx.sleepMs;
  const wantsReviewRevision = __ctx.wantsReviewRevision;
  const findLatestTranscriptContentByAgent = __ctx.findLatestTranscriptContentByAgent;
  const isDeferrableReviewHold = __ctx.isDeferrableReviewHold;
  const clearTaskWorkflowState = __ctx.clearTaskWorkflowState;
  const isTaskWorkflowInterrupted = __ctx.isTaskWorkflowInterrupted;
  const buildMeetingPrompt = __ctx.buildMeetingPrompt;
  const reviewMeetingOneShotTimeoutMs = Number((__ctx as any).reviewMeetingOneShotTimeoutMs ?? 65_000);

  const { getLeadersByDepartmentIds, getAllActiveTeamLeaders, getTaskRelatedDepartmentIds, getTaskReviewLeaders } =
    createMeetingLeaderSelectionTools({
      db,
      findTeamLeader,
      detectTargetDepartments,
    });

  const {
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
  } = createMeetingMinutesTools({
    db,
    nowMs,
    getDeptName,
    getRoleLabel,
    getAgentDisplayName: getAgentDisplayName as any,
    pickL: pickL as any,
    l: l as any,
    summarizeForMeetingBubble,
    appendTaskLog,
    broadcast,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  });

  const {
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
  } = createMeetingPresenceTools({
    db,
    nowMs,
    broadcast,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
    summarizeForMeetingBubble,
    classifyMeetingReviewDecision,
  });

  const { startReviewConsensusMeeting } = createReviewConsensusTools({
    db,
    reviewInFlight,
    reviewRoundState,
    getTaskReviewLeaders: getTaskReviewLeaders as any,
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
    appendTaskProjectMemo: appendTaskProjectMemo as any,
    appendTaskReviewFinalMemo: appendTaskReviewFinalMemo as any,
    collectRevisionMemoItems: collectRevisionMemoItems as any,
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
  });

  return {
    getLeadersByDepartmentIds,
    getAllActiveTeamLeaders,
    getTaskRelatedDepartmentIds,
    getTaskReviewLeaders,
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
    startReviewConsensusMeeting,
  };
}
