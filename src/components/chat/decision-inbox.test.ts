import { describe, expect, it } from "vitest";
import type { Agent, Message } from "../../types";
import { buildDecisionInboxItems, isDecisionReplyContent } from "./decision-inbox";

function createMessage(partial: Partial<Message> & Pick<Message, "id" | "content" | "created_at">): Message {
  return {
    id: partial.id,
    sender_type: partial.sender_type ?? "agent",
    sender_id: partial.sender_id ?? "agent-1",
    receiver_type: partial.receiver_type ?? "agent",
    receiver_id: partial.receiver_id ?? null,
    content: partial.content,
    message_type: partial.message_type ?? "chat",
    task_id: partial.task_id ?? null,
    created_at: partial.created_at,
    sender_agent: partial.sender_agent,
    sender_name: partial.sender_name ?? null,
    sender_avatar: partial.sender_avatar ?? null,
  };
}

const AGENTS: Agent[] = [
  {
    id: "agent-1",
    name: "Atlas",
    name_ko: "아틀라스",
    department_id: "planning",
    role: "team_leader",
    cli_provider: "claude",
    avatar_emoji: "🤖",
    personality: null,
    status: "idle",
    current_task_id: null,
    created_at: 0,
  },
];

describe("decision inbox helpers", () => {
  it("detects localized decision reply prefixes", () => {
    expect(isDecisionReplyContent("[의사결정 회신] 1번")).toBe(true);
    expect(isDecisionReplyContent("[Decision Reply] option 2")).toBe(true);
    expect(isDecisionReplyContent("normal chat")).toBe(false);
  });

  it("returns only unresolved decision requests", () => {
    const messages: Message[] = [
      createMessage({
        id: "req-1",
        sender_type: "agent",
        sender_id: "agent-1",
        content: "진행 옵션\n1. A\n2. B",
        created_at: 1000,
      }),
      createMessage({
        id: "reply-1",
        sender_type: "ceo",
        receiver_type: "agent",
        receiver_id: "agent-1",
        content: "[의사결정 회신] 1번",
        created_at: 2000,
      }),
      createMessage({
        id: "req-2",
        sender_type: "agent",
        sender_id: "agent-1",
        content: "진행 옵션\n1. C\n2. D",
        created_at: 3000,
      }),
    ];

    const items = buildDecisionInboxItems(messages, AGENTS);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("req-2");
    expect(items[0]?.options.map((option) => option.number)).toEqual([1, 2]);
  });

  it("falls back to sender_name/avatar when agent list has no matching sender", () => {
    const messages: Message[] = [
      createMessage({
        id: "req-fallback",
        sender_type: "agent",
        sender_id: "agent-unknown",
        sender_name: "리안",
        sender_avatar: "🎬",
        content: "진행 옵션\n1. A\n2. B",
        created_at: 4000,
      }),
    ];

    const items = buildDecisionInboxItems(messages, AGENTS);
    expect(items).toHaveLength(1);
    expect(items[0]?.agentName).toBe("리안");
    expect(items[0]?.agentNameKo).toBe("리안");
    expect(items[0]?.agentAvatar).toBe("🎬");
  });
});
