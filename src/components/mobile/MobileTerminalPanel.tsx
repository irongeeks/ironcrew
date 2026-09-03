import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { MobileBottomSheet } from "./MobileBottomSheet";
import { useI18n } from "../../i18n";
import { STATUS_BADGES, type TerminalPanelProps } from "../terminal-panel/model";
import { useTerminalData, type InterruptProof } from "../terminal-panel/useTerminalData";
import { useInterventionState } from "../terminal-panel/useInterventionState";
import { InterventionPanel } from "../terminal-panel/InterventionPanel";
import { ProgressHintsStrip } from "../terminal-panel/ProgressHintsStrip";
import { MeetingMinutesTab } from "../terminal-panel/MeetingMinutesTab";
import { TerminalTab } from "../terminal-panel/TerminalTab";

export function MobileTerminalPanel({
  taskId,
  task,
  agent,
  agents: _agents,
  initialTab = "terminal",
  onClose,
}: TerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<"terminal" | "minutes">(initialTab);
  const { t, locale } = useI18n();

  const tr = (ko: string, en: string, ja = en, zh = en, de = en) => t({ ko, en, ja, zh, de });

  const isKorean = locale.startsWith("ko");
  const agentName = agent ? (isKorean ? agent.name_ko || agent.name : agent.name || agent.name_ko) : null;

  const taskLogTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [locale],
  );

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, taskId]);

  // Ref bridge for circular dependency between useTerminalData and useInterventionState
  const setInterruptProofRef = useRef<((proof: InterruptProof | null) => void) | null>(null);

  const {
    text,
    taskLogs,
    progressHints,
    meetingMinutes,
    logPath,
    follow,
    setFollow,
    preRef,
    containerRef,
    fetchTerminal,
    handleScroll,
    scrollToBottom,
  } = useTerminalData(
    taskId,
    activeTab,
    useCallback((proof: InterruptProof | null) => setInterruptProofRef.current?.(proof), []),
  );

  const {
    interventionOpen,
    setInterventionOpen,
    interventionPrompt,
    setInterventionPrompt,
    interventionBusy,
    interventionError,
    setInterventionError,
    interventionMessage,
    setInterventionMessage,
    interruptProof,
    setInterruptProof,
    promptInputRef,
    isInterventionTarget,
    canInjectPrompt,
    hasAssignedAgent,
    canAttemptInterrupt,
    handlePauseOnly,
    handleInjectAndResume,
    handleResumeOnly,
  } = useInterventionState(taskId, task, fetchTerminal, tr);

  setInterruptProofRef.current = setInterruptProof;

  const badge = STATUS_BADGES[task?.status ?? ""] ?? STATUS_BADGES.inbox;
  const badgeLabel = t(badge.label);

  const shouldShowProgressHints = activeTab === "terminal" && Boolean(progressHints && progressHints.hints.length > 0);

  const title = [task?.title ?? taskId, agentName].filter(Boolean).join(" · ");

  return (
    <MobileBottomSheet open={true} onClose={onClose} title={title} maxHeight="80dvh">
      {/* Header row: status dot + agent + close */}
      <div className="flex items-center gap-2 pt-1 pb-2 border-b" style={{ borderColor: "var(--th-border)" }}>
        {task?.status === "in_progress" && (
          <span
            className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0"
            aria-hidden="true"
          />
        )}
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded border flex-shrink-0 ${badge.color}`}
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 8,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {badgeLabel}
        </span>
        {agentName && (
          <span
            className="truncate"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--th-text-secondary)",
              minWidth: 0,
            }}
          >
            {agentName}
            {agent?.cli_provider ? ` \u00b7 ${agent.cli_provider}` : ""}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={tr("닫기", "Close", "閉じる", "关闭", "Schließen")}
          className="ml-auto flex items-center justify-center rounded transition flex-shrink-0"
          style={{
            width: 44,
            height: 44,
            color: "var(--th-text-secondary)",
            background: "transparent",
            border: "none",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tab switcher + controls */}
      <div className="flex items-center gap-2 pt-2 pb-2">
        <div
          className="inline-flex rounded-md border overflow-hidden w-fit"
          style={{ borderColor: "var(--th-border)" }}
          role="tablist"
        >
          <button
            role="tab"
            aria-selected={activeTab === "terminal"}
            onClick={() => setActiveTab("terminal")}
            className="transition"
            style={{
              minHeight: 32,
              padding: "6px 12px",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 9,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              ...(activeTab === "terminal"
                ? {
                    background: "var(--accent-subtle)",
                    color: "var(--accent)",
                    borderRight: "1px solid var(--th-border)",
                  }
                : {
                    background: "var(--th-bg-surface)",
                    color: "var(--th-text-secondary)",
                    borderRight: "1px solid var(--th-border)",
                  }),
            }}
          >
            {tr("터미널", "Terminal", "ターミナル", "终端", "Terminal")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "minutes"}
            onClick={() => setActiveTab("minutes")}
            className="transition"
            style={{
              minHeight: 32,
              padding: "6px 12px",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 9,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              ...(activeTab === "minutes"
                ? { background: "var(--accent-subtle)", color: "var(--accent)" }
                : { background: "var(--th-bg-surface)", color: "var(--th-text-secondary)" }),
            }}
          >
            {tr("회의록", "Minutes", "会議録", "会议纪要", "Protokoll")}
          </button>
        </div>

        {/* Follow toggle */}
        <button
          onClick={() => setFollow((f) => !f)}
          className={`ml-auto rounded border transition ${
            follow ? "bg-green-500/20 text-green-400 border-green-500/40" : ""
          }`}
          style={{
            minHeight: 32,
            padding: "6px 10px",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 8,
            letterSpacing: "0.08em",
            ...(!follow
              ? {
                  background: "var(--th-bg-surface)",
                  color: "var(--th-text-secondary)",
                  borderColor: "var(--th-border)",
                }
              : undefined),
          }}
        >
          {follow
            ? tr("따라가기", "FOLLOW", "追従中", "跟随中", "FOLGEN")
            : tr("일시정지", "PAUSED", "一時停止", "已暂停", "PAUSIERT")}
        </button>

        {/* Scroll to bottom */}
        <button
          onClick={scrollToBottom}
          className="flex items-center justify-center rounded transition flex-shrink-0"
          style={{ width: 32, height: 32, color: "var(--th-text-secondary)" }}
          title={tr("맨 아래로", "Scroll to bottom", "一番下へ", "滚动到底部", "Nach unten scrollen")}
          aria-label={tr("맨 아래로", "Scroll to bottom", "一番下へ", "滚动到底部", "Nach unten scrollen")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      </div>

      {/* Log path */}
      {logPath && (
        <div className="text-[10px] truncate font-mono mb-1" style={{ color: "var(--th-text-muted)" }}>
          {logPath}
        </div>
      )}

      {/* Intervention panel */}
      {activeTab === "terminal" && isInterventionTarget && (
        <div className="mb-2">
          <button
            onClick={() => {
              setInterventionOpen((prev) => !prev);
              setInterventionError(null);
              setInterventionMessage(null);
            }}
            className={`px-2 py-1 text-[10px] rounded border transition ${
              interventionOpen ? "bg-rose-500/20 text-rose-300 border-rose-500/40" : ""
            }`}
            style={
              !interventionOpen
                ? {
                    background: "var(--th-bg-surface)",
                    color: "var(--th-text-secondary)",
                    borderColor: "var(--th-border)",
                  }
                : undefined
            }
          >
            {task?.status === "pending"
              ? tr("주입", "Inject", "注入", "注入", "Einschleusen")
              : tr("난입", "Interrupt", "割込", "中断", "Unterbrechen")}
          </button>
        </div>
      )}

      {activeTab === "terminal" && isInterventionTarget && interventionOpen && (
        <InterventionPanel
          task={task}
          interventionPrompt={interventionPrompt}
          setInterventionPrompt={setInterventionPrompt}
          interventionBusy={interventionBusy}
          interventionError={interventionError}
          interventionMessage={interventionMessage}
          interruptProof={interruptProof}
          hasAssignedAgent={hasAssignedAgent}
          canInjectPrompt={canInjectPrompt}
          canAttemptInterrupt={canAttemptInterrupt}
          promptInputRef={promptInputRef}
          handlePauseOnly={handlePauseOnly}
          handleInjectAndResume={handleInjectAndResume}
          handleResumeOnly={handleResumeOnly}
          tr={tr}
        />
      )}

      {/* Terminal / Minutes content */}
      <div className="flex flex-col flex-1 min-h-0" style={{ height: "calc(80dvh - 180px)" }}>
        {activeTab === "terminal" ? (
          <TerminalTab
            text={text}
            taskLogs={taskLogs}
            taskStatus={task?.status}
            shouldShowProgressHints={shouldShowProgressHints}
            taskLogTimeFormatter={taskLogTimeFormatter}
            containerRef={containerRef}
            preRef={preRef}
            onScroll={handleScroll}
            tr={tr}
          />
        ) : (
          <MeetingMinutesTab meetingMinutes={meetingMinutes} taskLogs={taskLogs} locale={locale} tr={tr} />
        )}

        {activeTab === "terminal" && shouldShowProgressHints && progressHints && (
          <ProgressHintsStrip progressHints={progressHints} tr={tr} />
        )}
      </div>

      {/* Bottom status bar */}
      <div
        className="flex items-center justify-between border-t px-1 py-1.5 text-[10px] mt-1"
        style={{ color: "var(--th-text-muted)" }}
      >
        <span>
          {agent
            ? `${agentName}`
            : tr("담당 에이전트 없음", "No agent", "担当エージェントなし", "无负责人", "Kein Agent")}
          {agent?.cli_provider ? ` (${agent.cli_provider})` : ""}
        </span>
        <span>
          {task?.status === "in_progress" && (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {activeTab === "terminal"
                ? tr("실시간", "Live", "ライブ", "实时", "Live")
                : tr("회의록", "Minutes", "会議録", "会议纪要", "Protokoll")}
            </span>
          )}
          {task?.status === "review" && tr("검토 중", "Under review", "レビュー中", "审核中", "In Überprüfung")}
          {task?.status === "done" && tr("완료됨", "Completed", "完了", "已完成", "Abgeschlossen")}
        </span>
      </div>
    </MobileBottomSheet>
  );
}

export default MobileTerminalPanel;
