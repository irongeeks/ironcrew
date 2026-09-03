import { bootstrapSession, del, patch, post, put, request } from "./core";

import type {
  Agent,
  Department,
  MeetingPresence,
  OperationsAlert,
  OperationsNode,
  OperationsSession,
  Project,
  ProjectContextResponse,
  ProjectContextSections,
  ServerAllocation,
  ServerNode,
  ServerType,
  ServerTypePreset,
  Task,
  TaskStatus,
  TaskType,
  WorkflowPackKey,
} from "../types";

// Departments
export async function getDepartments(options?: {
  workflowPackKey?: WorkflowPackKey;
  includeSeed?: boolean;
}): Promise<Department[]> {
  const params = new URLSearchParams();
  if (options?.workflowPackKey) params.set("workflow_pack_key", options.workflowPackKey);
  if (options?.includeSeed) params.set("include_seed", "1");
  const query = params.toString();
  const j = await request<{ departments: Department[] }>(`/api/departments${query ? `?${query}` : ""}`);
  return j.departments;
}

export async function createDepartment(data: {
  id: string;
  name: string;
  name_ko?: string;
  name_ja?: string;
  name_zh?: string;
  icon?: string;
  color?: string;
  description?: string;
  prompt?: string;
  workflow_pack_key?: WorkflowPackKey;
}): Promise<Department> {
  const j = await request<{ department: Department }>("/api/departments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return j.department;
}

export async function updateDepartment(
  id: string,
  data: Partial<
    Pick<
      Department,
      "name" | "name_ko" | "name_ja" | "name_zh" | "icon" | "color" | "description" | "prompt" | "sort_order"
    >
  > & { workflow_pack_key?: WorkflowPackKey },
): Promise<void> {
  const params = new URLSearchParams();
  if (data.workflow_pack_key) params.set("workflow_pack_key", data.workflow_pack_key);
  const query = params.toString();
  await patch(`/api/departments/${id}${query ? `?${query}` : ""}`, data);
}

export async function deleteDepartment(id: string, options?: { workflowPackKey?: WorkflowPackKey }): Promise<void> {
  const params = new URLSearchParams();
  if (options?.workflowPackKey) params.set("workflow_pack_key", options.workflowPackKey);
  const query = params.toString();
  await del(`/api/departments/${id}${query ? `?${query}` : ""}`);
}

export async function reorderDepartments(
  orders: { id: string; sort_order: number }[],
  options?: { workflowPackKey?: WorkflowPackKey },
): Promise<void> {
  const params = new URLSearchParams();
  if (options?.workflowPackKey) params.set("workflow_pack_key", options.workflowPackKey);
  const query = params.toString();
  await patch(`/api/departments/reorder${query ? `?${query}` : ""}`, {
    orders,
    ...(options?.workflowPackKey ? { workflow_pack_key: options.workflowPackKey } : {}),
  });
}

// Agents
export async function getAgents(options?: { includeSeed?: boolean }): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (options?.includeSeed) params.set("include_seed", "1");
  const q = params.toString();
  const j = await request<{ agents: Agent[] }>(`/api/agents${q ? "?" + q : ""}`);
  return j.agents;
}

export async function getMeetingPresence(): Promise<MeetingPresence[]> {
  const j = await request<{ presence: MeetingPresence[] }>("/api/meeting-presence");
  return j.presence;
}

export async function updateAgent(
  id: string,
  data: Partial<
    Pick<
      Agent,
      | "name"
      | "name_ko"
      | "name_ja"
      | "name_zh"
      | "status"
      | "current_task_id"
      | "department_id"
      | "role"
      | "acts_as_planning_leader"
      | "cli_provider"
      | "oauth_account_id"
      | "api_provider_id"
      | "api_model"
      | "cli_model"
      | "cli_reasoning_level"
      | "cli_profile"
      | "avatar_emoji"
      | "sprite_number"
      | "allowed_server_ids"
      | "personality"
    >
  > & {
    workflow_pack_key?: WorkflowPackKey;
    force_planning_leader_override?: boolean;
  },
): Promise<void> {
  await patch(`/api/agents/${id}`, data);
}

export async function createAgent(data: {
  name: string;
  name_ko: string;
  name_ja?: string;
  name_zh?: string;
  department_id: string | null;
  role: string;
  cli_provider: string;
  cli_profile?: string | null;
  avatar_emoji: string;
  sprite_number?: number | null;
  allowed_server_ids?: string[];
  personality: string | null;
  workflow_pack_key?: WorkflowPackKey;
}): Promise<Agent> {
  const j = (await post("/api/agents", data)) as { ok: boolean; agent: Agent };
  return j.agent;
}

export async function deleteAgent(id: string): Promise<void> {
  await del(`/api/agents/${id}`);
}

export async function processSprite(imageBase64: string): Promise<{
  ok: boolean;
  previews: Record<string, string>;
  suggestedNumber: number;
}> {
  return post<{
    ok: boolean;
    previews: Record<string, string>;
    suggestedNumber: number;
  }>("/api/sprites/process", { image: imageBase64 });
}

export async function registerSprite(
  sprites: Record<string, string>,
  spriteNumber: number,
): Promise<{
  ok: boolean;
  spriteNumber: number;
  saved: string[];
}> {
  return post<{
    ok: boolean;
    spriteNumber: number;
    saved: string[];
  }>("/api/sprites/register", { sprites, spriteNumber });
}

// Servers
export async function getServers(): Promise<ServerNode[]> {
  const j = await request<{ servers: ServerNode[] }>("/api/ops/servers");
  return j.servers;
}

export async function getServer(id: string): Promise<{ server: ServerNode; allocations: ServerAllocation[] }> {
  return request(`/api/ops/servers/${encodeURIComponent(id)}`);
}

export async function getServerTypePresets(): Promise<ServerTypePreset[]> {
  const j = await request<{ presets: ServerTypePreset[] }>("/api/ops/servers/presets");
  return j.presets;
}

export async function createServer(input: {
  name: string;
  type: ServerType;
  endpoint_url?: string | null;
  auth_config_json?: string | Record<string, unknown> | null;
  ssh_config_json?: string | Record<string, unknown> | null;
  max_concurrent_jobs?: number;
  enabled?: boolean | number;
  department_id?: string | null;
}): Promise<ServerNode> {
  const j = await post<{ ok: boolean; server: ServerNode }>("/api/ops/servers", input);
  return j.server;
}

export async function updateServer(
  id: string,
  patchData: Partial<{
    name: string;
    type: ServerType;
    endpoint_url: string | null;
    auth_config_json: string | Record<string, unknown> | null;
    ssh_config_json: string | Record<string, unknown> | null;
    max_concurrent_jobs: number;
    enabled: boolean | number;
    department_id: string | null;
    status: "online" | "offline" | "busy" | "idle";
    metadata_json: string | Record<string, unknown> | null;
  }>,
): Promise<ServerNode> {
  const j = await patch<{ ok: boolean; server: ServerNode }>(`/api/ops/servers/${encodeURIComponent(id)}`, patchData);
  return j.server;
}

export async function deleteServer(id: string): Promise<void> {
  await del(`/api/ops/servers/${encodeURIComponent(id)}`);
}

export async function runServerHealthCheck(id?: string): Promise<void> {
  if (id) {
    await post(`/api/ops/servers/${encodeURIComponent(id)}/health-check`);
    return;
  }
  await post("/api/ops/servers/health-check");
}

export async function getServerAllocations(status?: "queued" | "active" | "released"): Promise<ServerAllocation[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  const j = await request<{ allocations: ServerAllocation[] }>(`/api/ops/servers/allocations${q}`);
  return j.allocations;
}

// Operations center
export async function getOperationsSessions(): Promise<OperationsSession[]> {
  const j = await request<{ sessions: OperationsSession[] }>("/api/operations/sessions");
  return j.sessions;
}

export async function getOperationsNodes(): Promise<OperationsNode[]> {
  const j = await request<{ nodes: OperationsNode[] }>("/api/operations/nodes");
  return j.nodes;
}

export async function getOperationsAlerts(): Promise<OperationsAlert[]> {
  const j = await request<{ alerts: OperationsAlert[] }>("/api/operations/alerts");
  return j.alerts;
}

export async function killOperationTask(taskId: string): Promise<void> {
  await post(`/api/operations/tasks/${encodeURIComponent(taskId)}/kill`);
}

export async function drainOperationNode(nodeId: string): Promise<void> {
  await post(`/api/operations/nodes/${encodeURIComponent(nodeId)}/drain`);
}

// Tasks
export async function getTasks(filters?: {
  status?: TaskStatus;
  department_id?: string;
  agent_id?: string;
  project_id?: string;
  workflow_pack_key?: WorkflowPackKey;
}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.department_id) params.set("department_id", filters.department_id);
  if (filters?.agent_id) params.set("agent_id", filters.agent_id);
  if (filters?.project_id) params.set("project_id", filters.project_id);
  if (filters?.workflow_pack_key) params.set("workflow_pack_key", filters.workflow_pack_key);
  const q = params.toString();
  const j = await request<{ tasks: Task[] }>(`/api/tasks${q ? "?" + q : ""}`);
  return j.tasks;
}

export async function createTask(input: {
  title: string;
  description?: string;
  department_id?: string;
  task_type?: TaskType;
  priority?: number;
  project_id?: string;
  project_path?: string;
  assigned_agent_id?: string;
  workflow_pack_key?: WorkflowPackKey;
  workflow_meta_json?: Record<string, unknown> | string;
  output_format?: string;
  skipped_phases?: string[];
}): Promise<string> {
  const j = (await post("/api/tasks", input)) as { id: string };
  return j.id;
}

export async function updateTask(
  id: string,
  data: Partial<
    Pick<
      Task,
      | "title"
      | "description"
      | "status"
      | "priority"
      | "task_type"
      | "department_id"
      | "project_id"
      | "project_path"
      | "workflow_pack_key"
      | "workflow_meta_json"
      | "output_format"
      | "hidden"
    >
  >,
): Promise<void> {
  await patch(`/api/tasks/${id}`, data);
}

export async function bulkHideTasks(statuses: string[], hidden: 0 | 1): Promise<void> {
  await post("/api/tasks/bulk-hide", { statuses, hidden });
}

export async function deleteTask(id: string): Promise<void> {
  await del(`/api/tasks/${id}`);
}

export async function assignTask(id: string, agentId: string): Promise<void> {
  await post(`/api/tasks/${id}/assign`, { agent_id: agentId });
}

export async function runTask(id: string): Promise<void> {
  await post(`/api/tasks/${id}/run`);
}

export async function stopTask(id: string): Promise<void> {
  await post(`/api/tasks/${id}/stop`, { mode: "cancel" });
}

export async function pauseTask(id: string): Promise<{
  ok: boolean;
  stopped: boolean;
  status: string;
  pid?: number;
  rolled_back?: boolean;
  message?: string;
  interrupt?: {
    session_id: string;
    control_token: string;
    requires_csrf: boolean;
  } | null;
}> {
  await bootstrapSession({ promptOnUnauthorized: false });
  return post(`/api/tasks/${id}/stop`, { mode: "pause" });
}

export async function resumeTask(id: string): Promise<void> {
  await bootstrapSession({ promptOnUnauthorized: false });
  await post(`/api/tasks/${id}/resume`);
}

export async function injectTaskPrompt(
  id: string,
  input: {
    session_id: string;
    interrupt_token: string;
    prompt: string;
  },
): Promise<{ ok: boolean; queued: boolean; session_id: string; prompt_hash: string; pending_count: number }> {
  await bootstrapSession({ promptOnUnauthorized: false });
  return post(`/api/tasks/${id}/inject`, input);
}

// Projects
export interface ProjectTaskHistoryItem {
  id: string;
  title: string;
  status: string;
  task_type: string;
  priority: number;
  source_task_id?: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string;
  assigned_agent_name_ko: string;
}

export interface ProjectReportHistoryItem {
  id: string;
  title: string;
  completed_at: number | null;
  created_at: number;
  assigned_agent_id: string | null;
  agent_name: string;
  agent_name_ko: string;
  dept_name: string;
  dept_name_ko: string;
}

export interface ProjectDecisionEventItem {
  id: number;
  snapshot_hash: string | null;
  event_type:
    | "planning_summary"
    | "representative_pick"
    | "followup_request"
    | "start_review_meeting"
    | "start_review_meeting_blocked";
  summary: string;
  selected_options_json: string | null;
  note: string | null;
  task_id: string | null;
  meeting_id: string | null;
  created_at: number;
}

export interface ProjectDetailResponse {
  project: Project;
  assigned_agents?: Agent[];
  tasks: ProjectTaskHistoryItem[];
  reports: ProjectReportHistoryItem[];
  decision_events: ProjectDecisionEventItem[];
}

export async function getProjects(params?: { page?: number; page_size?: number; search?: string }): Promise<{
  projects: Project[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}> {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.page_size) sp.set("page_size", String(params.page_size));
  if (params?.search) sp.set("search", params.search);
  const q = sp.toString();
  return request(`/api/projects${q ? `?${q}` : ""}`);
}

export async function createProject(input: {
  name: string;
  project_path: string;
  core_goal: string;
  default_pack_key?: WorkflowPackKey;
  create_path_if_missing?: boolean;
  github_repo?: string;
  assignment_mode?: "auto" | "manual";
  agent_ids?: string[];
  remote_server_id?: string | null;
  remote_path?: string | null;
}): Promise<Project> {
  const j = (await post("/api/projects", input)) as { ok: boolean; project: Project };
  return j.project;
}

export async function updateProject(
  id: string,
  patchData: Partial<Pick<Project, "name" | "project_path" | "core_goal" | "default_pack_key">> & {
    create_path_if_missing?: boolean;
    github_repo?: string | null;
    assignment_mode?: "auto" | "manual";
    agent_ids?: string[];
    remote_server_id?: string | null;
    remote_path?: string | null;
  },
): Promise<Project> {
  const j = (await patch(`/api/projects/${id}`, patchData)) as { ok: boolean; project: Project };
  return j.project;
}

export interface ProjectPathCheckResult {
  normalized_path: string;
  exists: boolean;
  is_directory: boolean;
  can_create: boolean;
  nearest_existing_parent: string | null;
}

export interface ProjectPathBrowseEntry {
  name: string;
  path: string;
}

export interface ProjectPathBrowseResult {
  current_path: string;
  parent_path: string | null;
  entries: ProjectPathBrowseEntry[];
  truncated: boolean;
}

export async function checkProjectPath(pathInput: string): Promise<ProjectPathCheckResult> {
  const sp = new URLSearchParams();
  sp.set("path", pathInput);
  const j = await request<{ ok: boolean } & ProjectPathCheckResult>(`/api/projects/path-check?${sp.toString()}`);
  return {
    normalized_path: j.normalized_path,
    exists: j.exists,
    is_directory: j.is_directory,
    can_create: j.can_create,
    nearest_existing_parent: j.nearest_existing_parent,
  };
}

export async function getProjectPathSuggestions(query: string, limit = 30): Promise<string[]> {
  const sp = new URLSearchParams();
  if (query.trim()) sp.set("q", query.trim());
  sp.set("limit", String(limit));
  const j = await request<{ ok: boolean; paths: string[] }>(`/api/projects/path-suggestions?${sp.toString()}`);
  return j.paths ?? [];
}

export async function browseProjectPath(pathInput?: string): Promise<ProjectPathBrowseResult> {
  const sp = new URLSearchParams();
  if (pathInput && pathInput.trim()) sp.set("path", pathInput.trim());
  const q = sp.toString();
  const j = await request<{
    ok: boolean;
    current_path: string;
    parent_path: string | null;
    entries: ProjectPathBrowseEntry[];
    truncated: boolean;
  }>(`/api/projects/path-browse${q ? `?${q}` : ""}`);
  return {
    current_path: j.current_path,
    parent_path: j.parent_path,
    entries: j.entries ?? [],
    truncated: Boolean(j.truncated),
  };
}

export async function pickProjectPathNative(): Promise<{ cancelled: boolean; path: string | null }> {
  const j = await request<{
    ok: boolean;
    cancelled?: boolean;
    path?: string;
  }>("/api/projects/path-native-picker", { method: "POST" });
  if (!j.ok) {
    return { cancelled: Boolean(j.cancelled), path: null };
  }
  return { cancelled: false, path: j.path ?? null };
}

export async function deleteProject(id: string): Promise<void> {
  await del(`/api/projects/${id}`);
}

export async function getProjectDetail(id: string): Promise<ProjectDetailResponse> {
  return request(`/api/projects/${id}`);
}

// Project context
export async function getProjectContext(projectId: string): Promise<ProjectContextResponse> {
  return request(`/api/projects/${projectId}/context`);
}

export async function updateProjectContext(
  projectId: string,
  title: string,
  sections: ProjectContextSections,
): Promise<{ ok: boolean }> {
  return put(`/api/projects/${projectId}/context`, { title, sections });
}

export async function initProjectContext(
  projectId: string,
  options: { useLlm?: boolean } = {},
): Promise<{ sections: ProjectContextSections; raw: string; used_llm: boolean }> {
  return post(`/api/projects/${projectId}/init-context`, { use_llm: options.useLlm === true });
}
