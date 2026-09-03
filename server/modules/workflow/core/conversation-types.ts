export interface MeetingTranscriptEntry {
  speaker_agent_id?: string;
  speaker: string;
  department: string;
  role: string;
  content: string;
}

export interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  cli_profile: string | null;
}

export type MeetingReviewDecision = "reviewing" | "approved" | "hold";

export interface OneShotRunOptions {
  projectPath?: string;
  timeoutMs?: number;
  streamTaskId?: string | null;
  rawOutput?: boolean;
  noTools?: boolean;
}

export interface OneShotRunResult {
  text: string;
  error?: string;
}

export interface MeetingPromptOptions {
  meetingType: "planned" | "review";
  round: number;
  taskTitle: string;
  taskDescription: string | null;
  workflowPackKey?: string | null;
  transcript: MeetingTranscriptEntry[];
  turnObjective: string;
  stanceHint?: string;
  lang: string;
}

export type ReplyKind = "opening" | "feedback" | "summary" | "approval" | "direct";
export type RunFailureKind = "permission" | "stale_file" | "tool_calls_only" | "timeout" | "generic";
