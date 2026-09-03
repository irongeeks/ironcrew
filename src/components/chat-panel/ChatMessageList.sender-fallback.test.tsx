import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Message } from "../../types";
import ChatMessageList from "./ChatMessageList";

function tr(ko: string): string {
  return ko;
}

describe("ChatMessageList sender fallback", () => {
  it("uses sender_name when sender agent is missing from local agents list", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        sender_type: "agent",
        sender_id: "agent-missing",
        sender_name: "리안",
        sender_avatar: "🎬",
        receiver_type: "agent",
        receiver_id: "ceo",
        content: "진행 옵션\n1. A\n2. B",
        message_type: "chat",
        task_id: null,
        created_at: Date.now(),
      },
    ];

    render(
      <ChatMessageList
        selectedAgent={null}
        visibleMessages={messages}
        agents={[]}
        spriteMap={new Map()}
        locale="ko-KR"
        tr={tr}
        getAgentName={(agent) => agent?.name_ko ?? agent?.name ?? ""}
        decisionRequestByMessage={new Map()}
        decisionReplyKey={null}
        onDecisionOptionReply={() => {}}
        onDecisionManualDraft={() => {}}
        streamingMessage={null}
        messagesEndRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(screen.getByText("리안")).toBeInTheDocument();
    expect(screen.queryByText("알 수 없음")).not.toBeInTheDocument();
  });
});
