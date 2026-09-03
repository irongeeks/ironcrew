/**
 * Typed client for the IronCrew REST surface.
 *
 * Built on the shared `src/api/core.ts` transport rather than raw fetch, so it
 * inherits session bootstrap, the `x-csrf-token` header on mutating requests,
 * and the re-auth retry. A hand-rolled fetch here would be silently rejected
 * by the CSRF middleware on every POST — which is exactly what happened before
 * the E2E test caught it.
 */

import { request } from "../api/core";
import type {
  Agent,
  Approval,
  Attachment,
  Dashboard,
  Decision,
  Department,
  Goal,
  GoalStatus,
  KnownHostsPolicy,
  Meeting,
  MeetingActionItem,
  MeetingParticipant,
  MeetingStatus,
  MeetingTurn,
  MemoryKind,
  MemoryProviderStatus,
  MemoryRef,
  MemorySearchHit,
  Message,
  Milestone,
  Notification,
  Project,
  ProjectStatus,
  RemoteWorker,
  RunEvent,
  RuntimeInfo,
  Secret,
  SecretProviderKind,
  SecretProviderStatus,
  TailscaleInfo,
  Task,
} from "./types.ts";

const BASE = "/api/crew";

function get<T>(path: string): Promise<T> {
  return request<T>(`${BASE}${path}`);
}

function send<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return request<T>(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  company: () => get<{ company: { name: string }; departments: Department[] }>("/company"),
  agents: () => get<{ agents: Agent[] }>("/agents"),
  chat: () => get<{ conversationId: string; messages: Message[] }>("/chat"),
  sendMessage: (body: string) =>
    send<{ reply: string; task: Task | null; assignedAgent: Agent | null }>("/chat", "POST", { body }),
  tasks: () => get<{ tasks: Task[] }>("/tasks"),
  task: (id: string) =>
    get<{ task: Task; runs: unknown[]; audit: unknown[]; blockers: Task[]; blocking: Task[] }>(`/tasks/${id}`),
  executeNext: () => send<{ executed: boolean; task?: Task; runId?: string }>("/tasks/execute-next", "POST"),
  accept: (id: string, note?: string) => send<{ task: Task }>(`/tasks/${id}/accept`, "POST", { note }),
  revise: (id: string, reason: string) => send<{ task: Task }>(`/tasks/${id}/revise`, "POST", { reason }),
  setTaskStatus: (id: string, status: Task["status"], reason?: string) =>
    send<{ task: Task }>(`/tasks/${id}/status`, "POST", { status, reason }),
  addDependency: (taskId: string, dependsOnId: string) =>
    send<{ blockers: Task[] }>(`/tasks/${taskId}/dependencies`, "POST", { dependsOnId }),
  removeDependency: (taskId: string, dependsOnId: string) =>
    send<{ blockers: Task[] }>(`/tasks/${taskId}/dependencies/${dependsOnId}`, "DELETE"),
  approvals: () => get<{ approvals: Approval[] }>("/approvals"),
  decide: (id: string, decision: "approved" | "rejected", reason?: string) =>
    send<{ approval: Approval }>(`/approvals/${id}/decide`, "POST", { decision, reason }),
  dashboard: () => get<Dashboard>("/dashboard"),
  runEvents: (runId: string) => get<{ events: RunEvent[] }>(`/runs/${runId}/events`),
  runtimes: () => get<{ runtimes: RuntimeInfo[] }>("/runtimes"),
  setAgentRuntime: (agentId: string, runtimeProvider: string) =>
    send<{ agent: Agent }>(`/agents/${agentId}/runtime`, "PATCH", { runtimeProvider }),

  goals: () => get<{ goals: Goal[] }>("/goals"),
  goal: (id: string) => get<{ goal: Goal; ancestry: Goal[]; children: Goal[] }>(`/goals/${id}`),
  createGoal: (input: { title: string; description?: string; parentId?: string | null }) =>
    send<{ goal: Goal }>("/goals", "POST", input),
  setGoalStatus: (id: string, status: GoalStatus) => send<{ goal: Goal }>(`/goals/${id}/status`, "POST", { status }),

  projects: () => get<{ projects: Project[] }>("/projects"),
  project: (id: string) => get<{ project: Project; milestones: Milestone[]; tasks: Task[] }>(`/projects/${id}`),
  createProject: (input: { title: string; key?: string; summary?: string; goalId?: string | null }) =>
    send<{ project: Project }>("/projects", "POST", input),
  setProjectStatus: (id: string, status: ProjectStatus) =>
    send<{ project: Project }>(`/projects/${id}/status`, "POST", { status }),
  addMilestone: (projectId: string, input: { title: string; description?: string; dueAt?: number | null }) =>
    send<{ milestone: Milestone }>(`/projects/${projectId}/milestones`, "POST", input),
  setMilestoneStatus: (id: string, status: Milestone["status"]) =>
    send<{ milestone: Milestone }>(`/milestones/${id}/status`, "POST", { status }),

  notifications: (unreadOnly = false) =>
    get<{ notifications: Notification[]; unreadCount: number }>(`/notifications${unreadOnly ? "?unread=true" : ""}`),
  markNotificationRead: (id: string) => send<{ notification: Notification }>(`/notifications/${id}/read`, "POST"),
  decisions: () => get<{ decisions: Decision[] }>("/decisions"),

  secretProviders: () => get<{ providers: SecretProviderStatus[] }>("/secret-providers"),
  secrets: () => get<{ secrets: Secret[] }>("/secrets"),
  createSecret: (input: {
    name: string;
    provider: SecretProviderKind;
    itemRef: string;
    field?: string;
    description?: string;
  }) => send<{ secret: Secret }>("/secrets", "POST", input),
  deleteSecret: (id: string) => send<{ ok: boolean }>(`/secrets/${id}`, "DELETE"),
  testSecret: (id: string) => send<{ ok: boolean; length?: number; message?: string }>(`/secrets/${id}/test`, "POST"),

  attachmentsForTask: (taskId: string) => get<{ attachments: Attachment[] }>(`/attachments?taskId=${taskId}`),
  attachmentsForProject: (projectId: string) =>
    get<{ attachments: Attachment[] }>(`/attachments?projectId=${projectId}`),
  attachmentsGeneral: () => get<{ attachments: Attachment[] }>("/attachments"),
  uploadAttachment: (input: {
    filename: string;
    contentType?: string;
    dataBase64: string;
    taskId?: string;
    projectId?: string;
  }) => send<{ attachment: Attachment }>("/attachments", "POST", input),
  deleteAttachment: (id: string) => send<{ ok: boolean }>(`/attachments/${id}`, "DELETE"),
  attachmentDownloadUrl: (id: string) => `${BASE}/attachments/${id}/download`,

  tailscale: () => get<TailscaleInfo>("/tailscale"),
  remoteWorkers: () => get<{ remoteWorkers: RemoteWorker[] }>("/remote-workers"),
  createRemoteWorker: (input: {
    label: string;
    environment?: string;
    host: string;
    port?: number;
    sshUser: string;
    privateKeyPath: string;
    knownHostsPolicy?: KnownHostsPolicy;
    notes?: string;
  }) => send<{ remoteWorker: RemoteWorker }>("/remote-workers", "POST", input),
  deleteRemoteWorker: (id: string) => send<{ ok: boolean }>(`/remote-workers/${id}`, "DELETE"),
  testRemoteWorker: (id: string) => send<{ ok: boolean; message: string }>(`/remote-workers/${id}/test`, "POST"),

  meetings: (status?: MeetingStatus) => get<{ meetings: Meeting[] }>(`/meetings${status ? `?status=${status}` : ""}`),
  meeting: (id: string) =>
    get<{
      meeting: Meeting;
      participants: MeetingParticipant[];
      turns: MeetingTurn[];
      actionItems: MeetingActionItem[];
    }>(`/meetings/${id}`),
  createMeeting: (input: {
    topic: string;
    moderatorAgentId: string;
    participantAgentIds: string[];
    projectId?: string | null;
    maxRounds?: number;
    budgetMicros?: number;
  }) => send<{ meeting: Meeting }>("/meetings", "POST", input),
  startMeeting: (id: string) => send<{ meeting: Meeting }>(`/meetings/${id}/start`, "POST"),
  nextMeetingTurn: (id: string, agentId?: string) =>
    send<{ meeting: Meeting; turn: MeetingTurn | null }>(`/meetings/${id}/next-turn`, "POST", { agentId }),
  endMeeting: (id: string, minutes?: string) => send<{ meeting: Meeting }>(`/meetings/${id}/end`, "POST", { minutes }),
  cancelMeeting: (id: string) => send<{ meeting: Meeting }>(`/meetings/${id}/cancel`, "POST"),
  addMeetingActionItem: (id: string, input: { description: string; assignedAgentId?: string | null }) =>
    send<{ actionItem: MeetingActionItem }>(`/meetings/${id}/action-items`, "POST", input),
  convertActionItemToTask: (actionItemId: string) =>
    send<{ task: Task }>(`/meetings/action-items/${actionItemId}/convert`, "POST"),

  memoryProviders: () => get<{ providers: MemoryProviderStatus[] }>("/memory-providers"),
  memories: () => get<{ memories: MemoryRef[] }>("/memory"),
  recordMemory: (input: {
    provider: string;
    kind: MemoryKind;
    title: string;
    content: string;
    tags?: string[];
    taskId?: string | null;
    projectId?: string | null;
    agentId?: string | null;
    source?: string;
    confidence?: number;
    sensitivity?: string;
  }) => send<{ memory: MemoryRef }>("/memory", "POST", input),
  memoryContent: (id: string) => get<{ memory: MemoryRef; content: string }>(`/memory/${id}`),
  deleteMemory: (id: string) => send<{ ok: boolean }>(`/memory/${id}`, "DELETE"),
  searchMemory: (provider: string, query: string) =>
    get<{ hits: MemorySearchHit[] }>(
      `/memory/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`,
    ),
};
