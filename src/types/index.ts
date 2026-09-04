import type { UiLanguage } from "../i18n";

export type { UiLanguage };

// Department
export interface Department {
  id: string;
  name: string;
  name_ko: string;
  name_ja?: string | null;
  name_zh?: string | null;
  icon: string;
  color: string;
  description: string | null;
  prompt: string | null;
  sort_order: number;
  created_at: number;
  agent_count?: number;
}

// Agent roles
export type AgentRole = "team_leader" | "senior" | "junior" | "intern";
export type AgentStatus = "idle" | "working" | "break" | "offline";
export type CliProvider = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "antigravity" | "api" | "openclaw";
export type MeetingReviewDecision = "reviewing" | "approved" | "hold";

export interface Agent {
  id: string;
  name: string;
  name_ko: string;
  name_ja?: string | null;
  name_zh?: string | null;
  department_id: string | null;
  department?: Department;
  role: AgentRole;
  acts_as_planning_leader?: number | null;
  cli_provider: CliProvider;
  oauth_account_id?: string | null;
  api_provider_id?: string | null;
  api_model?: string | null;
  cli_model?: string | null;
  cli_reasoning_level?: string | null;
  cli_profile?: string | null;
  avatar_emoji: string;
  sprite_number?: number | null;
  allowed_server_ids?: string[];
  personality: string | null;
  status: AgentStatus;
  current_task_id: string | null;
  created_at: number;
}

export interface MeetingPresence {
  agent_id: string;
  seat_index: number;
  phase: "kickoff" | "review";
  task_id: string | null;
  decision?: MeetingReviewDecision | null;
  until: number;
}

export interface SubAgent {
  id: string;
  parentAgentId: string;
  task: string;
  status: "working" | "done";
}

export interface CrossDeptDelivery {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  taskId?: string | null;
  taskTitle?: string | null;
  chainId?: string | null;
  chainStepIndex?: number | null;
  chainStepTotal?: number | null;
  batonLabel?: string | null;
}

export interface CeoOfficeCall {
  id: string;
  fromAgentId: string;
  seatIndex: number;
  phase: "kickoff" | "review";
  action?: "arrive" | "speak" | "dismiss";
  line?: string;
  decision?: MeetingReviewDecision;
  taskId?: string;
  instant?: boolean;
  holdUntil?: number;
}

export type ServerType = "comfyui" | "llm_api" | "database" | "file_storage" | "ssh_remote";
export type ServerStatus = "online" | "offline" | "busy" | "idle";
export type ServerAllocationStatus = "queued" | "active" | "released";

export interface ServerNode {
  id: string;
  name: string;
  type: ServerType;
  endpoint_url: string | null;
  auth_config_json?: string | null;
  ssh_config_json?: string | null;
  max_concurrent_jobs: number;
  current_jobs: number;
  status: ServerStatus;
  enabled: number;
  department_id: string | null;
  metadata_json?: string | null;
  last_health_check_at: number | null;
  last_health_error: string | null;
  created_at: number;
  updated_at: number;
  active_allocations?: number;
  queued_allocations?: number;
}

export interface ServerAllocation {
  id: string;
  server_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  requested_server_type: ServerType;
  status: ServerAllocationStatus;
  queue_reason: string | null;
  released_reason: string | null;
  requested_at: number;
  started_at: number | null;
  released_at: number | null;
  server_name?: string | null;
  server_type?: ServerType | null;
  agent_name?: string | null;
  agent_name_ko?: string | null;
  task_title?: string | null;
}

export interface OperationsSession {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  started_at: number | null;
  updated_at: number;
  assigned_agent_id: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  department_id: string | null;
  department_name: string | null;
  department_icon: string | null;
  subtask_total: number;
  subtask_in_progress: number;
  subtask_done: number;
  active_allocations: number;
  running: boolean;
}

export interface OperationsNode {
  id: string;
  name: string;
  type: ServerType;
  status: ServerStatus;
  enabled: number;
  current_jobs: number;
  max_concurrent_jobs: number;
  endpoint_url: string | null;
  last_health_check_at: number | null;
  last_health_error: string | null;
  active_allocations: number;
  queued_allocations: number;
}

export type OperationsAlertLevel = "critical" | "warning" | "info";
export type OperationsAlertSource = "task" | "subtask" | "node" | "allocation";

export interface OperationsAlert {
  id: string;
  level: OperationsAlertLevel;
  source: OperationsAlertSource;
  title: string;
  detail: string;
  entity_id: string;
  created_at: number;
}

export interface ServerTypePreset {
  type: ServerType;
  label: string;
  description: string;
  examples: string[];
}

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  private_key_path: string;
  known_hosts_policy: "accept" | "strict";
  allowed_commands?: string[];
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
  permissions: string;
}

export interface RemoteFileStat {
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
  permissions: string;
  owner: string;
  group: string;
}

// Task
export type TaskStatus =
  | "inbox"
  | "planned"
  | "collaborating"
  | "in_progress"
  | "review"
  | "done"
  | "pending"
  | "cancelled";
export type TaskType =
  | "general"
  | "development"
  | "design"
  | "analysis"
  | "presentation"
  | "documentation"
  | "create_mockup"
  | "design_system_update"
  | "color_palette_generate"
  | "typography_review";
const BUILT_IN_PACK_KEYS = ["development", "design_studio", "video_preprod", "web_research_report"] as const;

export type BuiltInPackKey = (typeof BUILT_IN_PACK_KEYS)[number];
export type WorkflowPackKey = string;

// Keep backward-compat alias
export const WORKFLOW_PACK_KEYS = BUILT_IN_PACK_KEYS;

export interface PackRegistryEntry {
  key: string;
  source: "built-in" | "community";
  version: string;
  name: Record<string, string>;
  description: Record<string, string>;
  phases: Array<{ id: string; department: string }>;
  staff: {
    name_pool: Array<{ name: Record<string, string>; role: string; department: string }>;
    room_theme?: Record<string, { floor1?: number; floor2?: number; wall?: number; accent?: number }> | null;
  } | null;
  ui: {
    slug: string;
    label: Record<string, string>;
    summary: Record<string, string>;
    departments: Record<
      string,
      {
        name?: Record<string, string>;
        icon?: string;
        color?: string;
        agent_prefix?: Record<string, string>;
        avatar_pool?: string[];
      }
    >;
    room_themes: Record<string, { floor1?: number; floor2?: number; wall?: number; accent?: number }>;
    staff_cycle: string[];
  };
  enabled: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  department_id: string | null;
  assigned_agent_id: string | null;
  assigned_agent?: Agent;
  agent_name?: string | null;
  agent_name_ko?: string | null;
  agent_avatar?: string | null;
  project_id?: string | null;
  status: TaskStatus;
  priority: number;
  task_type: TaskType;
  workflow_pack_key?: WorkflowPackKey;
  workflow_meta_json?: string | null;
  output_format?: string | null;
  project_path: string | null;
  result: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  source_task_id?: string | null;
  subtask_total?: number;
  subtask_done?: number;
  hidden?: number;
  skipped_phases?: string | null;
  agent_routing?: "single" | "department" | null;
}

export type AssignmentMode = "auto" | "manual";

export interface ProjectContextSections {
  overview: string;
  architecture: string;
  conventions: string;
  decisions: string;
  status: string;
}

export interface ProjectContextResponse {
  raw: string;
  sections: ProjectContextSections;
  charLimits: Record<string, number>;
  charCounts?: Record<string, number>;
  exists: boolean;
}

export interface Project {
  id: string;
  name: string;
  project_path: string;
  core_goal: string;
  default_pack_key?: WorkflowPackKey;
  assignment_mode: AssignmentMode;
  assigned_agent_ids?: string[];
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  github_repo?: string | null;
  remote_server_id?: string | null;
  remote_path?: string | null;
}

export interface TaskLog {
  id: number;
  task_id: string;
  kind: string;
  message: string;
  created_at: number;
}

export interface MeetingMinuteEntry {
  id: number;
  meeting_id: string;
  seq: number;
  speaker_agent_id: string | null;
  speaker_name: string;
  department_name: string | null;
  role_label: string | null;
  message_type: string;
  content: string;
  created_at: number;
}

export interface MeetingMinute {
  id: string;
  task_id: string;
  meeting_type: "planned" | "review";
  round: number;
  title: string;
  status: "in_progress" | "completed" | "revision_requested" | "failed";
  started_at: number;
  completed_at: number | null;
  created_at: number;
  entries: MeetingMinuteEntry[];
}

// Messages
export type SenderType = "ceo" | "agent" | "system";
export type ReceiverType = "agent" | "department" | "all";
export type MessageType = "chat" | "task_assign" | "announcement" | "directive" | "report" | "status_update";

export interface Message {
  id: string;
  sender_type: SenderType;
  sender_id: string | null;
  sender_agent?: Agent;
  sender_name?: string | null;
  sender_avatar?: string | null;
  receiver_type: ReceiverType;
  receiver_id: string | null;
  content: string;
  message_type: MessageType;
  task_id: string | null;
  created_at: number;
}

// CLI Status
export interface CliToolStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authHint: string;
}

export type CliStatusMap = Record<CliProvider, CliToolStatus>;

export type CliAuthProvider = "claude" | "codex" | "gemini";

export interface CliAuthStartResult {
  sessionId: string;
  verificationUrl: string | null;
  deviceCode: string | null;
  rawOutput: string;
}

export interface CliAuthStatusResult {
  status: "pending" | "success" | "failed" | "timeout";
  authenticated: boolean;
  error: string | null;
}

// Company Stats (matches server GET /api/stats response)
export interface CompanyStats {
  tasks: {
    total: number;
    done: number;
    in_progress: number;
    inbox: number;
    planned: number;
    collaborating: number;
    review: number;
    cancelled: number;
    completion_rate: number;
  };
  agents: {
    total: number;
    working: number;
    idle: number;
  };
  tasks_by_department: Array<{
    id: string;
    name: string;
    icon: string;
    color: string;
    total_tasks: number;
    done_tasks: number;
  }>;
  recent_activity: Array<Record<string, unknown>>;
}

// SubTask
export type SubTaskStatus = "pending" | "in_progress" | "done" | "blocked" | "awaiting_approval" | "skipped";

export interface SubTask {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: SubTaskStatus;
  assigned_agent_id: string | null;
  blocked_reason: string | null;
  cli_tool_use_id: string | null;
  target_department_id?: string | null;
  delegated_task_id?: string | null;
  created_at: number;
  completed_at: number | null;
}

// WebSocket Events
export type WSEventType =
  | "task_update"
  | "agent_status"
  | "agent_created"
  | "agent_deleted"
  | "departments_changed"
  | "new_message"
  | "announcement"
  | "cli_output"
  | "cli_usage_update"
  | "subtask_update"
  | "cross_dept_delivery"
  | "ceo_office_call"
  | "chat_stream"
  | "task_report"
  | "server_update"
  | "autonomous_action"
  | "connected"
  | "clone_progress"
  | "cli_auth_warning"
  | "messages_cleared"
  | "scheduled_task_updated"
  | "task_interrupt"
  | "tasks_changed"
  | "token_budget_warning";

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
}

// CLI Model info (rich model data from providers like Codex)
export interface ReasoningLevelOption {
  effort: string; // "low" | "medium" | "high" | "xhigh"
  description: string;
}

export interface CliModelInfo {
  slug: string;
  displayName?: string;
  description?: string;
  reasoningLevels?: ReasoningLevelOption[];
  defaultReasoningLevel?: string;
}

export type CliModelsResponse = Record<string, CliModelInfo[]>;

// Settings
export interface ProviderModelConfig {
  model: string;
  subModel?: string; // Sub-agent model (claude, codex only)
  reasoningLevel?: string; // Codex: "low"|"medium"|"high"|"xhigh"
  subModelReasoningLevel?: string; // Sub-agent reasoning level (codex only)
}

export interface RoomTheme {
  floor1: number;
  floor2: number;
  wall: number;
  accent: number;
}

export const MESSENGER_CHANNELS = [
  "telegram",
  "whatsapp",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

export type MessengerChannelType = (typeof MESSENGER_CHANNELS)[number];

export interface MessengerSessionConfig {
  id: string;
  name: string;
  targetId: string;
  enabled: boolean;
  token?: string;
  agentId?: string;
  workflowPackKey?: WorkflowPackKey;
}

export interface MessengerChannelConfig {
  token: string;
  sessions: MessengerSessionConfig[];
  receiveEnabled?: boolean;
}

export type MessengerChannelsConfig = Record<MessengerChannelType, MessengerChannelConfig>;

export interface OfficePackProfile {
  departments: Department[];
  agents: Agent[];
  updated_at: number;
}

export type OfficePackProfiles = Partial<Record<WorkflowPackKey, OfficePackProfile>>;
export type DepartmentRoomAssignments = Record<string, number>;
export type OfficePackDepartmentRoomAssignments = Partial<Record<WorkflowPackKey, DepartmentRoomAssignments>>;

export interface CompanySettings {
  companyName: string;
  ceoName: string;
  autoAssign: boolean;
  yoloMode?: boolean;
  autoUpdateEnabled: boolean;
  autoUpdateNoticePending?: boolean;
  oauthAutoSwap?: boolean;
  theme: "dark" | "light";
  language: UiLanguage;
  defaultProvider: CliProvider;
  officeWorkflowPack?: WorkflowPackKey;
  defaultProjectPath?: string;
  apiRequestTimeoutMs?: number;
  taskExecutionTimeoutMs?: number;
  autoUpdateCheckIntervalMin?: number;
  providerModelConfig?: Record<string, ProviderModelConfig>;
  roomThemes?: Record<string, RoomTheme>;
  messengerChannels?: MessengerChannelsConfig;
  officePackProfiles?: OfficePackProfiles;
  officePackHydratedPacks?: string[];
  departmentRoomAssignments?: OfficePackDepartmentRoomAssignments;
  knowledgeAutoBindDefault?: boolean;
  autonomousMode?: boolean;
  autonomousMaxConcurrent?: number;
  ceoOrchestratorEnabled?: boolean;
  ceoOrchestratorIntervalMs?: number;
  ceoOrchestratorModel?: string;
}

export type AutonomousActionEvent = {
  action: "task_scheduled" | "task_chained" | "ceo_decision" | "scheduler_skip" | "scheduled_task_fired";
  task_id?: string;
  task_title?: string;
  agent_id?: string;
  agent_name?: string;
  reason: string;
  timestamp: number;
};

export const DEFAULT_SETTINGS: CompanySettings = {
  companyName: "IronCrew",
  ceoName: "CEO",
  autoAssign: true,
  yoloMode: false,
  autoUpdateEnabled: false,
  autoUpdateNoticePending: false,
  oauthAutoSwap: true,
  theme: "dark",
  language: "en",
  defaultProvider: "claude",
  officeWorkflowPack: "development",
  defaultProjectPath: "",
  apiRequestTimeoutMs: 30000,
  taskExecutionTimeoutMs: 3600000,
  autoUpdateCheckIntervalMin: 10,
  providerModelConfig: {
    claude: { model: "claude-sonnet-4-6", subModel: "claude-opus-4-6" },
    codex: {
      model: "gpt-5.3-codex",
      reasoningLevel: "xhigh",
      subModel: "gpt-5.3-codex",
      subModelReasoningLevel: "high",
    },
    gemini: { model: "gemini-3-pro-preview" },
    opencode: { model: "github-copilot/claude-sonnet-4.6" },
    copilot: { model: "github-copilot/claude-sonnet-4.6" },
    antigravity: { model: "google/antigravity-gemini-3-pro" },
  },
  messengerChannels: {
    telegram: { token: "", sessions: [], receiveEnabled: true },
    whatsapp: { token: "", sessions: [], receiveEnabled: false },
    discord: { token: "", sessions: [], receiveEnabled: false },
    googlechat: { token: "", sessions: [], receiveEnabled: false },
    slack: { token: "", sessions: [], receiveEnabled: false },
    signal: { token: "", sessions: [], receiveEnabled: false },
    imessage: { token: "", sessions: [], receiveEnabled: false },
  },
  officePackProfiles: {},
  departmentRoomAssignments: {},
  autonomousMode: false,
  autonomousMaxConcurrent: 2,
  ceoOrchestratorEnabled: false,
  ceoOrchestratorIntervalMs: 120000,
  ceoOrchestratorModel: "",
};
