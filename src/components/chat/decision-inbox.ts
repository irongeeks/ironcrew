import type { Agent, Message } from "../../types";
import { parseDecisionRequest } from "./decision-request";
import type { DecisionOption } from "./decision-request";

export interface DecisionInboxItem {
  id: string;
  kind: "agent_request" | "project_review_ready" | "task_timeout_resume" | "review_round_pick";
  agentId: string | null;
  agentName: string;
  agentNameKo: string;
  agentAvatar?: string | null;
  requestContent: string;
  options: DecisionOption[];
  createdAt: number;
  taskId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
}

const DECISION_REPLY_RE = /\[의사결정\s*회신\]|\[Decision Reply\]|\[意思決定返信\]|\[决策回复\]/i;

export function isDecisionReplyContent(content: string): boolean {
  return DECISION_REPLY_RE.test(content);
}

function normalizeMessageSenderName(msg: Message): string {
  return typeof msg.sender_name === "string" ? msg.sender_name.trim() : "";
}

function normalizeMessageSenderAvatar(msg: Message): string | null {
  const avatar = typeof msg.sender_avatar === "string" ? msg.sender_avatar.trim() : "";
  return avatar || null;
}

export function buildDecisionInboxItems(messages: Message[], agents: Agent[]): DecisionInboxItem[] {
  const agentById = new Map<string, Agent>();
  for (const agent of agents) agentById.set(agent.id, agent);

  const items: DecisionInboxItem[] = [];

  for (const msg of messages) {
    if (msg.sender_type !== "agent" || !msg.sender_id) continue;
    const parsed = parseDecisionRequest(msg.content);
    if (!parsed) continue;

    const resolved = messages.some(
      (follow) =>
        follow.sender_type === "ceo" &&
        follow.receiver_type === "agent" &&
        follow.receiver_id === msg.sender_id &&
        follow.created_at > msg.created_at &&
        isDecisionReplyContent(follow.content),
    );
    if (resolved) continue;

    const matchedAgent = agentById.get(msg.sender_id) ?? msg.sender_agent;
    const senderName = normalizeMessageSenderName(msg);
    const senderAvatar = normalizeMessageSenderAvatar(msg);
    items.push({
      id: msg.id,
      kind: "agent_request",
      agentId: msg.sender_id,
      agentName: matchedAgent?.name || senderName || msg.sender_id,
      agentNameKo: matchedAgent?.name_ko || matchedAgent?.name || senderName || msg.sender_id,
      agentAvatar: matchedAgent?.avatar_emoji || senderAvatar,
      requestContent: msg.content,
      options: parsed.options,
      createdAt: msg.created_at,
      taskId: msg.task_id ?? null,
    });
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}
