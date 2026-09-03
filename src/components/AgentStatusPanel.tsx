import { useEffect, useState, useCallback } from "react";
import type { Agent } from "../types";
import type { ActiveAgentInfo, CliProcessInfo } from "../api";
import type { UiLanguage } from "../i18n";
import { pickLang, localeName } from "../i18n";
import { getActiveAgents, getCliProcesses, killCliProcess, stopTask } from "../api";
import AgentAvatar from "./AgentAvatar";

interface AgentStatusPanelProps {
  agents: Agent[];
  uiLanguage: UiLanguage;
  onClose: () => void;
}

function fmtElapsed(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function displayCliProvider(provider: CliProcessInfo["provider"]): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "node") return "Node";
  if (provider === "python") return "Python";
  return "OpenCode";
}

export default function AgentStatusPanel({ agents, uiLanguage, onClose }: AgentStatusPanelProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);
  const [activeAgents, setActiveAgents] = useState<ActiveAgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [inspectorMode, setInspectorMode] = useState<"idle_cli" | "script" | null>(null);
  const [cliProcesses, setCliProcesses] = useState<CliProcessInfo[]>([]);
  const [cliLoading, setCliLoading] = useState(false);
  const [killingCliPids, setKillingCliPids] = useState<Set<number>>(new Set());

  const refresh = useCallback(() => {
    getActiveAgents()
      .then(setActiveAgents)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const refreshCli = useCallback(() => {
    setCliLoading(true);
    getCliProcesses()
      .then(setCliProcesses)
      .catch(console.error)
      .finally(() => setCliLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    let interval: ReturnType<typeof setInterval>;
    function start() {
      interval = setInterval(refresh, 5000);
    }
    function onVis() {
      clearInterval(interval);
      if (!document.hidden) {
        refresh();
        start();
      }
    }
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  useEffect(() => {
    if (!inspectorMode) return;
    refreshCli();
    let interval: ReturnType<typeof setInterval>;
    function start() {
      interval = setInterval(refreshCli, 5000);
    }
    function onVis() {
      clearInterval(interval);
      if (!document.hidden) {
        refreshCli();
        start();
      }
    }
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [inspectorMode, refreshCli]);

  const handleKill = async (taskId: string) => {
    if (!taskId || killing.has(taskId)) return;
    setKilling((prev) => new Set(prev).add(taskId));
    try {
      await stopTask(taskId);
      // Refresh after a moment
      setTimeout(refresh, 1000);
    } catch (e) {
      console.error("Failed to stop task:", e);
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleKillCliProcess = async (pid: number) => {
    if (!Number.isFinite(pid) || pid <= 0 || killingCliPids.has(pid)) return;
    setKillingCliPids((prev) => new Set(prev).add(pid));
    try {
      await killCliProcess(pid);
      setTimeout(refreshCli, 600);
      setTimeout(refresh, 800);
    } catch (e) {
      console.error("Failed to kill CLI process:", e);
    } finally {
      setKillingCliPids((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  };

  const visibleCliProcesses =
    inspectorMode === "script"
      ? cliProcesses.filter((proc) => proc.provider === "node" || proc.provider === "python")
      : cliProcesses.filter((proc) => proc.provider !== "node" && proc.provider !== "python");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`relative mx-4 w-full border border-blue-500/30 shadow-[var(--shadow-modal)] ${
          inspectorMode ? "max-w-3xl" : "max-w-lg"
        }`}
        style={{ background: "var(--th-bg-secondary)", borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">&#x1F6E0;</span>
            <h2 className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "활성 에이전트",
                en: "Active Agents",
                ja: "アクティブエージェント",
                zh: "Active Agents",
                de: "Aktive Agenten",
              })}
            </h2>
            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
              {activeAgents.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                const nextMode = inspectorMode === "script" ? null : "script";
                setInspectorMode(nextMode);
                if (nextMode) refreshCli();
              }}
              className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium whitespace-nowrap transition ${
                inspectorMode === "script"
                  ? "border-violet-500/40 bg-violet-500/20 text-violet-300"
                  : "hover:text-white"
              }`}
              title={t({
                ko: "Script 조회",
                en: "Script Inspector",
                ja: "Script確認",
                zh: "Script Inspector",
                de: "Script-Inspektor",
              })}
            >
              <span>{t({ ko: "Script조회", en: "Script", ja: "Script", zh: "Script", de: "Script" })}</span>
              <span aria-hidden>&#x2699;</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const nextMode = inspectorMode === "idle_cli" ? null : "idle_cli";
                setInspectorMode(nextMode);
                if (nextMode) refreshCli();
              }}
              className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium whitespace-nowrap transition ${
                inspectorMode === "idle_cli" ? "border-blue-500/40 bg-blue-500/20 text-blue-300" : "hover:text-white"
              }`}
              title={t({
                ko: "유휴 CLI 조회",
                en: "Idle CLI Inspector",
                ja: "アイドルCLI確認",
                zh: "Idle CLI Inspector",
                de: "Inaktiver CLI-Inspektor",
              })}
            >
              <span>
                {t({ ko: "유휴CLI조회", en: "Idle CLI", ja: "アイドルCLI", zh: "Idle CLI", de: "Inaktiver CLI" })}
              </span>
              <span aria-hidden>&#x1F5A5;</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                refresh();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:text-white"
              style={{ color: "var(--th-text-secondary)" }}
              title={t({ ko: "새로고침", en: "Refresh", ja: "リフレッシュ", zh: "Refresh", de: "Aktualisieren" })}
            >
              &#x21BB;
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:text-white"
              style={{ color: "var(--th-text-secondary)" }}
            >
              &#x2715;
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-[70vh] overflow-y-auto">
          {inspectorMode && (
            <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  {inspectorMode === "script"
                    ? t({
                        ko: "실행 중인 Script",
                        en: "Running Script Processes",
                        ja: "実行中Script",
                        zh: "Running Script Processes",
                        de: "Laufende Script-Prozesse",
                      })
                    : t({
                        ko: "실행 중인 유휴CLI",
                        en: "Running Idle CLI Processes",
                        ja: "実行中アイドルCLI",
                        zh: "Running Idle CLI Processes",
                        de: "Laufende inaktive CLI-Prozesse",
                      })}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: "var(--th-card-bg)", color: "var(--th-text-secondary)" }}
                  >
                    {visibleCliProcesses.length}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      refreshCli();
                    }}
                    className="rounded border px-2 py-0.5 text-[11px] transition hover:text-white"
                    style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                  >
                    {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
                  </button>
                </div>
              </div>
              {cliLoading && visibleCliProcesses.length === 0 ? (
                <div className="py-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {inspectorMode === "script"
                    ? t({
                        ko: "Script 목록 불러오는 중...",
                        en: "Loading script list...",
                        ja: "Script一覧を読み込み中...",
                        zh: "Loading script list...",
                        de: "Script-Liste wird geladen...",
                      })
                    : t({
                        ko: "유휴 CLI 목록 불러오는 중...",
                        en: "Loading idle CLI list...",
                        ja: "アイドルCLI一覧を読み込み中...",
                        zh: "Loading idle CLI list...",
                        de: "Inaktive CLI-Liste wird geladen...",
                      })}
                </div>
              ) : visibleCliProcesses.length === 0 ? (
                <div className="py-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {inspectorMode === "script"
                    ? t({
                        ko: "실행 중인 Script가 없습니다",
                        en: "No running script process",
                        ja: "実行中Scriptなし",
                        zh: "No running script process",
                        de: "Kein laufender Script-Prozess",
                      })
                    : t({
                        ko: "실행 중인 유휴 CLI가 없습니다",
                        en: "No running idle CLI",
                        ja: "実行中アイドルCLIなし",
                        zh: "No running idle CLI",
                        de: "Kein laufender inaktiver CLI",
                      })}
                </div>
              ) : (
                <div
                  className="max-h-56 divide-y overflow-y-auto rounded-lg border"
                  style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
                >
                  {visibleCliProcesses.map((proc) => {
                    const isKilling = killingCliPids.has(proc.pid);
                    const agentName =
                      uiLanguage === "ko" ? proc.agent_name_ko || proc.agent_name || "-" : proc.agent_name || "-";
                    const commandText = proc.command || proc.executable;
                    const displayTitle = proc.task_title && proc.task_title !== commandText ? proc.task_title : null;
                    return (
                      <div key={proc.pid} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <span
                                className="rounded px-1.5 py-0.5"
                                style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                              >
                                {displayCliProvider(proc.provider)}
                              </span>
                              <span style={{ color: "var(--th-text-secondary)" }}>PID {proc.pid}</span>
                              {proc.is_idle ? (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                                  {t({ ko: "유휴", en: "Idle", ja: "アイドル", zh: "Idle", de: "Inaktiv" })}
                                </span>
                              ) : (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
                                  {t({ ko: "활성", en: "Active", ja: "稼働中", zh: "Active", de: "Aktiv" })}
                                </span>
                              )}
                            </div>
                            {displayTitle ? (
                              <p className="mt-1 text-[11px] break-all" style={{ color: "var(--th-text-secondary)" }}>
                                {displayTitle}
                              </p>
                            ) : null}
                            <p
                              className="mt-1 overflow-x-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all"
                              style={{ color: "var(--th-text-secondary)" }}
                              title={commandText}
                            >
                              {commandText}
                            </p>
                            <div
                              className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px]"
                              style={{ color: "var(--th-text-muted)" }}
                            >
                              <span>
                                {t({ ko: "담당", en: "Agent", ja: "担当", zh: "Agent", de: "Agent" })}: {agentName}
                              </span>
                              <span>
                                {t({ ko: "작업", en: "Task", ja: "タスク", zh: "Task", de: "Aufgabe" })}:{" "}
                                {proc.task_status || "-"}
                              </span>
                              <span>Idle: {fmtElapsed(proc.idle_seconds)}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleKillCliProcess(proc.pid)}
                            disabled={isKilling}
                            className={`flex-shrink-0 rounded border px-2 py-1 text-[11px] font-medium transition ${
                              isKilling
                                ? "cursor-not-allowed opacity-40"
                                : "border-red-500/40 bg-red-600/15 text-red-300 hover:bg-red-600/25"
                            }`}
                          >
                            {isKilling
                              ? t({
                                  ko: "중지 중...",
                                  en: "Killing...",
                                  ja: "停止中...",
                                  zh: "Killing...",
                                  de: "Wird beendet...",
                                })
                              : t({ ko: "Kill", en: "Kill", ja: "Kill", zh: "Kill", de: "Kill" })}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
              </div>
            </div>
          ) : activeAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="mb-2 text-3xl opacity-40">&#x1F634;</span>
              <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "현재 작업 중인 에이전트가 없습니다",
                  en: "No agents currently working",
                  ja: "現在作業中のエージェントなし",
                  zh: "No agents currently working",
                  de: "Derzeit keine aktiven Agenten",
                })}
              </p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--th-border)" }}>
              {activeAgents.map((ag) => {
                const fullAgent = agents.find((a) => a.id === ag.id);
                const agentName = localeName(uiLanguage, ag);
                const deptName = localeName(uiLanguage, { name: ag.dept_name, name_ko: ag.dept_name_ko });
                const isKilling = ag.task_id ? killing.has(ag.task_id) : false;
                const idleText = ag.idle_seconds !== null ? fmtElapsed(ag.idle_seconds) : "-";
                const isIdle = ag.idle_seconds !== null && ag.idle_seconds > 300; // idle for 5+ minutes

                return (
                  <div key={ag.id} className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <AgentAvatar agent={fullAgent} agents={agents} size={40} rounded="xl" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                            {agentName}
                          </span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
                          >
                            {deptName}
                          </span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-muted)" }}
                          >
                            {ag.cli_provider}
                          </span>
                        </div>
                        {ag.task_title && (
                          <p className="mt-0.5 truncate text-xs" style={{ color: "var(--th-text-secondary)" }}>
                            {ag.task_title}
                          </p>
                        )}
                        <div
                          className="mt-1 flex flex-wrap items-center gap-3 text-[11px]"
                          style={{ color: "var(--th-text-muted)" }}
                        >
                          {ag.has_active_process ? (
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                              {t({
                                ko: "프로세스 활성",
                                en: "Process active",
                                ja: "プロセス実行中",
                                zh: "Process active",
                                de: "Prozess aktiv",
                              })}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                              {t({
                                ko: "프로세스 없음",
                                en: "No process",
                                ja: "プロセスなし",
                                zh: "No process",
                                de: "Kein Prozess",
                              })}
                            </span>
                          )}
                          <span>
                            {t({
                              ko: "마지막 응답",
                              en: "Last activity",
                              ja: "最終応答",
                              zh: "Last activity",
                              de: "Letzte Aktivität",
                            })}
                            : {fmtTime(ag.last_activity_at)}
                          </span>
                          <span className={isIdle ? "text-amber-400" : ""}>Idle: {idleText}</span>
                        </div>
                      </div>
                      {ag.task_id && (
                        <button
                          onClick={() => handleKill(ag.task_id!)}
                          disabled={isKilling}
                          className={`flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                            isKilling
                              ? "cursor-not-allowed opacity-40"
                              : "bg-red-600/20 border border-red-500/30 text-red-400 hover:bg-red-600/30"
                          }`}
                        >
                          {isKilling
                            ? t({
                                ko: "중지 중...",
                                en: "Stopping...",
                                ja: "停止中...",
                                zh: "Stopping...",
                                de: "Wird gestoppt...",
                              })
                            : t({ ko: "강제 중지", en: "Kill", ja: "強制停止", zh: "Kill", de: "Kill" })}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-3" style={{ borderColor: "var(--th-border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "5초마다 자동 갱신",
                en: "Auto-refresh every 5s",
                ja: "5秒ごとに自動更新",
                zh: "Auto-refresh every 5s",
                de: "Automatische Aktualisierung alle 5 Sek.",
              })}
            </span>
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-sm font-medium transition"
              style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
            >
              {t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
