/** Coaching changes professional guidance only; tool grants and persona remain separate. */
export type CoachingCaseKind =
  | "guidance_contains"
  | "guidance_excludes"
  | "skill_present"
  | "run_succeeded"
  | "run_output_contains";
export interface CoachingCase {
  label: string;
  kind: CoachingCaseKind;
  expected?: string;
  runId?: string;
}
export interface CoachingCaseResult extends CoachingCase {
  passed: boolean;
  observed: string;
  evidenceHash: string | null;
}
export interface CoachingEvaluation {
  id: string;
  createdAt: number;
  passed: boolean;
  passedCases: number;
  totalCases: number;
  checks: CoachingCaseResult[];
}
export interface CoachingProposal {
  id: string;
  agentId: string;
  title: string;
  guidance: string;
  skills: string[];
  cases: CoachingCase[];
  baseVersion: number;
  status: "draft" | "ready" | "failed" | "applied" | "rejected";
  createdAt: number;
  createdBy: string;
  reviewReason: string;
  reviewedBy: string | null;
  evaluation: CoachingEvaluation | null;
}
export interface CoachingVersion {
  version: number;
  guidance: string;
  skills: string[];
  proposalId: string;
  approvedBy: string;
  createdAt: number;
}
export interface CoachingNote {
  id: string;
  agentId: string;
  kind: "one_on_one" | "retrospective" | "lesson";
  title: string;
  body: string;
  runId: string | null;
  createdBy: string;
  createdAt: number;
}
export interface CoachingSnapshot {
  proposals: CoachingProposal[];
  notes: CoachingNote[];
  versions: CoachingVersion[];
  current: CoachingVersion | null;
  skills: string[];
}
