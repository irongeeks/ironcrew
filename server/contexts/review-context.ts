import type { ReviewContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for ReviewContext — pass-through from runtimeContext.
 *
 * Functions originate from session-review-tools.ts,
 * review-finalize-tools.ts, and reply-core-tools.ts. All are closures
 * over runtimeContext in barrel modules.
 */
export interface ReviewDeps {
  // Caches / state
  progressTimers: ReviewContext["progressTimers"];
  reviewInFlight: ReviewContext["reviewInFlight"];
  reviewRoundState: ReviewContext["reviewRoundState"];

  // Functions
  classifyMeetingReviewDecision: ReviewContext["classifyMeetingReviewDecision"];
  findLatestTranscriptContentByAgent: ReviewContext["findLatestTranscriptContentByAgent"];
  finishReview: ReviewContext["finishReview"];
  getReviewRoundMode: ReviewContext["getReviewRoundMode"];
  getTaskStatusById: ReviewContext["getTaskStatusById"];
  hasApprovalAgreementSignal: ReviewContext["hasApprovalAgreementSignal"];
  hasVisibleDiffSummary: ReviewContext["hasVisibleDiffSummary"];
  isDeferrableReviewHold: ReviewContext["isDeferrableReviewHold"];
  isHardBlockSignal: ReviewContext["isHardBlockSignal"];
  isInternalWorkNarration: ReviewContext["isInternalWorkNarration"];
  isMvpDeferralSignal: ReviewContext["isMvpDeferralSignal"];
  scheduleNextReviewRound: ReviewContext["scheduleNextReviewRound"];
  startProgressTimer: ReviewContext["startProgressTimer"];
  stopProgressTimer: ReviewContext["stopProgressTimer"];
  wantsReviewRevision: ReviewContext["wantsReviewRevision"];
}

/**
 * Creates a ReviewContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules to accept narrow deps so their functions can be composed here.
 */
export function createReviewContext(deps: ReviewDeps): ReviewContext {
  return {
    progressTimers: deps.progressTimers,
    reviewInFlight: deps.reviewInFlight,
    reviewRoundState: deps.reviewRoundState,

    classifyMeetingReviewDecision: deps.classifyMeetingReviewDecision,
    findLatestTranscriptContentByAgent: deps.findLatestTranscriptContentByAgent,
    finishReview: deps.finishReview,
    getReviewRoundMode: deps.getReviewRoundMode,
    getTaskStatusById: deps.getTaskStatusById,
    hasApprovalAgreementSignal: deps.hasApprovalAgreementSignal,
    hasVisibleDiffSummary: deps.hasVisibleDiffSummary,
    isDeferrableReviewHold: deps.isDeferrableReviewHold,
    isHardBlockSignal: deps.isHardBlockSignal,
    isInternalWorkNarration: deps.isInternalWorkNarration,
    isMvpDeferralSignal: deps.isMvpDeferralSignal,
    scheduleNextReviewRound: deps.scheduleNextReviewRound,
    startProgressTimer: deps.startProgressTimer,
    stopProgressTimer: deps.stopProgressTimer,
    wantsReviewRevision: deps.wantsReviewRevision,
  };
}
