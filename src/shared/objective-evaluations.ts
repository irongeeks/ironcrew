export type ObjectiveCase =
  | { id: string; label: string; kind: "contains" | "excludes"; expected: string }
  | {
      id: string;
      label: string;
      kind: "json_field";
      path: string[];
      valueType: "string" | "number" | "boolean" | "array" | "object" | "null";
    };
export interface ObjectiveRubric {
  id: string;
  key: string;
  version: number;
  title: string;
  reason: string;
  cases: ObjectiveCase[];
  hash: string;
  createdAt: number;
  createdBy: string;
}
export interface ObjectiveEvidenceRun {
  id: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  runtimeType: string;
  model: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}
export interface ObjectiveMeasurement {
  id: string;
  rubricId: string;
  rubricHash: string;
  engineVersion: number;
  run: ObjectiveEvidenceRun;
  evidenceHash: string;
  outputHash: string;
  checks: Array<{ caseId: string; label: string; passed: boolean; observed: string }>;
  passedCases: number;
  totalCases: number;
  score: number;
  createdAt: number;
  createdBy: string;
}
export interface ObjectiveComparison {
  rubricId: string;
  agentId: string;
  agentName: string;
  runtimeType: string;
  model: string | null;
  runCount: number;
  score: number;
}
export interface ObjectiveSnapshot {
  rubrics: ObjectiveRubric[];
  measurements: ObjectiveMeasurement[];
  runs: ObjectiveEvidenceRun[];
  comparisons: ObjectiveComparison[];
  canEdit: boolean;
  canMeasure: boolean;
}
