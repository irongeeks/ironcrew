import type { MessengerChannel } from "../../../messenger/channels.ts";

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

export type DelegationOptions = {
  skipPlannedMeeting?: boolean;
  skipPlanSubtasks?: boolean;
  projectId?: string | null;
  projectPath?: string | null;
  projectContext?: string | null;
  messengerChannel?: MessengerChannel;
  messengerTargetId?: string | null;
  messengerSessionKey?: string | null;
};

export type MeetingReviewDecision = "reviewing" | "approved" | "hold";

export interface MeetingMinutesRow {
  id: string;
  task_id: string;
  meeting_type: string;
  round: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  summary?: string | null;
  [key: string]: unknown;
}

export interface MeetingMinuteEntryRow {
  id: string;
  meeting_id: string;
  seq: number;
  speaker_agent_id: string | null;
  speaker_name: string | null;
  speaker_department: string | null;
  speaker_role: string | null;
  lang: string | null;
  message_type: string | null;
  content: string;
  created_at: number | null;
  [key: string]: unknown;
}

export interface StoredMessage {
  id: string;
  sender_type: string;
  sender_id: string | null;
  receiver_type: string;
  receiver_id: string | null;
  content: string;
  message_type: string;
  task_id: string | null;
  idempotency_key: string | null;
  created_at: number;
}

export interface DecryptedOAuthToken {
  id: string | null;
  provider: string;
  source: string | null;
  label: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  email: string | null;
  status?: string;
  priority?: number;
  modelOverride?: string | null;
  failureCount?: number;
  lastError?: string | null;
  lastErrorAt?: number | null;
  lastSuccessAt?: number | null;
}

export interface CliUsageEntry {
  windows: Array<Record<string, unknown>>;
  error?: string | null;
  [key: string]: unknown;
}
