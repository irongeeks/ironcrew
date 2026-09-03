/** Shared client-side types for the Iron Command control plane. */

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
