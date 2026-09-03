/**
 * Typed client for the Iron Command REST surface.
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
  Dashboard,
  Department,
  Goal,
  GoalStatus,
  Message,
  Milestone,
  Project,
  ProjectStatus,
  RunEvent,
  RuntimeInfo,
  Task,
} from "./types.ts";

const BASE = "/api/ic";

function get<T>(path: string): Promise<T> {
  return request<T>(`${BASE}${path}`);
}

function send<T>(path: string, method: "POST" | "PUT" | "PATCH", body?: unknown): Promise<T> {
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
  task: (id: string) => get<{ task: Task; runs: unknown[]; audit: unknown[] }>(`/tasks/${id}`),
  executeNext: () => send<{ executed: boolean; task?: Task; runId?: string }>("/tasks/execute-next", "POST"),
  accept: (id: string, note?: string) => send<{ task: Task }>(`/tasks/${id}/accept`, "POST", { note }),
  revise: (id: string, reason: string) => send<{ task: Task }>(`/tasks/${id}/revise`, "POST", { reason }),
  setTaskStatus: (id: string, status: Task["status"], reason?: string) =>
    send<{ task: Task }>(`/tasks/${id}/status`, "POST", { status, reason }),
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
};
