/** Professional career level is independent from talent, persona, runtime and permissions. */
import { z } from "zod";
export const CAREER_FALLBACK_REVIEWER_ROLES = [
  "qa",
  "coo",
  "quality_assurance",
  "chief_operating_officer",
  "qa_lead",
  "quality_assurance_lead",
  "qa_root_cause_red_team",
] as const;
export const careerLevelSchema = z.enum(["junior", "senior", "lead"]);
export type CareerLevel = z.infer<typeof careerLevelSchema>;
export const difficultySchema = z.enum(["simple", "normal", "complex"]);
export type Difficulty = z.infer<typeof difficultySchema>;
const id = z.string().min(1).max(256);
const score = z.number().int().min(1).max(5);
export const leadRoutingOutputSchema = z
  .object({
    version: z.literal(1),
    assignedAgentId: id,
    difficulty: difficultySchema,
    rationale: z.string().trim().min(1).max(8000),
  })
  .strict();
export const leadReviewOutputSchema = z
  .object({
    version: z.literal(1),
    score,
    rationale: z.string().trim().min(1).max(8000),
    rubricDimensions: z.object({ correctness: score, completeness: score, quality: score }).strict(),
    evidence: z.array(z.string().max(2000)).max(30).default([]),
  })
  .strict();
export const departmentCareerPolicySchema = z
  .object({
    departmentId: id,
    enabled: z.boolean(),
    leadAgentId: id.nullable(),
    fallbackReviewerAgentId: id.nullable(),
  })
  .strict();
export const careerConfigUpdateSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    departments: z.array(departmentCareerPolicySchema).max(200),
  })
  .strict();
export const careerLevelRequestSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    level: careerLevelSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type DepartmentCareerPolicy = z.infer<typeof departmentCareerPolicySchema>;
export interface CareerProfile {
  agentId: string;
  level: CareerLevel;
  revision: number;
}
export interface CareerConfig {
  revision: number;
  enabled: boolean;
  departments: DepartmentCareerPolicy[];
}
export interface WorkflowLink {
  id: string;
  companyId: string;
  purpose: "routing" | "review";
  taskId: string;
  workRunId: string | null;
  internalTaskId: string | null;
  leadAgentId: string | null;
  reviewerAgentId: string | null;
  revision: number;
  status: "pending" | "completed" | "failed" | "owner_required";
  difficulty: Difficulty;
  runId: string | null;
  assignedAgentId: string | null;
  rationale: string;
}
export interface CareerReview {
  rubricVersion: number;
  reviewerRuntimeType: string;
  reviewerModel: string | null;
  reviewerVesselId: string | null;
  id: string;
  taskId: string;
  workRunId: string;
  reviewRunId: string;
  agentId: string;
  reviewerAgentId: string;
  runtimeType: string;
  model: string | null;
  vesselId: string | null;
  revision: number;
  difficulty: Difficulty;
  score: number;
  rationale: string;
  rubricDimensions: { correctness: number; completeness: number; quality: number };
  evidence: string[];
  createdAt: number;
  isCurrent: boolean;
}
export interface RatingAggregate {
  key: string;
  count: number;
  mean: number;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  revisions: number;
  complexity: Record<Difficulty, number>;
}
export interface CareerChange {
  id: string;
  agentId: string;
  level: CareerLevel;
  baseRevision: number;
  approvalId: string;
  status: string;
}
export interface CareerSnapshot {
  workflows: WorkflowLink[];
  config: CareerConfig;
  profiles: CareerProfile[];
  reviews: CareerReview[];
  aggregates: { agents: RatingAggregate[]; models: RatingAggregate[] };
  pendingChanges: CareerChange[];
}
export interface CareerFilters {
  from?: number;
  to?: number;
  difficulty?: Difficulty;
  model?: string;
}
