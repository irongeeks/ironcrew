import type { KeyboardEvent, RefObject } from "react";
import type { Agent } from "../../types";
import ChatModeHint from "./ChatModeHint";

type ChatMode = "chat" | "task" | "announcement" | "report";
type Tr = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

interface ChatComposerProps {
  mode: ChatMode;
  input: string;
  selectedAgent: Agent | null;
  isDirectiveMode: boolean;
  isAnnouncementMode: boolean;
  tr: Tr;
  getAgentName: (agent: Agent | null | undefined) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onModeChange: (mode: ChatMode) => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export default function ChatComposer({
  mode,
  input,
  selectedAgent,
  isDirectiveMode,
  isAnnouncementMode,
  tr,
  getAgentName,
  textareaRef,
  onModeChange,
  onInputChange,
  onSend,
  onKeyDown,
}: ChatComposerProps) {
  return (
    <>
      <div className="flex flex-shrink-0 gap-2 border-t px-4 pb-1 pt-3" style={{ borderColor: "var(--th-border)" }}>
        <button
          onClick={() => onModeChange(mode === "task" ? "chat" : "task")}
          disabled={!selectedAgent}
          aria-label={tr("업무 지시", "Task", "タスク指示", "任务指示", "Aufgabe")}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={
            mode === "task"
              ? { background: "rgba(96,165,250,0.15)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.3)" }
              : { background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }
          }
        >
          <span>📋</span>
          <span>{tr("업무 지시", "Task", "タスク指示", "任务指示", "Aufgabe")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "announcement" ? "chat" : "announcement")}
          aria-label={tr("전사 공지", "Announcement", "全体告知", "全员公告", "Ankündigung")}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors"
          style={
            mode === "announcement"
              ? { background: "rgba(251,191,36,0.15)", color: "#FBBF24", border: "1px solid rgba(251,191,36,0.3)" }
              : { background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }
          }
        >
          <span>📢</span>
          <span>{tr("전사 공지", "Announcement", "全体告知", "全员公告", "Ankündigung")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "report" ? "chat" : "report")}
          disabled={!selectedAgent}
          aria-label={tr("보고 요청", "Report", "レポート依頼", "报告请求", "Bericht")}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={
            mode === "report"
              ? { background: "var(--accent-subtle)", color: "var(--accent)", border: "1px solid var(--accent-dim)" }
              : { background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }
          }
        >
          <span>📊</span>
          <span>{tr("보고 요청", "Report", "レポート依頼", "报告请求", "Bericht")}</span>
        </button>
      </div>

      <ChatModeHint mode={mode} isDirectiveMode={isDirectiveMode} tr={tr} />

      <div className="flex-shrink-0 px-4 pb-4 pt-2">
        <div
          className={`flex items-end gap-2 rounded-xl border transition-colors ${
            isDirectiveMode
              ? "border-red-500/50 focus-within:border-red-400"
              : isAnnouncementMode
                ? "border-yellow-500/50 focus-within:border-yellow-400"
                : mode === "task"
                  ? "border-blue-500/50 focus-within:border-blue-400"
                  : mode === "report"
                    ? "border-emerald-500/50 focus-within:border-emerald-400"
                    : ""
          }`}
          style={{
            background: "var(--th-card-bg)",
            ...(!(isDirectiveMode || isAnnouncementMode || mode === "task" || mode === "report")
              ? { borderColor: "var(--th-border-strong)" }
              : {}),
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isAnnouncementMode
                ? tr(
                    "전사 공지 내용을 입력하세요...",
                    "Write an announcement...",
                    "全体告知内容を入力してください...",
                    "请输入公告内容...",
                    "Ankündigung eingeben...",
                  )
                : mode === "task"
                  ? tr(
                      "업무 지시 내용을 입력하세요...",
                      "Write a task instruction...",
                      "タスク指示内容を入力してください...",
                      "请输入任务指示内容...",
                      "Aufgabenanweisung eingeben...",
                    )
                  : mode === "report"
                    ? tr(
                        "보고 요청 내용을 입력하세요...",
                        "Write a report request...",
                        "レポート依頼内容を入力してください...",
                        "请输入报告请求内容...",
                        "Berichtsanfrage eingeben...",
                      )
                    : selectedAgent
                      ? tr(
                          `${getAgentName(selectedAgent)}에게 메시지 보내기...`,
                          `Send a message to ${getAgentName(selectedAgent)}...`,
                          `${getAgentName(selectedAgent)}にメッセージを送る...`,
                          `向 ${getAgentName(selectedAgent)} 发送消息...`,
                          `Nachricht an ${getAgentName(selectedAgent)} senden...`,
                        )
                      : tr(
                          "메시지를 입력하세요...",
                          "Type a message...",
                          "メッセージを入力してください...",
                          "请输入消息...",
                          "Nachricht eingeben...",
                        )
            }
            rows={1}
            className="min-h-10 max-h-32 flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3 text-sm leading-relaxed placeholder:text-[var(--text-muted)] focus:outline-none"
            style={{ color: "var(--th-text-primary)", scrollbarWidth: "none" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />
          <button
            onClick={onSend}
            disabled={!input.trim()}
            className="mb-2 mr-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all"
            style={
              !input.trim()
                ? { background: "var(--th-bg-surface-hover)", color: "var(--th-text-muted)", cursor: "not-allowed" }
                : isDirectiveMode
                  ? { background: "rgba(239,68,68,0.2)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }
                  : isAnnouncementMode
                    ? { background: "rgba(251,191,36,0.2)", color: "#FBBF24", border: "1px solid rgba(251,191,36,0.3)" }
                    : mode === "report"
                      ? {
                          background: "var(--accent-subtle)",
                          color: "var(--accent)",
                          border: "1px solid var(--accent-dim)",
                        }
                      : {
                          background: "var(--bg-glow)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-strong)",
                        }
            }
            aria-label={tr("전송", "Send", "送信", "发送", "Senden")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {tr(
            "Enter로 전송, Shift+Enter로 줄바꿈",
            "Press Enter to send, Shift+Enter for a new line",
            "Enterで送信、Shift+Enterで改行",
            "按 Enter 发送，Shift+Enter 换行",
            "Enter zum Senden, Shift+Enter für neue Zeile",
          )}
        </p>
      </div>
    </>
  );
}
