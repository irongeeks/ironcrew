import type { RefObject } from "react";
import type { Agent, Message } from "../../types";
import type { DecisionOption } from "../chat/decision-request";
import AgentAvatar from "../AgentAvatar";
import MessageContent from "../MessageContent";

type Tr = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

interface StreamingMessageLike {
  message_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar: string;
  content: string;
}

interface ChatMessageListProps {
  selectedAgent: Agent | null;
  visibleMessages: Message[];
  agents: Agent[];
  spriteMap: ReturnType<typeof import("../AgentAvatar").buildSpriteMap>;
  locale: string;
  tr: Tr;
  getAgentName: (agent: Agent | null | undefined) => string;
  decisionRequestByMessage: Map<string, { options: DecisionOption[] }>;
  decisionReplyKey: string | null;
  onDecisionOptionReply: (message: Message, option: DecisionOption) => void;
  onDecisionManualDraft: (option: DecisionOption) => void;
  streamingMessage?: StreamingMessageLike | null;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

function formatTime(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-2">
      <div
        className="flex items-center gap-1 rounded-2xl rounded-bl-sm px-4 py-2"
        style={{ background: "var(--th-bg-surface-hover)" }}
      >
        <span
          className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-muted)]"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-muted)]"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-muted)]"
          style={{ animationDelay: "300ms" }}
        />
      </div>
    </div>
  );
}

function normalizeMessageSenderName(msg: Message): string {
  return typeof msg.sender_name === "string" ? msg.sender_name.trim() : "";
}

function normalizeMessageSenderAvatar(msg: Message): string {
  const avatar = typeof msg.sender_avatar === "string" ? msg.sender_avatar.trim() : "";
  return avatar || "🤖";
}

function buildFallbackSenderAgent(msg: Message): Agent | undefined {
  const displayName = normalizeMessageSenderName(msg) || msg.sender_id || "";
  if (!displayName) return undefined;
  return {
    id: msg.sender_id || `msg-sender-${msg.id}`,
    name: displayName,
    name_ko: displayName,
    name_ja: displayName,
    name_zh: displayName,
    department_id: null,
    role: "junior",
    cli_provider: "api",
    avatar_emoji: normalizeMessageSenderAvatar(msg),
    personality: null,
    status: "idle",
    current_task_id: null,
    created_at: msg.created_at,
  };
}

export default function ChatMessageList({
  selectedAgent,
  visibleMessages,
  agents,
  spriteMap,
  locale,
  tr,
  getAgentName,
  decisionRequestByMessage,
  decisionReplyKey,
  onDecisionOptionReply,
  onDecisionManualDraft,
  streamingMessage,
  messagesEndRef,
}: ChatMessageListProps) {
  const isStreamingForAgent = Boolean(
    streamingMessage && selectedAgent && streamingMessage.agent_id === selectedAgent.id,
  );

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {visibleMessages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
          <div className="text-6xl">💬</div>
          <div>
            <p className="font-medium" style={{ color: "var(--th-text-secondary)" }}>
              {tr(
                "대화를 시작해보세요! 👋",
                "Start a conversation! 👋",
                "会話を始めましょう! 👋",
                "开始对话吧! 👋",
                "Gespräch beginnen! 👋",
              )}
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--th-text-muted)" }}>
              {selectedAgent
                ? tr(
                    `${getAgentName(selectedAgent)}에게 메시지를 보내보세요`,
                    `Send a message to ${getAgentName(selectedAgent)}`,
                    `${getAgentName(selectedAgent)}にメッセージを送ってみましょう`,
                    `给 ${getAgentName(selectedAgent)} 发送一条消息吧`,
                    `Nachricht an ${getAgentName(selectedAgent)} senden`,
                  )
                : tr(
                    "전체 에이전트에게 공지를 보내보세요",
                    "Send an announcement to all agents",
                    "すべてのエージェントに告知を送ってみましょう",
                    "给所有代理发送一条公告吧",
                    "Ankündigung an alle Agenten senden",
                  )}
            </p>
          </div>
        </div>
      ) : (
        <>
          {visibleMessages.map((msg) => {
            const isCeo = msg.sender_type === "ceo";
            const isDirective = msg.message_type === "directive";
            const isSystem = msg.sender_type === "system" || msg.message_type === "announcement" || isDirective;

            const senderAgent =
              msg.sender_agent ?? agents.find((agent) => agent.id === msg.sender_id) ?? buildFallbackSenderAgent(msg);
            const senderNameFromPayload = normalizeMessageSenderName(msg);
            const senderName = isCeo
              ? tr("CEO", "CEO")
              : isSystem
                ? tr("시스템", "System", "システム", "系统", "System")
                : getAgentName(senderAgent) ||
                  senderNameFromPayload ||
                  tr("알 수 없음", "Unknown", "不明", "未知", "Unbekannt");
            const decisionRequest = decisionRequestByMessage.get(msg.id);

            if (msg.sender_type === "agent" && msg.receiver_type === "all") {
              return (
                <div key={msg.id} className="flex items-end gap-2">
                  <AgentAvatar agent={senderAgent} spriteMap={spriteMap} size={28} />
                  <div className="flex max-w-[75%] flex-col gap-1">
                    <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                      {senderName}
                    </span>
                    <div
                      className="announcement-reply-bubble rounded-2xl rounded-bl-sm border border-yellow-500/20 px-4 py-2.5 text-sm"
                      style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                    >
                      <MessageContent content={msg.content} />
                    </div>
                    {decisionRequest && (
                      <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-2 py-2">
                        <p className="text-[11px] font-medium text-indigo-200">
                          {tr(
                            "의사결정 요청",
                            "Decision request",
                            "意思決定リクエスト",
                            "决策请求",
                            "Entscheidungsanfrage",
                          )}
                        </p>
                        <div className="mt-1.5 space-y-1">
                          {decisionRequest.options.map((option) => {
                            const key = `${msg.id}:${option.number}`;
                            const isBusy = decisionReplyKey === key;
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => onDecisionOptionReply(msg, option)}
                                disabled={isBusy}
                                className="decision-inline-option w-full rounded-md px-2 py-1.5 text-left text-[11px] transition disabled:opacity-60"
                              >
                                {isBusy
                                  ? tr("전송 중...", "Sending...", "送信中...", "发送中...", "Wird gesendet...")
                                  : `${option.number}. ${option.label}`}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={() => onDecisionManualDraft(decisionRequest.options[0])}
                          className="mt-2 text-[11px] text-indigo-200/90 underline underline-offset-2 hover:text-indigo-100"
                        >
                          {tr(
                            "직접 답변 작성",
                            "Write custom reply",
                            "カスタム返信を作成",
                            "编写自定义回复",
                            "Eigene Antwort verfassen",
                          )}
                        </button>
                      </div>
                    )}
                    <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                      {formatTime(msg.created_at, locale)}
                    </span>
                  </div>
                </div>
              );
            }

            if (isSystem || msg.receiver_type === "all") {
              return (
                <div key={msg.id} className="flex flex-col items-center gap-1">
                  {isDirective && (
                    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-400">
                      {tr("업무지시", "Directive", "業務指示", "业务指示", "Anweisung")}
                    </span>
                  )}
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-center text-sm shadow-sm ${
                      isDirective
                        ? "border border-red-500/30 bg-red-500/15 text-red-300"
                        : "announcement-message-bubble border border-yellow-500/30 bg-yellow-500/15 text-yellow-300"
                    }`}
                  >
                    <MessageContent content={msg.content} />
                  </div>
                  <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {formatTime(msg.created_at, locale)}
                  </span>
                </div>
              );
            }

            if (isCeo) {
              return (
                <div key={msg.id} className="flex flex-col items-end gap-1">
                  <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {tr("CEO", "CEO")}
                  </span>
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm text-white">
                    <MessageContent content={msg.content} />
                  </div>
                  <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {formatTime(msg.created_at, locale)}
                  </span>
                </div>
              );
            }

            return (
              <div key={msg.id} className="flex items-end gap-2">
                <AgentAvatar agent={senderAgent} spriteMap={spriteMap} size={28} />
                <div className="flex max-w-[75%] flex-col gap-1">
                  <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {senderName}
                  </span>
                  <div
                    className="rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm"
                    style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                  >
                    <MessageContent content={msg.content} />
                  </div>
                  {decisionRequest && (
                    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-2 py-2">
                      <p className="text-[11px] font-medium text-indigo-200">
                        {tr(
                          "의사결정 요청",
                          "Decision request",
                          "意思決定リクエスト",
                          "决策请求",
                          "Entscheidungsanfrage",
                        )}
                      </p>
                      <div className="mt-1.5 space-y-1">
                        {decisionRequest.options.map((option) => {
                          const key = `${msg.id}:${option.number}`;
                          const isBusy = decisionReplyKey === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => onDecisionOptionReply(msg, option)}
                              disabled={isBusy}
                              className="decision-inline-option w-full rounded-md px-2 py-1.5 text-left text-[11px] transition disabled:opacity-60"
                            >
                              {isBusy
                                ? tr("전송 중...", "Sending...", "送信中...", "发送中...", "Wird gesendet...")
                                : `${option.number}. ${option.label}`}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => onDecisionManualDraft(decisionRequest.options[0])}
                        className="mt-2 text-[11px] text-indigo-200/90 underline underline-offset-2 hover:text-indigo-100"
                      >
                        {tr("직접 답변 작성", "Write custom reply", "カスタム返信を作成", "编写自定义回复")}
                      </button>
                    </div>
                  )}
                  <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {formatTime(msg.created_at, locale)}
                  </span>
                </div>
              </div>
            );
          })}

          {isStreamingForAgent && streamingMessage?.content && (
            <div className="flex items-end gap-2">
              <AgentAvatar agent={selectedAgent ?? undefined} spriteMap={spriteMap} size={28} />
              <div className="flex max-w-[75%] flex-col gap-1">
                <span className="px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {getAgentName(selectedAgent)}
                </span>
                <div
                  className="rounded-2xl rounded-bl-sm border border-emerald-500/20 px-4 py-2.5 text-sm"
                  style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                >
                  <MessageContent content={streamingMessage.content} />
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-emerald-400 align-text-bottom" />
                </div>
              </div>
            </div>
          )}

          {selectedAgent && selectedAgent.status === "working" && !isStreamingForAgent && (
            <div className="flex items-end gap-2">
              <AgentAvatar agent={selectedAgent} spriteMap={spriteMap} size={28} />
              <TypingIndicator />
            </div>
          )}
        </>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
