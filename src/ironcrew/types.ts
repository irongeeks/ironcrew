/** Shared client-side types for the IronCrew control plane. */

export type TaskStatus =
  | "inbox"
  | "planned"
  | "ready"
  | "assigned"
  | "running"
  | "waiting"
  | "blocked"
  | "review"
  | "approval_required"
  | "done"
  | "failed"
  | "cancelled";

export type AgentStatus =
  | "offline"
  | "idle"
  | "thinking"
  | "working"
  | "in_meeting"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "rate_limited"
  | "paused"
  | "error";

export interface AgentPolicy {
  may_delegate: boolean;
  may_create_tasks: boolean;
  may_approve: false;
  may_veto?: boolean;
  max_risk_level: string;
  allowed_tools: string[];
  requires_approval_for: string[];
}

export interface PersonaSkin {
  display_name: string;
  accent: string;
  traits: string[];
  forbidden_traits: string[];
  portrait: string | null;
  full_body: string | null;
  model_3d: string | null;
}

export interface Agent {
  id: string;
  key: string;
  displayName: string;
  professionalRole: string;
  roleSummary: string;
  seniority: string;
  departmentId: string | null;
  runtimeProfile: string;
  runtimeProvider: string;
  isExecutiveAssistant: boolean;
  persona: PersonaSkin;
  policy: AgentPolicy;
  status: AgentStatus;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: string;
  risk_level: string;
  sensitive: number;
  assigned_agent_id: string | null;
  result_summary: string | null;
  review_notes: string | null;
  correlation_id: string;
  created_at: number;
  updated_at: number;
}

export type GoalStatus = "active" | "achieved" | "abandoned" | "on_hold";

export interface Goal {
  id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: GoalStatus;
  created_at: number;
}

export type ProjectStatus = "draft" | "active" | "on_hold" | "done" | "cancelled";

export interface Project {
  id: string;
  goal_id: string | null;
  key: string;
  title: string;
  summary: string;
  status: ProjectStatus;
  owner_agent_id: string | null;
  workspace_path: string | null;
  created_at: number;
  updated_at: number;
}

export type MilestoneStatus = "pending" | "done" | "missed" | "cancelled";

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  due_at: number | null;
  sort_order: number;
  created_at: number;
  completed_at: number | null;
}

export interface Message {
  id: string;
  role: "ceo" | "agent" | "system";
  author_agent_id: string | null;
  body: string;
  task_id: string | null;
  triage_json: string | null;
  created_at: number;
}

export interface Approval {
  id: string;
  approval_type: string;
  summary: string;
  risk_level: string;
  impact: string;
  rollback_plan: string;
  status: string;
  task_id: string | null;
  created_at: number;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface Notification {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  task_id: string | null;
  approval_id: string | null;
  read_at: number | null;
  created_at: number;
}

export interface Decision {
  id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  decided_by: string;
  created_at: number;
}

export const NOTIFICATION_SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: "Info",
  warning: "Warnung",
  critical: "Kritisch",
};

export interface RunEvent {
  eventId: string;
  type: string;
  seq: number;
  timestamp: number;
  taskId: string;
  runId: string;
  payload: Record<string, unknown>;
  redaction: { redacted: boolean; rules: string[] };
}

export interface Dashboard {
  generatedAt: number;
  source: string;
  tasks: {
    running: number;
    blocked: number;
    review: number;
    approvalRequired: number;
    done: number;
    failed: number;
    total: number;
  };
  agents: { total: number; working: number; rateLimited: number; waitingForApproval: number };
  approvalsPending: number;
  budgets: Array<{ budget: { scope_type: string; limit_micros: number }; spentMicros: number; state: string }>;
  auditChainValid: boolean;
}

export interface Department {
  id: string;
  key: string;
  name: string;
  description: string;
}

/**
 * One registered runtime's live capability/health/auth probe — mock and
 * real CLI adapters alike (server/ironcrew/runtime/run-events.ts).
 * `auth.accountHint`, when present, is contractually never an email or a
 * token (docs/PROVIDER_AUTH.md) — safe to render as-is.
 */
export interface RuntimeInfo {
  type: string;
  capabilities: {
    streaming: boolean;
    sessionResume: boolean;
    usageReporting: boolean;
    costReporting: boolean;
    toolCalls: boolean;
    subagents: boolean;
    defaultConcurrency: number;
    version?: string;
  };
  health: { healthy: boolean; installed: boolean; detail: string; checkedAt: number };
  auth: {
    authenticated: boolean;
    method: "subscription-cli" | "oauth-cli" | "api-key" | "none";
    accountHint?: string;
    detail: string;
    setupHint?: string;
  };
}

/** German labels. The product ships German as its default locale. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "Eingang",
  planned: "Geplant",
  ready: "Bereit",
  assigned: "Zugewiesen",
  running: "Läuft",
  waiting: "Wartet",
  blocked: "Blockiert",
  review: "Review",
  approval_required: "Freigabe nötig",
  done: "Erledigt",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  offline: "Offline",
  idle: "Bereit",
  thinking: "Denkt nach",
  working: "Arbeitet",
  in_meeting: "Im Meeting",
  waiting_for_input: "Wartet auf Eingabe",
  waiting_for_approval: "Wartet auf Freigabe",
  rate_limited: "Rate-Limit",
  paused: "Pausiert",
  error: "Fehler",
};

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Aktiv",
  achieved: "Erreicht",
  abandoned: "Aufgegeben",
  on_hold: "Pausiert",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Entwurf",
  active: "Aktiv",
  on_hold: "Pausiert",
  done: "Abgeschlossen",
  cancelled: "Abgebrochen",
};

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = {
  pending: "Ausstehend",
  done: "Erledigt",
  missed: "Verpasst",
  cancelled: "Abgebrochen",
};

/** Columns shown on the board, in workflow order. */
export const BOARD_COLUMNS: Array<{ status: TaskStatus; accent?: "active" | "decision" | "critical" }> = [
  { status: "inbox" },
  { status: "ready" },
  { status: "running", accent: "active" },
  { status: "waiting" },
  { status: "blocked", accent: "critical" },
  { status: "review", accent: "decision" },
  { status: "approval_required", accent: "decision" },
  { status: "done" },
];

export type SecretProviderKind = "vaultwarden" | "protonpass";

export const SECRET_PROVIDER_LABEL: Record<SecretProviderKind, string> = {
  vaultwarden: "Vaultwarden",
  protonpass: "Proton Pass",
};

/** A pointer to where a secret lives in an external vault — never a value. See docs/THREAT_MODEL.md. */
export interface Secret {
  id: string;
  name: string;
  provider: SecretProviderKind;
  item_ref: string;
  field: string | null;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface SecretProviderStatus {
  kind: SecretProviderKind;
  registered: boolean;
  ok: boolean;
  message: string;
}

export interface Attachment {
  id: string;
  task_id: string | null;
  project_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

export interface TailscalePeer {
  id: string;
  hostName: string;
  dnsName: string;
  tailscaleIPs: string[];
  online: boolean;
  os: string;
}

export interface TailscaleInfo {
  backendState: string;
  self: TailscalePeer | null;
  peers: TailscalePeer[];
  ok: boolean;
  message: string;
}

export type KnownHostsPolicy = "strict" | "accept";

export interface RemoteWorker {
  id: string;
  label: string;
  environment: string;
  host: string;
  port: number;
  ssh_user: string;
  private_key_path: string;
  known_hosts_policy: KnownHostsPolicy;
  notes: string;
  created_at: number;
  updated_at: number;
}

export type MeetingStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export const MEETING_STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: "Geplant",
  in_progress: "Läuft",
  completed: "Abgeschlossen",
  cancelled: "Abgebrochen",
};

export interface Meeting {
  id: string;
  company_id: string;
  project_id: string | null;
  topic: string;
  status: MeetingStatus;
  moderator_agent_id: string;
  max_rounds: number;
  budget_micros: number;
  spent_micros: number;
  current_round: number;
  minutes: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface MeetingParticipant {
  agent_id: string;
  key: string;
  display_name: string;
  professional_role: string;
}

export interface MeetingTurn {
  id: string;
  meeting_id: string;
  round: number;
  agent_id: string;
  contribution: string;
  cost_micros: number;
  created_at: number;
}

export interface MeetingActionItem {
  id: string;
  meeting_id: string;
  description: string;
  assigned_agent_id: string | null;
  task_id: string | null;
  created_at: number;
}

export type MemoryKind = "note" | "fact" | "preference" | "hypothesis" | "summary";

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  note: "Notiz",
  fact: "Fakt",
  preference: "Präferenz",
  hypothesis: "Hypothese",
  summary: "Zusammenfassung",
};

export interface MemoryProviderStatus {
  kind: string;
  registered: boolean;
  ok: boolean;
  message: string;
}

export interface MemoryRef {
  id: string;
  company_id: string;
  provider: string;
  external_id: string;
  kind: MemoryKind;
  title: string;
  path: string | null;
  task_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  source: string;
  confidence: number;
  sensitivity: string;
  created_at: number;
}

export interface MemorySearchHit {
  externalId: string;
  title: string;
  snippet: string;
  path: string | null;
}

export interface NotificationChannelStatus {
  kind: string;
  registered: boolean;
  ok: boolean;
  message: string;
}

export const NOTIFICATION_CHANNEL_LABEL: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  email: "E-Mail",
};
