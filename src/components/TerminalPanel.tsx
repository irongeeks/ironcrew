import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import AgentAvatar from "./AgentAvatar";
import { useI18n } from "../i18n";
import { STATUS_BADGES, type TerminalPanelProps } from "./terminal-panel/model";
import { useTerminalData, type InterruptProof } from "./terminal-panel/useTerminalData";
import { useInterventionState } from "./terminal-panel/useInterventionState";
import { InterventionPanel } from "./terminal-panel/InterventionPanel";
import { ProgressHintsStrip } from "./terminal-panel/ProgressHintsStrip";
import { MeetingMinutesTab } from "./terminal-panel/MeetingMinutesTab";
import { TerminalTab } from "./terminal-panel/TerminalTab";
import { useMobile } from "../hooks/useMobile";
import { MobileTerminalPanel } from "./mobile/MobileTerminalPanel";

export default function TerminalPanel({
  taskId,
  task,
  agent,
  agents,
  initialTab = "terminal",
  onClose,
}: TerminalPanelProps) {
  const { isMobile } = useMobile();
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

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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

  if (isMobile)
    return (
      <MobileTerminalPanel
        taskId={taskId}
        task={task}
        agent={agent}
        agents={agents}
        initialTab={initialTab}
        onClose={onClose}
      />
    );

  return (
    <div
      className="terminal-panel-shell fixed inset-0 z-50 flex w-full max-w-full flex-col shadow-2xl lg:right-0 lg:left-auto lg:w-[560px] lg:border-l"
      style={{ top: "var(--topbar-height, 0px)" }}
    >
      {/* Header */}
      <div className="terminal-panel-header flex items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {agent && <AgentAvatar agent={agent} agents={agents} size={28} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold truncate" style={{ color: "var(--th-text-heading)" }}>
                {task?.title ?? taskId}
              </h3>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.color} flex-shrink-0`}>
                {badgeLabel}
              </span>
            </div>
            {logPath && (
              <div className="text-[10px] truncate font-mono mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                {logPath}
              </div>
            )}
            <div
              className="mt-1 inline-flex rounded-md border overflow-hidden w-fit"
              style={{ borderColor: "var(--th-border)" }}
            >
              <button
                onClick={() => setActiveTab("terminal")}
                className="px-2 py-0.5 text-[10px] transition"
                style={
                  activeTab === "terminal"
                    ? {
                        background: "var(--accent-subtle)",
                        color: "var(--accent)",
                        borderRight: "1px solid var(--border)",
                      }
                    : {
                        background: "var(--bg-surface)",
                        color: "var(--text-secondary)",
                        borderRight: "1px solid var(--border)",
                      }
                }
              >
                {tr("터미널", "Terminal", "ターミナル", "终端", "Terminal")}
              </button>
              <button
                onClick={() => setActiveTab("minutes")}
                className="px-2 py-0.5 text-[10px] transition"
                style={
                  activeTab === "minutes"
                    ? { background: "var(--accent-subtle)", color: "var(--accent)" }
                    : { background: "var(--bg-surface)", color: "var(--text-secondary)" }
                }
              >
                {tr("회의록", "Minutes", "会議録", "会议纪要", "Protokoll")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isInterventionTarget && (
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
              title={tr("난입 패널", "Interrupt panel", "割り込みパネル", "中断面板", "Unterbrechungspanel")}
            >
              {task?.status === "pending"
                ? tr("주입", "Inject", "注入", "注入", "Einschleusen")
                : tr("난입", "Interrupt", "割込", "中断", "Unterbrechen")}
            </button>
          )}
          {/* Follow toggle */}
          <button
            onClick={() => setFollow((f) => !f)}
            className={`px-2 py-1 text-[10px] rounded border transition ${
              follow ? "bg-green-500/20 text-green-400 border-green-500/40" : ""
            }`}
            style={
              !follow
                ? {
                    background: "var(--th-bg-surface)",
                    color: "var(--th-text-secondary)",
                    borderColor: "var(--th-border)",
                  }
                : undefined
            }
            title={
              follow
                ? tr("자동 스크롤 ON", "Auto-scroll ON", "自動スクロール ON", "自动滚动 ON", "Autoscroll AN")
                : tr("자동 스크롤 OFF", "Auto-scroll OFF", "自動スクロール OFF", "自动滚动 OFF", "Autoscroll AUS")
            }
          >
            {follow
              ? tr("따라가기", "FOLLOW", "追従中", "跟随中", "FOLGEN")
              : tr("일시정지", "PAUSED", "一時停止", "已暂停", "PAUSIERT")}
          </button>
          {/* Scroll to bottom */}
          <button
            onClick={scrollToBottom}
            className="p-1.5 rounded transition"
            style={{ color: "var(--th-text-secondary)" }}
            title={tr("맨 아래로", "Scroll to bottom", "一番下へ", "滚动到底部", "Nach unten scrollen")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
          {/* Close */}
          <button onClick={onClose} className="p-1.5 rounded transition" style={{ color: "var(--th-text-secondary)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

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

      {/* Bottom status bar */}
      <div
        className="terminal-panel-footer flex items-center justify-between border-t px-4 py-1.5 text-[10px]"
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
    </div>
  );
}
