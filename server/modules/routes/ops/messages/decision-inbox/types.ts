import type { DatabaseSync } from "node:sqlite";
import type { Request, Response } from "express";
import type { AgentRow } from "../../../shared/types.ts";

export type DecisionOption = {
  number: number;
  action: string;
  label: string;
};

export interface DecisionInboxRouteItem {
  id: string;
  kind: "project_review_ready" | "task_timeout_resume" | "review_round_pick";
  created_at: number;
  summary: string;
  agent_id?: string | null;
  agent_name?: string | null;
  agent_name_ko?: string | null;
  agent_avatar?: string | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  task_id: string | null;
  task_title: string | null;
  meeting_id?: string | null;
  review_round?: number | null;
  options: DecisionOption[];
}

export type ProjectReviewDecisionItem = DecisionInboxRouteItem & {
  kind: "project_review_ready";
};

export type TimeoutResumeDecisionItem = DecisionInboxRouteItem & {
  kind: "task_timeout_resume";
};

export type ReviewRoundDecisionItem = DecisionInboxRouteItem & {
  kind: "review_round_pick";
  meeting_id: string;
  review_round: number;
};

export type DecisionStateStatus = "collecting" | "ready" | "failed";

export interface PlanningLeadStateLike {
  planner_agent_id?: string | null;
  planner_agent_name?: string | null;
}

export interface PlanningLeadMeta {
  agent_id: string | null;
  agent_name: string;
  agent_name_ko: string;
  agent_avatar: string;
}

export interface ProjectReviewDecisionState extends PlanningLeadStateLike {
  project_id: string;
  snapshot_hash: string;
  status: DecisionStateStatus;
  planner_summary: string | null;
  planner_agent_id: string | null;
  planner_agent_name: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface ReviewRoundDecisionState extends PlanningLeadStateLike {
  meeting_id: string;
  snapshot_hash: string;
  status: DecisionStateStatus;
  planner_summary: string | null;
  planner_agent_id: string | null;
  planner_agent_name: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface ProjectReviewDecisionEventInput {
  project_id: string;
  snapshot_hash?: string | null;
  event_type:
    | "planning_summary"
    | "representative_pick"
    | "followup_request"
    | "start_review_meeting"
    | "start_review_meeting_blocked";
  summary: string;
  selected_options_json?: string | null;
  note?: string | null;
  task_id?: string | null;
  meeting_id?: string | null;
}

export interface DecisionStateHelperDeps {
  db: DatabaseSync;
  nowMs: () => number;
}

export interface DecisionStateHelpers {
  buildProjectReviewSnapshotHash(
    projectId: string,
    reviewTaskChoices: Array<{ id: string; updated_at: number }>,
  ): string;
  getProjectReviewDecisionState(projectId: string): ProjectReviewDecisionState | null;
  upsertProjectReviewDecisionState(
    projectId: string,
    snapshotHash: string,
    status: DecisionStateStatus,
    plannerSummary: string | null,
    plannerAgentId: string | null,
    plannerAgentName: string | null,
  ): void;
  buildReviewRoundSnapshotHash(meetingId: string, reviewRound: number, notes: string[]): string;
  getReviewRoundDecisionState(meetingId: string): ReviewRoundDecisionState | null;
  upsertReviewRoundDecisionState(
    meetingId: string,
    snapshotHash: string,
    status: DecisionStateStatus,
    plannerSummary: string | null,
    plannerAgentId: string | null,
    plannerAgentName: string | null,
  ): void;
  recordProjectReviewDecisionEvent(input: ProjectReviewDecisionEventInput): void;
}

export type LocalizedTextBuilder = (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => unknown;

export type PickLocalizedText = (localized: any, lang: string) => string;

export type AgentOneShotResult = {
  text?: string | null;
} & Record<string, unknown>;

export type FindTeamLeader = (departmentKey: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
export type RunAgentOneShot = (
  agent: AgentRow,
  prompt: string,
  options?: { projectPath?: string; timeoutMs?: number; rawOutput?: boolean; noTools?: boolean },
) => Promise<AgentOneShotResult>;
export type ChooseSafeReply = (run: AgentOneShotResult, lang: string, mode: string, agent?: AgentRow) => string;
export type GetAgentDisplayName = (agent: AgentRow, lang: string) => string;

export interface ProjectReviewPlanningDeps {
  db: DatabaseSync;
  nowMs: () => number;
  l: LocalizedTextBuilder;
  pickL: PickLocalizedText;
  findTeamLeader: FindTeamLeader;
  runAgentOneShot: RunAgentOneShot;
  chooseSafeReply: ChooseSafeReply;
  getAgentDisplayName: GetAgentDisplayName;
  getProjectReviewDecisionState: (projectId: string) => ProjectReviewDecisionState | null;
  recordProjectReviewDecisionEvent: (input: ProjectReviewDecisionEventInput) => void;
  packRegistry?: { get: (key: string) => any } | null;
  taskWorktrees?: Map<string, { worktreePath: string; projectPath: string }>;
}

export interface ProjectReviewPlanningHelpers {
  formatPlannerSummaryForDisplay(input: string): string;
  resolvePlanningLeadMeta(lang: string, decisionState?: PlanningLeadStateLike | null): PlanningLeadMeta;
  queueProjectReviewPlanningConsolidation(
    projectId: string,
    projectName: string,
    projectPath: string | null,
    snapshotHash: string,
    lang: string,
  ): void;
}

export interface ReviewRoundPlanningInput {
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
}

export interface ReviewRoundPlanningDeps {
  db: DatabaseSync;
  nowMs: () => number;
  l: LocalizedTextBuilder;
  pickL: PickLocalizedText;
  findTeamLeader: FindTeamLeader;
  runAgentOneShot: RunAgentOneShot;
  chooseSafeReply: ChooseSafeReply;
  getAgentDisplayName: GetAgentDisplayName;
  getReviewRoundDecisionState: (meetingId: string) => ReviewRoundDecisionState | null;
  formatPlannerSummaryForDisplay: (input: string) => string;
  recordProjectReviewDecisionEvent: (input: ProjectReviewDecisionEventInput) => void;
  getProjectReviewDecisionState: (projectId: string) => ProjectReviewDecisionState | null;
}

export interface ReviewRoundPlanningHelpers {
  queueReviewRoundPlanningConsolidation(input: ReviewRoundPlanningInput): void;
}

export interface ProjectReviewTaskChoice {
  id: string;
  title: string;
  updated_at: number;
  selected: boolean;
}

export interface ProjectAndTimeoutDecisionItemDeps {
  db: DatabaseSync;
  nowMs: () => number;
  getPreferredLanguage: () => string;
  pickL: PickLocalizedText;
  l: LocalizedTextBuilder;
  buildProjectReviewSnapshotHash: DecisionStateHelpers["buildProjectReviewSnapshotHash"];
  getProjectReviewDecisionState: DecisionStateHelpers["getProjectReviewDecisionState"];
  upsertProjectReviewDecisionState: DecisionStateHelpers["upsertProjectReviewDecisionState"];
  resolvePlanningLeadMeta: ProjectReviewPlanningHelpers["resolvePlanningLeadMeta"];
  formatPlannerSummaryForDisplay: ProjectReviewPlanningHelpers["formatPlannerSummaryForDisplay"];
  queueProjectReviewPlanningConsolidation: ProjectReviewPlanningHelpers["queueProjectReviewPlanningConsolidation"];
  PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: string;
}

export interface ProjectAndTimeoutDecisionItems {
  getProjectReviewTaskChoices(projectId: string): ProjectReviewTaskChoice[];
  buildProjectReviewDecisionItems(): ProjectReviewDecisionItem[];
  buildTimeoutResumeDecisionItems(): TimeoutResumeDecisionItem[];
}

export interface ReviewRoundDecisionItemDeps {
  db: DatabaseSync;
  nowMs: () => number;
  getPreferredLanguage: () => string;
  pickL: PickLocalizedText;
  l: LocalizedTextBuilder;
  buildReviewRoundSnapshotHash: DecisionStateHelpers["buildReviewRoundSnapshotHash"];
  getReviewRoundDecisionState: DecisionStateHelpers["getReviewRoundDecisionState"];
  upsertReviewRoundDecisionState: DecisionStateHelpers["upsertReviewRoundDecisionState"];
  resolvePlanningLeadMeta: ProjectReviewPlanningHelpers["resolvePlanningLeadMeta"];
  formatPlannerSummaryForDisplay: ProjectReviewPlanningHelpers["formatPlannerSummaryForDisplay"];
  queueReviewRoundPlanningConsolidation: ReviewRoundPlanningHelpers["queueReviewRoundPlanningConsolidation"];
}

export interface ReviewRoundDecisionItems {
  getReviewDecisionFallbackLabel(lang: string): string;
  getReviewDecisionNotes(taskId: string, reviewRound: number, limit?: number): string[];
  buildReviewRoundDecisionItems(): ReviewRoundDecisionItem[];
}

export type OpenSupplementRoundResult = { started: boolean; reason: string };
export type OpenSupplementRoundFn = (
  taskId: string,
  assignedAgentId: string | null,
  fallbackDepartmentId: string | null,
  logPrefix?: string,
  followUpNote?: string,
) => Promise<OpenSupplementRoundResult>;

export interface ProjectReviewReplyDeps {
  db: DatabaseSync;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
  normalizeTextField: (value: unknown) => string | null;
  getPreferredLanguage: () => string;
  pickL: PickLocalizedText;
  l: LocalizedTextBuilder;
  broadcast: (type: string, payload: unknown) => void;
  finishReview: (
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ) => void;
  getProjectReviewDecisionState: (projectId: string) => ProjectReviewDecisionState | null;
  recordProjectReviewDecisionEvent: (input: ProjectReviewDecisionEventInput) => void;
  getProjectReviewTaskChoices: (projectId: string) => ProjectReviewTaskChoice[];
  openSupplementRound: OpenSupplementRoundFn;
  processSubtaskDelegations?: (taskId: string, opts?: { includeRender?: boolean }) => void;
  PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: string;
}

export interface ReviewRoundReplyDeps {
  db: DatabaseSync;
  l: LocalizedTextBuilder;
  pickL: PickLocalizedText;
  nowMs: () => number;
  resolveLang: (input: string) => string;
  normalizeTextField: (value: unknown) => string | null;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  processSubtaskDelegations: (taskId: string) => void;
  seedReviewRevisionSubtasks: (taskId: string, departmentId: string | null, notes: string[]) => number;
  scheduleNextReviewRound: (taskId: string, taskTitle: string, reviewRound: number, lang: string) => void;
  getProjectReviewDecisionState: (projectId: string) => ProjectReviewDecisionState | null;
  getReviewDecisionNotes: (taskId: string, reviewRound: number, limit?: number) => string[];
  getReviewDecisionFallbackLabel: (lang: string) => string;
  recordProjectReviewDecisionEvent: (input: ProjectReviewDecisionEventInput) => void;
  openSupplementRound: OpenSupplementRoundFn;
  REVIEW_DECISION_RESOLVED_LOG_PREFIX: string;
}

export interface TimeoutReplyDeps {
  db: DatabaseSync;
  activeProcesses: Map<string, unknown>;
  getDeptName: (departmentId: string) => string;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  startTaskExecutionForAgent: (
    taskId: string,
    agent: AgentRow,
    departmentId: string | null,
    departmentName: string,
  ) => void;
}

export interface ProjectReviewReplyInput {
  req: Request;
  res: Response;
  currentItem: DecisionInboxRouteItem;
  selectedOption: DecisionOption;
  optionNumber: number;
  deps: ProjectReviewReplyDeps;
}

export interface ReviewRoundReplyInput {
  req: Request;
  res: Response;
  currentItem: DecisionInboxRouteItem;
  selectedOption: DecisionOption;
  optionNumber: number;
  deps: ReviewRoundReplyDeps;
}

export interface TimeoutReplyInput {
  res: Response;
  currentItem: DecisionInboxRouteItem;
  selectedOption: DecisionOption;
  deps: TimeoutReplyDeps;
}
