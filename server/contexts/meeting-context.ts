import type { MeetingContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for MeetingContext — pass-through from runtimeContext.
 *
 * Functions originate from meetings/minutes.ts, meetings/presence.ts,
 * meetings/leader-selection.ts, meetings/review-consensus.ts,
 * planned-approval.ts, and meeting-prompt-tools.ts. All are closures
 * over runtimeContext in barrel modules.
 */
export interface MeetingDeps {
  appendMeetingMinuteEntry: MeetingContext["appendMeetingMinuteEntry"];
  appendTaskProjectMemo: MeetingContext["appendTaskProjectMemo"];
  appendTaskReviewFinalMemo: MeetingContext["appendTaskReviewFinalMemo"];
  beginMeetingMinutes: MeetingContext["beginMeetingMinutes"];
  buildMeetingPrompt: MeetingContext["buildMeetingPrompt"];
  callLeadersToCeoOffice: MeetingContext["callLeadersToCeoOffice"];
  collectPlannedActionItems: MeetingContext["collectPlannedActionItems"];
  collectRevisionMemoItems: MeetingContext["collectRevisionMemoItems"];
  dismissLeadersFromCeoOffice: MeetingContext["dismissLeadersFromCeoOffice"];
  emitMeetingSpeech: MeetingContext["emitMeetingSpeech"];
  finishMeetingMinutes: MeetingContext["finishMeetingMinutes"];
  formatMeetingTranscript: MeetingContext["formatMeetingTranscript"];
  getAllActiveTeamLeaders: MeetingContext["getAllActiveTeamLeaders"];
  getLeadersByDepartmentIds: MeetingContext["getLeadersByDepartmentIds"];
  getTaskRelatedDepartmentIds: MeetingContext["getTaskRelatedDepartmentIds"];
  getTaskReviewLeaders: MeetingContext["getTaskReviewLeaders"];
  isAgentInMeeting: MeetingContext["isAgentInMeeting"];
  loadRecentReviewRevisionMemoItems: MeetingContext["loadRecentReviewRevisionMemoItems"];
  markAgentInMeeting: MeetingContext["markAgentInMeeting"];
  normalizeRevisionMemoNote: MeetingContext["normalizeRevisionMemoNote"];
  reserveReviewRevisionMemoItems: MeetingContext["reserveReviewRevisionMemoItems"];
  startPlannedApprovalMeeting: MeetingContext["startPlannedApprovalMeeting"];
  startReviewConsensusMeeting: MeetingContext["startReviewConsensusMeeting"];
  summarizeForMeetingBubble: MeetingContext["summarizeForMeetingBubble"];
}

/**
 * Creates a MeetingContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules to accept narrow deps so their functions can be composed here.
 */
export function createMeetingContext(deps: MeetingDeps): MeetingContext {
  return {
    appendMeetingMinuteEntry: deps.appendMeetingMinuteEntry,
    appendTaskProjectMemo: deps.appendTaskProjectMemo,
    appendTaskReviewFinalMemo: deps.appendTaskReviewFinalMemo,
    beginMeetingMinutes: deps.beginMeetingMinutes,
    buildMeetingPrompt: deps.buildMeetingPrompt,
    callLeadersToCeoOffice: deps.callLeadersToCeoOffice,
    collectPlannedActionItems: deps.collectPlannedActionItems,
    collectRevisionMemoItems: deps.collectRevisionMemoItems,
    dismissLeadersFromCeoOffice: deps.dismissLeadersFromCeoOffice,
    emitMeetingSpeech: deps.emitMeetingSpeech,
    finishMeetingMinutes: deps.finishMeetingMinutes,
    formatMeetingTranscript: deps.formatMeetingTranscript,
    getAllActiveTeamLeaders: deps.getAllActiveTeamLeaders,
    getLeadersByDepartmentIds: deps.getLeadersByDepartmentIds,
    getTaskRelatedDepartmentIds: deps.getTaskRelatedDepartmentIds,
    getTaskReviewLeaders: deps.getTaskReviewLeaders,
    isAgentInMeeting: deps.isAgentInMeeting,
    loadRecentReviewRevisionMemoItems: deps.loadRecentReviewRevisionMemoItems,
    markAgentInMeeting: deps.markAgentInMeeting,
    normalizeRevisionMemoNote: deps.normalizeRevisionMemoNote,
    reserveReviewRevisionMemoItems: deps.reserveReviewRevisionMemoItems,
    startPlannedApprovalMeeting: deps.startPlannedApprovalMeeting,
    startReviewConsensusMeeting: deps.startReviewConsensusMeeting,
    summarizeForMeetingBubble: deps.summarizeForMeetingBubble,
  };
}
