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
import type { Agent, Approval, Dashboard, Department, Message, RunEvent, Task } from "./types.ts";

const BASE = "/api/ic";

function get<T>(path: string): Promise<T> {
  return request<T>(`${BASE}${path}`);
}

function send<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
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
  approvals: () => get<{ approvals: Approval[] }>("/approvals"),
  decide: (id: string, decision: "approved" | "rejected", reason?: string) =>
    send<{ approval: Approval }>(`/approvals/${id}/decide`, "POST", { decision, reason }),
  dashboard: () => get<Dashboard>("/dashboard"),
  runEvents: (runId: string) => get<{ events: RunEvent[] }>(`/runs/${runId}/events`),
};
