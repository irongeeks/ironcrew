/** Thin typed client for the Iron Command REST surface. */

import type { Agent, Approval, Dashboard, Department, Message, RunEvent, Task } from "./types.ts";

const BASE = "/api/ic";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Surface the server's reason rather than a generic failure: an approval
    // block (403) and a budget stop (402) are meaningful answers, not errors
    // to swallow.
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // non-JSON body; keep the status text
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  company: () => req<{ company: { name: string }; departments: Department[] }>("/company"),
  agents: () => req<{ agents: Agent[] }>("/agents"),
  chat: () => req<{ conversationId: string; messages: Message[] }>("/chat"),
  sendMessage: (body: string) =>
    req<{ reply: string; task: Task | null; assignedAgent: Agent | null }>("/chat", {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  tasks: () => req<{ tasks: Task[] }>("/tasks"),
  task: (id: string) => req<{ task: Task; runs: unknown[]; audit: unknown[] }>(`/tasks/${id}`),
  executeNext: () => req<{ executed: boolean; task?: Task; runId?: string }>("/tasks/execute-next", { method: "POST" }),
  accept: (id: string, note?: string) =>
    req<{ task: Task }>(`/tasks/${id}/accept`, { method: "POST", body: JSON.stringify({ note }) }),
  revise: (id: string, reason: string) =>
    req<{ task: Task }>(`/tasks/${id}/revise`, { method: "POST", body: JSON.stringify({ reason }) }),
  approvals: () => req<{ approvals: Approval[] }>("/approvals"),
  decide: (id: string, decision: "approved" | "rejected", reason?: string) =>
    req<{ approval: Approval }>(`/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, reason }),
    }),
  dashboard: () => req<Dashboard>("/dashboard"),
  runEvents: (runId: string) => req<{ events: RunEvent[] }>(`/runs/${runId}/events`),
};
