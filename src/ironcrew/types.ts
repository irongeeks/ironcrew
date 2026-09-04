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

/**
 * Where a vote on one approval stands.
 *
 * `satisfied` and `blocked` are both computed server-side rather than left to
 * the client to derive from the three counts. The precedence between them is
 * not obvious — a rejection outranks any number of approvals — and a UI that
 * got it wrong would show "freigegeben" next to a refusal.
 */
export interface ApprovalTally {
  approvals: number;
  rejections: number;
  required: number;
  satisfied: boolean;
  blocked: boolean;
  outstanding: number;
  selfApproved: boolean;
}

export interface ApprovalReview {
  id: string;
  approval_id: string;
  reviewer_id: string;
  verdict: "approved" | "rejected";
  reason: string;
  reviewed_at: number;
  /**
   * A name a colleague recognises, resolved server-side. Falls back to the
   * account id — a deleted account is still evidence, and an id is at least
   * traceable, where "Unbekannt" is not.
   */
  reviewer_label?: string;
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
  /**
   * Optional because the list endpoint attaches them and other places that
   * hand back a bare approval row do not. A missing tally means "quorum of
   * one, nobody has voted" — which is what an approval without reviews is —
   * and the panel renders nothing extra rather than an empty vote counter.
   */
  tally?: ApprovalTally;
  reviews?: ApprovalReview[];
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

export type MailboxKind = "imap" | "jmap" | "m365" | "gmail";

export const MAILBOX_KIND_LABEL: Record<MailboxKind, string> = {
  imap: "IMAP",
  jmap: "JMAP",
  m365: "Microsoft 365",
  gmail: "Gmail",
};

export type MailboxAccess = "read" | "send";

export const MAILBOX_ACCESS_LABEL: Record<MailboxAccess, string> = {
  read: "Lesen",
  send: "Lesen + Senden",
};

export interface MailboxAgent {
  agent_id: string;
  key: string;
  display_name: string;
  access: MailboxAccess;
  granted_at: number;
}

/** Never carries credentials — see server/ironcrew/domain/mailbox-store.ts. */
export interface Mailbox {
  id: string;
  company_id: string;
  label: string;
  kind: MailboxKind;
  email_address: string;
  host: string;
  port: number;
  use_tls: number;
  username: string;
  smtp_host: string;
  smtp_port: number;
  session_url: string;
  tenant_id: string;
  client_id: string;
  poll_enabled: number;
  poll_interval_seconds: number;
  auto_triage: number;
  last_polled_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
  agents?: MailboxAgent[];
}

export interface MailboxMessageRef {
  id: string;
  mailbox_id: string;
  external_id: string;
  message_id: string;
  subject: string;
  from_address: string;
  received_at: number | null;
  task_id: string | null;
  triaged_at: number | null;
  created_at: number;
}

/** A message as the mail server reports it right now — never stored locally. */
export interface MailMessage {
  externalId: string;
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: number | null;
  snippet: string;
  unread: boolean;
}

export interface MailProviderStatus {
  kind: MailboxKind;
  registered: boolean;
}

// --- marketplaces: skills and MCP servers from outside this machine --------

export type MarketplaceKind = "catalog" | "mcp-registry" | "claude-plugin" | "git";

export const MARKETPLACE_KIND_LABEL: Record<MarketplaceKind, string> = {
  catalog: "Katalog (JSON)",
  "mcp-registry": "MCP-Registry",
  "claude-plugin": "Claude-Code-Marktplatz",
  git: "Git-Repository",
};

/** What an admin has to type in for each kind, in the placeholder. */
export const MARKETPLACE_URL_HINT: Record<MarketplaceKind, string> = {
  catalog: "https://…/catalog.json",
  "mcp-registry": "https://registry.modelcontextprotocol.io",
  "claude-plugin": "https://github.com/owner/plugins",
  git: "https://github.com/owner/repo",
};

export type MarketplaceEntryType = "mcp" | "skill";

export const MARKETPLACE_ENTRY_TYPE_LABEL: Record<MarketplaceEntryType, string> = {
  mcp: "MCP-Server",
  skill: "Skill",
};

export interface Marketplace {
  id: string;
  company_id: string;
  name: string;
  kind: MarketplaceKind;
  url: string;
  enabled: number;
  last_synced_at: number | null;
  last_error: string;
  entry_count: number;
  created_at: number;
  updated_at: number;
}

/** An offer, read live from its source — never stored locally. */
export interface MarketplaceEntry {
  id: string;
  type: MarketplaceEntryType;
  name: string;
  title: string;
  description: string;
  version: string;
  homepage: string;
  sourceUrl: string;
  mcp?: {
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  skill?: { repo?: string; contentUrl?: string; content?: string };
}

/** What was installed, and where it came from. */
export interface MarketplaceInstall {
  id: string;
  company_id: string;
  marketplace_id: string | null;
  entry_id: string;
  entry_type: MarketplaceEntryType;
  name: string;
  version: string;
  source_url: string;
  installed_by: string;
  manifest: string;
  installed_at: number;
}

export interface MarketplaceKindStatus {
  kind: MarketplaceKind;
  registered: boolean;
}

// --- messenger pairings: who may talk to the executive assistant -----------

export interface MessengerChannelStatus {
  kind: string;
  registered: boolean;
  ok: boolean;
  message: string;
}

export const MESSENGER_CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
};

/**
 * `owner` is authority, not a label: that sender speaks as the CEO through a
 * chat app and can delegate work immediately. `guest` is routed like incoming
 * mail — an `inbox` task, quoted as third-party content.
 */
export type PairingRole = "owner" | "guest";

export const PAIRING_ROLE_LABEL: Record<PairingRole, string> = {
  owner: "Chef",
  guest: "Gast",
};

export type PairingStatus = "pending" | "active" | "blocked";

export const PAIRING_STATUS_LABEL: Record<PairingStatus, string> = {
  pending: "wartet auf Freigabe",
  active: "freigegeben",
  blocked: "blockiert",
};

/**
 * A row of crew_messenger_pairings, straight from the DB.
 *
 * `display_name` is chosen by whoever wrote in. It arrives flattened from the
 * server, and it is rendered as plain text only — never as markup and never as
 * a link target.
 */
export interface MessengerPairing {
  id: string;
  channel_kind: string;
  chat_id: string;
  sender_id: string;
  display_name: string;
  role: PairingRole;
  status: PairingStatus;
  pairing_code: string;
  code_expires_at: number | null;
  paired_at: number | null;
  last_seen_at: number | null;
}

export interface MessengerPollResult {
  received: number;
  handled: number;
  pairingPrompts: number;
}

// --- change proposals: an agent proposes file edits, the owner approves ----

export type ChangeProposalStatus = "pending" | "approved" | "rejected" | "applied" | "failed" | "superseded";

export const CHANGE_PROPOSAL_STATUS_LABEL: Record<ChangeProposalStatus, string> = {
  pending: "wartet auf Freigabe",
  approved: "freigegeben",
  rejected: "abgelehnt",
  applied: "angewendet",
  failed: "fehlgeschlagen",
  superseded: "überholt",
};

export type ChangeOperation = "create" | "update" | "delete";

export const CHANGE_OPERATION_LABEL: Record<ChangeOperation, string> = {
  create: "neu anlegen",
  update: "ändern",
  delete: "löschen",
};

export interface ChangeProposal {
  id: string;
  title: string;
  summary: string;
  status: ChangeProposalStatus;
  workspace_path: string;
  file_count: number;
  agent_id: string | null;
  created_at: number;
  applied_at: number | null;
}

export interface ChangeProposalFile {
  id: string;
  path: string;
  operation: ChangeOperation;
  content: string;
  expected_sha256: string;
  applied_sha256: string;
}

/** A file that could not be written, and why. Apply is all-or-nothing: one of
 *  these means the whole proposal was refused and the workspace is untouched. */
export interface ChangeApplyConflict {
  path: string;
  reason: string;
}

// --- vessels & talents: an agent is a vessel × talent pairing --------------

/** An agent that currently uses a vessel or a talent, flattened by the server
 *  so a row can name its dependants without a second round trip. */
export interface PairedAgentRef {
  id: string;
  key: string;
  display_name: string;
}

/**
 * The execution container: which runtime runs an agent, on which model, and
 * how long and how often a single run may take.
 *
 * A vessel deliberately carries no permission mode, no tool allowlist and no
 * sandbox setting. It governs the *shape* of a run — duration, repetition,
 * parallelism — never what that run is allowed to do; that stays with the
 * talent's policy. Keeping the two apart is what lets the same talent run in
 * a different vessel without quietly gaining or losing authority.
 */
export interface Vessel {
  id: string;
  company_id: string;
  key: string;
  label: string;
  runtime_provider: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
  max_concurrency: number;
  created_at: number;
  updated_at: number;
  agents: PairedAgentRef[];
}

/**
 * The capability package: role, seniority, policy, persona and skills.
 *
 * `policy_json`, `persona_json` and `skills_json` arrive as stored text. Their
 * inner shape belongs to whoever authored the talent pack, so the UI reads
 * them defensively and never assumes a schema.
 */
export interface Talent {
  id: string;
  company_id: string;
  key: string;
  professional_role: string;
  role_summary: string;
  seniority: string;
  policy_json: string;
  persona_json: string;
  skills_json: string;
  created_at: number;
  updated_at: number;
  agents: PairedAgentRef[];
}

// --- run queue: the durable intent to run a task --------------------------

/**
 * `dead` is the only status a scheduler will never move again: the attempts
 * are spent, so the request sits there until a person decides. Every other
 * status either advances on its own or is already final by choice.
 */
export type RunRequestStatus = "queued" | "running" | "done" | "failed" | "dead" | "cancelled";

export const RUN_REQUEST_STATUS_LABEL: Record<RunRequestStatus, string> = {
  queued: "wartet",
  running: "läuft",
  done: "erledigt",
  failed: "fehlgeschlagen",
  dead: "aufgegeben",
  cancelled: "abgebrochen",
};

export interface RunRequest {
  id: string;
  task_id: string;
  requested_by: string;
  status: RunRequestStatus;
  attempts: number;
  max_attempts: number;
  not_before: number | null;
  run_id: string | null;
  last_error: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  task_title: string;
}

/** What one drain pass actually did — reported back, never assumed. */
export interface RunQueueDrainResult {
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
}

// --- scheduler: the background worker that drains the queue ----------------

export interface SchedulerJob {
  name: string;
  intervalMs: number;
  running: boolean;
  runs: number;
  failures: number;
  skipped: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  lastError: string;
}

export interface SchedulerStatus {
  enabled: boolean;
  jobs: SchedulerJob[];
}

// --- tools: what this server can perform, and who may ---------------------

/**
 * `crew_tools` says what the server *can* do; `crew_tool_grants` says who
 * *may*. Registering a tool grants nothing — a fresh install can search and
 * browse, and no agent may, until someone says so.
 */
export type ToolRiskClass = "read" | "write" | "external";

/**
 * The class named by what it does to the world, not by its column value.
 * "external" tells an operator nothing; "wirkt nach außen" is the sentence
 * they have to weigh before waiving a gate.
 */
export const TOOL_RISK_CLASS_LABEL: Record<ToolRiskClass, string> = {
  read: "beobachtet nur",
  write: "ändert den Arbeitsbereich",
  external: "wirkt nach außen",
};

export type ToolOrigin = "builtin" | "mcp" | "marketplace";

/** Origins are open-ended server-side, so unknown ones fall back to the raw value. */
export const TOOL_ORIGIN_LABEL: Record<string, string> = {
  builtin: "eingebaut",
  mcp: "MCP-Server",
  marketplace: "Marktplatz",
};

/** A grant names exactly one of these — never two, never none. */
export type ToolGrantScope = "agent" | "project" | "talent";

export const TOOL_GRANT_SCOPE_LABEL: Record<ToolGrantScope, string> = {
  agent: "Agent",
  project: "Projekt",
  talent: "Talent",
};

/**
 * Which scope actually decided, when several could have.
 * Precedence is agent > project > talent: the more specific one wins, because
 * whoever wrote it meant it that way.
 */
export const TOOL_VIA_LABEL: Record<string, string> = {
  agent: "über den Agenten",
  project: "über das Projekt",
  talent: "über das Talent",
};

export interface ToolGrant {
  id: string;
  tool_id: string;
  agent_id: string | null;
  talent_id: string | null;
  project_id: string | null;
  /**
   * `null` means "whatever the risk class implies", not "nein". That is what
   * keeps an external tool gated by omission rather than by remembering.
   */
  requires_approval: number | null;
  granted_by: string;
  created_at: number;
}

export interface Tool {
  id: string;
  company_id: string;
  key: string;
  label: string;
  description: string;
  risk_class: ToolRiskClass;
  origin: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ToolWithGrants extends Tool {
  grants: ToolGrant[];
}

/** One row of `GET /agents/:id/tools`: what this post may reach for, and why. */
export interface AgentTool {
  tool: Tool;
  requiresApproval: boolean;
  via: string;
}

// --- web search -----------------------------------------------------------

export interface SearchProviderStatus {
  kind: string;
  registered: boolean;
  ok: boolean;
  message: string;
}

/**
 * A hit as the provider reported it.
 *
 * Title, snippet and URL are text a stranger wrote. The server strips control
 * tokens and drops anything without an http(s) URL, but stripped is not the
 * same as trustworthy — the UI renders all three as plain text.
 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  rank: number;
  publishedAt: number | null;
}

export interface SearchHits {
  provider: string;
  results: SearchResultItem[];
  prompt: string;
}

/** 202: the gate held. Nothing was searched; an approval is waiting. */
export interface SearchApprovalPending {
  approvalRequired: true;
  approvalId: string;
}

export type SearchOutcome = SearchHits | SearchApprovalPending;

/**
 * Identity — the three roles, kept coarse on purpose.
 *
 * Mirrors server/ironcrew/auth/user-store.ts: three roles that map to real
 * jobs beat a permission matrix nobody maintains. A viewer reads, an operator
 * runs the company, an owner decides what the company may do.
 */
export type UserRole = "owner" | "operator" | "viewer";
export type UserStatus = "active" | "disabled";

export interface CrewUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * `bootstrap` means no account exists yet, so the installation still runs on
 * the shared password and the UI should offer to create the first owner
 * rather than a login form.
 */
export interface AuthStatus {
  bootstrap: boolean;
  authenticated: boolean;
  user: CrewUser | null;
}

export interface CrewSession {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
  /** The session this request itself is using. */
  current: boolean;
}

/**
 * A business pack — what a trade adds to the company.
 *
 * `configured` on an integration is the honest half: it is true only when the
 * server registered an adapter for it at boot, which happens only when its
 * environment variables are set. A switch that is always on is the fake
 * button Phase 4 forbids.
 */
export interface PackIntegrationStatus {
  key: string;
  label: string;
  summary: string;
  configured: boolean;
  env: Array<{ name: string; optional: boolean }>;
  docsUrl: string | null;
}

export interface BusinessPackSummary {
  key: string;
  label: string;
  summary: string;
  version: string;
  installed: boolean;
  installedAt: number | null;
  installedVersion: string | null;
  counts: { departments: number; agents: number; tools: number; routines: number };
  integrations: PackIntegrationStatus[];
}

export interface PackAgentPreview {
  key: string;
  department: string;
  displayName: string;
  professionalRole: string;
  roleSummary: string;
  seniority: string;
  maxRiskLevel: string;
}

export interface PackDetail {
  pack: BusinessPackSummary;
  departments: Array<{ key: string; name: string; description: string; sort_order: number }>;
  agents: PackAgentPreview[];
  tools: Array<{ key: string; label: string; description: string; risk_class: string; integration?: string }>;
  routines: Array<{ key: string; name: string; instruction: string; interval_minutes: number }>;
}

export interface PackKeptObject {
  type: string;
  id: string;
  key: string;
  reason: string;
}
