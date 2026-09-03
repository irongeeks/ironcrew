import { del, extractMessageId, makeIdempotencyKey, post, postWithIdempotency, put, request } from "./core";

import type {
  CliModelInfo,
  CliStatusMap,
  CompanySettings,
  CompanyStats,
  MeetingMinute,
  Message,
  MessageType,
  ReceiverType,
  RoomTheme,
} from "../types";

// Messages
export async function getMessages(params: {
  receiver_type?: ReceiverType;
  receiver_id?: string;
  limit?: number;
}): Promise<Message[]> {
  const sp = new URLSearchParams();
  if (params.receiver_type) sp.set("receiver_type", params.receiver_type);
  if (params.receiver_id) sp.set("receiver_id", params.receiver_id);
  if (params.limit) sp.set("limit", String(params.limit));
  const q = sp.toString();
  const j = await request<{ messages: Message[] }>(`/api/messages${q ? "?" + q : ""}`);
  return j.messages;
}

export type DecisionInboxRouteOption = {
  number: number;
  action: string;
  label?: string;
};

export type DecisionInboxRouteItem = {
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
  options: DecisionInboxRouteOption[];
};

export type DecisionInboxReplyResult = {
  ok: boolean;
  resolved: boolean;
  kind: "project_review_ready" | "task_timeout_resume" | "review_round_pick";
  action: string;
  started_task_ids?: string[];
  task_id?: string;
  blocked_tasks?: Array<{
    id: string;
    title: string;
    reason: string;
    detail: string;
  }>;
};

export async function getDecisionInbox(): Promise<DecisionInboxRouteItem[]> {
  const j = await request<{ items: DecisionInboxRouteItem[] }>("/api/decision-inbox");
  return j.items ?? [];
}

export async function replyDecisionInbox(
  id: string,
  optionNumber: number,
  payload?: { note?: string; target_task_id?: string; selected_option_numbers?: number[] },
): Promise<DecisionInboxReplyResult> {
  return request<DecisionInboxReplyResult>(`/api/decision-inbox/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      option_number: optionNumber,
      ...(payload?.note ? { note: payload.note } : {}),
      ...(payload?.target_task_id ? { target_task_id: payload.target_task_id } : {}),
      ...(payload && Object.prototype.hasOwnProperty.call(payload, "selected_option_numbers")
        ? { selected_option_numbers: payload.selected_option_numbers }
        : {}),
    }),
  });
}

export async function sendMessage(input: {
  receiver_type: ReceiverType;
  receiver_id?: string;
  content: string;
  message_type?: MessageType;
  task_id?: string;
  project_id?: string;
  project_path?: string;
  project_context?: string;
}): Promise<string> {
  const idempotencyKey = makeIdempotencyKey("ceo-message");
  const j = await postWithIdempotency<{ id?: string; message?: { id?: string } }>(
    "/api/messages",
    { sender_type: "ceo", ...input },
    idempotencyKey,
  );
  return extractMessageId(j);
}

export async function sendAnnouncement(content: string): Promise<string> {
  const idempotencyKey = makeIdempotencyKey("ceo-announcement");
  const j = await postWithIdempotency<{ id?: string; message?: { id?: string } }>(
    "/api/announcements",
    { content },
    idempotencyKey,
  );
  return extractMessageId(j);
}

export async function sendDirective(content: string): Promise<string> {
  const idempotencyKey = makeIdempotencyKey("ceo-directive");
  const j = await postWithIdempotency<{ id?: string; message?: { id?: string } }>(
    "/api/directives",
    { content },
    idempotencyKey,
  );
  return extractMessageId(j);
}

export async function sendDirectiveWithProject(input: {
  content: string;
  project_id?: string;
  project_path?: string;
  project_context?: string;
}): Promise<string> {
  const idempotencyKey = makeIdempotencyKey("ceo-directive");
  const j = await postWithIdempotency<{ id?: string; message?: { id?: string } }>(
    "/api/directives",
    input,
    idempotencyKey,
  );
  return extractMessageId(j);
}

export async function clearMessages(agentId?: string): Promise<void> {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent_id", agentId);
  } else {
    params.set("scope", "announcements");
  }
  await del(`/api/messages?${params.toString()}`);
}

export type TerminalProgressHint = {
  phase: "use" | "ok" | "error";
  tool: string;
  summary: string;
  file_path: string | null;
};

export type TerminalProgressHintsPayload = {
  current_file: string | null;
  hints: TerminalProgressHint[];
  ok_items: string[];
};

// Terminal
export async function getTerminal(
  id: string,
  lines?: number,
  pretty?: boolean,
  logLimit?: number,
): Promise<{
  ok: boolean;
  exists: boolean;
  path: string;
  text: string;
  task_logs?: Array<{ id: number; kind: string; message: string; created_at: number }>;
  progress_hints?: TerminalProgressHintsPayload | null;
  interrupt?: {
    session_id: string;
    control_token: string;
    requires_csrf: boolean;
  } | null;
}> {
  const params = new URLSearchParams();
  if (lines) params.set("lines", String(lines));
  if (pretty) params.set("pretty", "1");
  if (logLimit) params.set("log_limit", String(logLimit));
  const q = params.toString();
  return request(`/api/tasks/${id}/terminal${q ? "?" + q : ""}`);
}

export async function getTaskMeetingMinutes(id: string): Promise<MeetingMinute[]> {
  const j = await request<{ meetings: MeetingMinute[] }>(`/api/tasks/${id}/meeting-minutes`);
  return j.meetings;
}

// CLI Status
export async function getCliStatus(refresh?: boolean): Promise<CliStatusMap> {
  const q = refresh ? "?refresh=1" : "";
  const j = await request<{ providers: CliStatusMap }>(`/api/cli-status${q}`);
  return j.providers;
}

// Stats
export async function getStats(): Promise<CompanyStats> {
  const j = await request<{ stats: CompanyStats }>("/api/stats");
  return j.stats;
}

// Settings
export async function getSettings(): Promise<CompanySettings> {
  const j = await request<{ settings: CompanySettings }>("/api/settings");
  return j.settings;
}

export async function getSettingsRaw(): Promise<Record<string, unknown>> {
  const j = await request<{ settings: Record<string, unknown> }>("/api/settings");
  return j.settings;
}

export async function saveSettings(settings: CompanySettings): Promise<void> {
  await put("/api/settings", settings);
}

export async function saveSettingsPatch(patch: Record<string, unknown>): Promise<void> {
  await put("/api/settings", patch);
}

export async function saveRoomThemes(roomThemes: Record<string, RoomTheme>): Promise<void> {
  await put("/api/settings", { roomThemes });
}

export interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  checked_at: number;
  enabled: boolean;
  repo: string;
  error: string | null;
}

export async function getUpdateStatus(refresh?: boolean): Promise<UpdateStatus> {
  const q = refresh ? "?refresh=1" : "";
  const j = await request<UpdateStatus & { ok?: boolean }>(`/api/update-status${q}`);
  const { ok: _ok, ...status } = j;
  return status;
}

export async function setAutoUpdateEnabled(enabled: boolean): Promise<void> {
  await post("/api/update-auto-config", { enabled });
}

// OAuth
export interface OAuthAccountInfo {
  id: string;
  label: string | null;
  email: string | null;
  source: string | null;
  scope: string | null;
  status: "active" | "disabled";
  priority: number;
  expires_at: number | null;
  hasRefreshToken: boolean;
  executionReady: boolean;
  active: boolean;
  modelOverride?: string | null;
  failureCount?: number;
  lastError?: string | null;
  lastErrorAt?: number | null;
  lastSuccessAt?: number | null;
  created_at: number;
  updated_at: number;
}

export interface OAuthProviderStatus {
  connected: boolean;
  detected?: boolean;
  executionReady?: boolean;
  requiresWebOAuth?: boolean;
  source: string | null;
  email: string | null;
  scope: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  webConnectable: boolean;
  hasRefreshToken?: boolean;
  refreshFailed?: boolean;
  lastRefreshed?: number | null;
  activeAccountId?: string | null;
  activeAccountIds?: string[];
  accounts?: OAuthAccountInfo[];
}

export type OAuthConnectProvider = "github-copilot" | "antigravity";

export interface OAuthStatus {
  storageReady: boolean;
  providers: Record<string, OAuthProviderStatus>;
}

export async function getOAuthStatus(): Promise<OAuthStatus> {
  return request<OAuthStatus>("/api/oauth/status");
}

export function getOAuthStartUrl(provider: OAuthConnectProvider, redirectTo: string): string {
  const params = new URLSearchParams({ provider, redirect_to: redirectTo });
  return `/api/oauth/start?${params.toString()}`;
}

export async function disconnectOAuth(provider: OAuthConnectProvider): Promise<void> {
  await post("/api/oauth/disconnect", { provider });
}

export interface OAuthRefreshResult {
  ok: boolean;
  expires_at: number | null;
  refreshed_at: number;
}

export async function refreshOAuthToken(provider: OAuthConnectProvider): Promise<OAuthRefreshResult> {
  return post("/api/oauth/refresh", { provider }) as Promise<OAuthRefreshResult>;
}

export async function activateOAuthAccount(
  provider: OAuthConnectProvider,
  accountId: string,
  mode: "exclusive" | "add" | "remove" | "toggle" = "exclusive",
): Promise<{ ok: boolean; activeAccountIds?: string[] }> {
  return post("/api/oauth/accounts/activate", { provider, account_id: accountId, mode }) as Promise<{
    ok: boolean;
    activeAccountIds?: string[];
  }>;
}

export async function updateOAuthAccount(
  accountId: string,
  patch: { label?: string | null; model_override?: string | null; priority?: number; status?: "active" | "disabled" },
): Promise<{ ok: boolean }> {
  return put(`/api/oauth/accounts/${accountId}`, patch) as Promise<{ ok: boolean }>;
}

export async function deleteOAuthAccount(provider: OAuthConnectProvider, accountId: string): Promise<{ ok: boolean }> {
  return post("/api/oauth/disconnect", { provider, account_id: accountId }) as Promise<{ ok: boolean }>;
}

// GitHub Device Code Flow
export interface DeviceCodeStart {
  stateId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DevicePollResult {
  status: "pending" | "complete" | "slow_down" | "expired" | "denied" | "error";
  email?: string | null;
  error?: string;
}

export async function startGitHubDeviceFlow(): Promise<DeviceCodeStart> {
  return post("/api/oauth/github-copilot/device-start") as Promise<DeviceCodeStart>;
}

export async function pollGitHubDevice(stateId: string): Promise<DevicePollResult> {
  return post("/api/oauth/github-copilot/device-poll", { stateId }) as Promise<DevicePollResult>;
}

export async function saveCodexApiKey(apiKey: string): Promise<{ authenticated: boolean }> {
  return post<{ authenticated: boolean }>("/api/ops/cli-auth/codex/api-key", { apiKey });
}

export async function saveClaudeApiKey(apiKey: string): Promise<{ authenticated: boolean }> {
  return post<{ authenticated: boolean }>("/api/ops/cli-auth/claude/api-key", { apiKey });
}

// OAuth Models
export async function getOAuthModels(refresh = false): Promise<Record<string, string[]>> {
  const qs = refresh ? "?refresh=true" : "";
  const j = await request<{ models: Record<string, string[]> }>(`/api/oauth/models${qs}`);
  return j.models;
}

// CLI Models (for CLI provider model selection)
export async function getCliModels(refresh = false): Promise<Record<string, CliModelInfo[]>> {
  const qs = refresh ? "?refresh=true" : "";
  const j = await request<{ models: Record<string, CliModelInfo[]> }>(`/api/cli-models${qs}`);
  return j.models;
}

// Setup Status
export type SetupCheckResult = {
  ok: boolean;
  detail?: string;
  count?: number;
  provider?: string;
};

export type SetupStatus = {
  status: "ready" | "partial" | "not_configured";
  checks: Record<string, SetupCheckResult>;
  onboarding_completed: boolean;
  required_ok: boolean;
  optional_ok: boolean;
};

export async function getSetupStatus(): Promise<SetupStatus> {
  return request<SetupStatus>("/api/ops/setup-status");
}
