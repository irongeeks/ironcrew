import LocalizedText from "./LocalizedText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  drainOperationNode,
  getOperationsAlerts,
  getOperationsNodes,
  getOperationsSessions,
  killOperationTask,
} from "../api";
import { useI18n } from "../i18n";
import type { OperationsAlert, OperationsNode, OperationsSession, WSEventType } from "../types";
import AlertFeed from "./operations/AlertFeed";
import NodeGrid from "./operations/NodeGrid";
import SessionStream from "./operations/SessionStream";

type SocketOn = (event: WSEventType, handler: (payload: unknown) => void) => () => void;
type LocaleKey = "en" | "de";

const I18N = {
  title: { en: "Unified Operations Center", de: "Vereinheitlichtes Operations Center" },
  subtitle: {
    en: "Live sessions, nodes, and operational alerts.",
    de: "Live-Sessions, Nodes und operative Warnungen.",
  },
  refresh: { en: "Refresh", de: "Aktualisieren" },
  refreshing: { en: "Refreshing...", de: "Aktualisiere..." },
  sessionStream: { en: "Session Stream", de: "Session-Stream" },
  nodes: { en: "Node Grid", de: "Node-Grid" },
  alerts: { en: "Alert Feed", de: "Alarm-Feed" },
  emptySessions: { en: "No active sessions", de: "Keine aktiven Sessions" },
  emptyNodes: { en: "No nodes found", de: "Keine Nodes gefunden" },
  emptyAlerts: { en: "No operational alerts", de: "Keine operativen Warnungen" },
  kill: { en: "Kill", de: "Beenden" },
  killing: { en: "Killing...", de: "Beende..." },
  edit: { en: "Edit", de: "Bearbeiten" },
  drain: { en: "Drain", de: "Auslaufen lassen" },
  draining: { en: "Draining...", de: "Drain..." },
  status: { en: "Status", de: "Status" },
  task: { en: "Task", de: "Aufgabe" },
  subtasks: { en: "Subtasks", de: "Teilaufgaben" },
  allocations: { en: "Alloc", de: "Allok" },
  updated: { en: "Updated", de: "Aktualisiert" },
  showLogs: { en: "Show logs", de: "Logs zeigen" },
  hideLogs: { en: "Hide logs", de: "Logs ausblenden" },
  loadingLogs: { en: "Loading logs...", de: "Lade Logs..." },
  noLogs: { en: "No terminal output yet", de: "Noch keine Terminal-Ausgabe" },
  logPath: { en: "Log path", de: "Log-Pfad" },
  capacity: { en: "Capacity", de: "Kapazität" },
  queue: { en: "Queue", de: "Warteschlange" },
  health: { en: "Health", de: "Gesundheit" },
  source: { en: "Source", de: "Quelle" },
} as const;

function resolveLocale(language: string, locale: string): LocaleKey {
  const langCode = (language || "").toLowerCase();
  if (langCode === "de") return "de";
  const localeCode = (locale || "").toLowerCase();
  if (localeCode.startsWith("de")) return "de";
  return "en";
}

interface OperationsCenterProps {
  socketOn: SocketOn;
  onNavigateToServerSettings?: (serverId: string) => void;
}

export default function OperationsCenter({ socketOn, onNavigateToServerSettings }: OperationsCenterProps) {
  const { language, locale } = useI18n();
  const [sessions, setSessions] = useState<OperationsSession[]>([]);
  const [nodes, setNodes] = useState<OperationsNode[]>([]);
  const [alerts, setAlerts] = useState<OperationsAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const wsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localeKey = resolveLocale(language, locale);
  const tx = useCallback((key: keyof typeof I18N) => I18N[key][localeKey], [localeKey]);
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    [locale],
  );

  const formatTime = useCallback(
    (ts: number | null) => {
      if (!ts || !Number.isFinite(ts)) return "-";
      return timeFormatter.format(new Date(ts));
    },
    [timeFormatter],
  );

  const refreshAll = useCallback(async () => {
    const [nextSessions, nextNodes, nextAlerts] = await Promise.all([
      getOperationsSessions(),
      getOperationsNodes(),
      getOperationsAlerts(),
    ]);
    setSessions(nextSessions);
    setNodes(nextNodes);
    setAlerts(nextAlerts);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    handleRefresh().catch(() => setLoading(false));
  }, [handleRefresh]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (wsRefreshTimerRef.current) return;
      wsRefreshTimerRef.current = setTimeout(() => {
        wsRefreshTimerRef.current = null;
        void refreshAll();
      }, 120);
    };

    const offTask = socketOn("task_update", scheduleRefresh);
    const offSubtask = socketOn("subtask_update", scheduleRefresh);
    const offServer = socketOn("server_update", scheduleRefresh);
    return () => {
      offTask();
      offSubtask();
      offServer();
      if (!wsRefreshTimerRef.current) return;
      clearTimeout(wsRefreshTimerRef.current);
      wsRefreshTimerRef.current = null;
    };
  }, [refreshAll, socketOn]);

  const handleKillTask = useCallback(
    async (taskId: string) => {
      setBusyTaskId(taskId);
      try {
        await killOperationTask(taskId);
        await refreshAll();
      } finally {
        setBusyTaskId(null);
      }
    },
    [refreshAll],
  );

  const handleDrainNode = useCallback(
    async (nodeId: string) => {
      setBusyNodeId(nodeId);
      try {
        await drainOperationNode(nodeId);
        await refreshAll();
      } finally {
        setBusyNodeId(null);
      }
    },
    [refreshAll],
  );

  return (
    <section className="space-y-4">
      <header
        className="rounded-xl border px-5 py-4"
        style={{ borderColor: "var(--border)", background: "var(--bg-elevated, #111113)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p
              className="text-[8px] uppercase tracking-[0.05em]"
              style={{
                fontFamily: "'Press Start 2P', monospace",
                color: "var(--text-muted, #71717a)",
              }}
            >
              <LocalizedText en="operations" de="Vorgänge" />
            </p>
            <h1 className="mt-2 text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary, #e4e4e7)" }}>
              {tx("title")}
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary, #a1a1aa)" }}>
              {tx("subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={refreshing}
            className="rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-surface-hover)",
              color: "var(--text-primary, #e4e4e7)",
            }}
          >
            {refreshing ? tx("refreshing") : tx("refresh")}
          </button>
        </div>
      </header>

      {loading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <div
            className="h-48 animate-pulse rounded-xl border"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          />
          <div
            className="h-48 animate-pulse rounded-xl border"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <SessionStream
            title={tx("sessionStream")}
            sessions={sessions}
            emptyLabel={tx("emptySessions")}
            killLabel={tx("kill")}
            killingLabel={tx("killing")}
            statusLabel={tx("status")}
            taskLabel={tx("task")}
            subtasksLabel={tx("subtasks")}
            allocationsLabel={tx("allocations")}
            updatedLabel={tx("updated")}
            onKill={handleKillTask}
            busyTaskId={busyTaskId}
            formatTime={formatTime}
            showLogsLabel={tx("showLogs")}
            hideLogsLabel={tx("hideLogs")}
            loadingLogsLabel={tx("loadingLogs")}
            noLogsLabel={tx("noLogs")}
            logPathLabel={tx("logPath")}
          />

          <div className="space-y-4">
            <NodeGrid
              title={tx("nodes")}
              nodes={nodes}
              emptyLabel={tx("emptyNodes")}
              drainLabel={tx("drain")}
              drainingLabel={tx("draining")}
              capacityLabel={tx("capacity")}
              queueLabel={tx("queue")}
              healthLabel={tx("health")}
              onDrain={handleDrainNode}
              onEdit={(nodeId) => onNavigateToServerSettings?.(nodeId)}
              editLabel={tx("edit")}
              busyNodeId={busyNodeId}
              formatTime={formatTime}
            />
            <AlertFeed
              title={tx("alerts")}
              alerts={alerts}
              emptyLabel={tx("emptyAlerts")}
              sourceLabel={tx("source")}
              updatedLabel={tx("updated")}
              formatTime={formatTime}
            />
          </div>
        </div>
      )}
    </section>
  );
}
