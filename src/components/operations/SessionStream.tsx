import { useCallback, useEffect, useMemo, useState } from "react";
import { getTerminal } from "../../api";
import type { OperationsSession } from "../../types";

export interface SessionStreamProps {
  title: string;
  sessions: OperationsSession[];
  emptyLabel: string;
  killLabel: string;
  killingLabel: string;
  statusLabel: string;
  taskLabel: string;
  subtasksLabel: string;
  allocationsLabel: string;
  updatedLabel: string;
  onKill: (taskId: string) => void;
  busyTaskId: string | null;
  formatTime: (ts: number | null) => string;
  showLogsLabel: string;
  hideLogsLabel: string;
  loadingLogsLabel: string;
  noLogsLabel: string;
  logPathLabel: string;
}

type SessionTerminalState = {
  loading: boolean;
  exists: boolean;
  text: string;
  path: string;
};

export default function SessionStream({
  title,
  sessions,
  emptyLabel,
  killLabel,
  killingLabel,
  statusLabel,
  taskLabel,
  subtasksLabel,
  allocationsLabel,
  updatedLabel,
  onKill,
  busyTaskId,
  formatTime,
  showLogsLabel,
  hideLogsLabel,
  loadingLogsLabel,
  noLogsLabel,
  logPathLabel,
}: SessionStreamProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [terminalByTaskId, setTerminalByTaskId] = useState<Record<string, SessionTerminalState>>({});

  const runningTaskIds = useMemo(
    () =>
      new Set(
        sessions.filter((session) => session.running || session.status === "in_progress").map((session) => session.id),
      ),
    [sessions],
  );

  const fetchTaskTerminal = useCallback(async (taskId: string) => {
    setTerminalByTaskId((prev) => ({
      ...prev,
      [taskId]: {
        ...(prev[taskId] ?? { exists: false, text: "", path: "" }),
        loading: true,
      },
    }));
    try {
      const res = await getTerminal(taskId, 80, true, 60);
      setTerminalByTaskId((prev) => ({
        ...prev,
        [taskId]: {
          loading: false,
          exists: Boolean(res.exists),
          text: res.text ?? "",
          path: res.path ?? "",
        },
      }));
    } catch {
      setTerminalByTaskId((prev) => ({
        ...prev,
        [taskId]: {
          ...(prev[taskId] ?? { exists: false, text: "", path: "" }),
          loading: false,
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!expandedTaskId) return;
    if (!sessions.some((session) => session.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
  }, [expandedTaskId, sessions]);

  useEffect(() => {
    if (!expandedTaskId) return;
    void fetchTaskTerminal(expandedTaskId);
    const isRunning = runningTaskIds.has(expandedTaskId);
    if (!isRunning) return;
    const timer = setInterval(() => {
      void fetchTaskTerminal(expandedTaskId);
    }, 1500);
    return () => clearInterval(timer);
  }, [expandedTaskId, fetchTaskTerminal, runningTaskIds]);

  const toggleLogs = useCallback(
    (taskId: string) => {
      setExpandedTaskId((prev) => (prev === taskId ? null : taskId));
    },
    [setExpandedTaskId],
  );

  return (
    <section
      className="rounded-2xl border p-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-surface-solid, #0f0f11)" }}
    >
      <header
        className="mb-3 flex items-center justify-between border-b pb-2"
        style={{ borderColor: "var(--th-border)" }}
      >
        <h2
          className="text-[9px] uppercase tracking-[0.05em]"
          style={{ fontFamily: "'Press Start 2P', monospace", color: "var(--text-primary, #e4e4e7)" }}
        >
          {title}
        </h2>
        <span
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: "var(--border)", color: "var(--text-secondary, #a1a1aa)" }}
        >
          {sessions.length}
        </span>
      </header>

      {sessions.length <= 0 ? (
        <p
          className="rounded-xl border border-dashed px-4 py-6 text-center text-sm"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const killBusy = busyTaskId === session.id;
            return (
              <article
                key={session.id}
                className="rounded-xl border px-3 py-3 transition-colors hover:border-cyan-500/40"
                style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
              >
                <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                      {session.title}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                      #{session.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleLogs(session.id)}
                      className="rounded-md border px-2 py-1 text-xs font-medium transition"
                      style={{
                        borderColor: "var(--border-strong)",
                        background: "var(--bg-surface-hover)",
                        color: "var(--text-primary, #e4e4e7)",
                      }}
                    >
                      {expandedTaskId === session.id ? hideLogsLabel : showLogsLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => onKill(session.id)}
                      disabled={killBusy}
                      className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {killBusy ? killingLabel : killLabel}
                    </button>
                  </div>
                </div>

                <div
                  className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs lg:grid-cols-4"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{taskLabel}:</span>{" "}
                    {session.running ? "RUN" : "WAIT"}
                  </p>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{statusLabel}:</span> {session.status}
                  </p>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{subtasksLabel}:</span> {session.subtask_done}/
                    {session.subtask_total}
                  </p>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{allocationsLabel}:</span>{" "}
                    {session.active_allocations}
                  </p>
                </div>

                <p className="mt-2 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {updatedLabel}: {formatTime(session.updated_at)}
                </p>
                {expandedTaskId === session.id && (
                  <div
                    className="mt-2 rounded-lg border"
                    style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
                  >
                    {terminalByTaskId[session.id]?.path ? (
                      <p
                        className="border-b px-2 py-1 text-[10px]"
                        style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
                      >
                        {logPathLabel}: {terminalByTaskId[session.id].path}
                      </p>
                    ) : null}
                    {terminalByTaskId[session.id]?.loading ? (
                      <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                        {loadingLogsLabel}
                      </p>
                    ) : terminalByTaskId[session.id]?.exists && terminalByTaskId[session.id]?.text.trim() ? (
                      <pre
                        className="max-h-52 overflow-auto px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                        style={{ color: "var(--th-text-secondary)" }}
                      >
                        {terminalByTaskId[session.id]?.text}
                      </pre>
                    ) : (
                      <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                        {noLogsLabel}
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
