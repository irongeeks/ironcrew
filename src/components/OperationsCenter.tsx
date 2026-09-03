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
type LocaleKey = "en" | "de" | "ko" | "ja";

const I18N = {
  title: {
    en: "Unified Operations Center",
    de: "Vereinheitlichtes Operations Center",
    ko: "통합 운영 센터",
    ja: "統合オペレーションセンター",
  },
  subtitle: {
    en: "Live sessions, nodes, and operational alerts.",
    de: "Live-Sessions, Nodes und operative Warnungen.",
    ko: "실시간 세션, 노드, 운영 알림을 한 화면에서 봅니다.",
    ja: "ライブセッション・ノード・運用アラートを一画面で確認します。",
  },
  refresh: { en: "Refresh", de: "Aktualisieren", ko: "새로고침", ja: "更新" },
  refreshing: { en: "Refreshing...", de: "Aktualisiere...", ko: "갱신 중...", ja: "更新中..." },
  sessionStream: { en: "Session Stream", de: "Session-Stream", ko: "세션 스트림", ja: "セッションストリーム" },
  nodes: { en: "Node Grid", de: "Node-Grid", ko: "노드 그리드", ja: "ノードグリッド" },
  alerts: { en: "Alert Feed", de: "Alarm-Feed", ko: "알림 피드", ja: "アラートフィード" },
  emptySessions: {
    en: "No active sessions",
    de: "Keine aktiven Sessions",
    ko: "활성 세션이 없습니다",
    ja: "アクティブなセッションはありません",
  },
  emptyNodes: { en: "No nodes found", de: "Keine Nodes gefunden", ko: "노드가 없습니다", ja: "ノードがありません" },
  emptyAlerts: {
    en: "No operational alerts",
    de: "Keine operativen Warnungen",
    ko: "운영 알림이 없습니다",
    ja: "運用アラートはありません",
  },
  kill: { en: "Kill", de: "Beenden", ko: "강제종료", ja: "強制終了" },
  killing: { en: "Killing...", de: "Beende...", ko: "종료 중...", ja: "終了中..." },
  edit: { en: "Edit", de: "Bearbeiten", ko: "편집", ja: "編集" },
  drain: { en: "Drain", de: "Drain", ko: "드레인", ja: "ドレイン" },
  draining: { en: "Draining...", de: "Drain...", ko: "드레인 중...", ja: "ドレイン中..." },
  status: { en: "Status", de: "Status", ko: "상태", ja: "状態" },
  task: { en: "Task", de: "Task", ko: "태스크", ja: "タスク" },
  subtasks: { en: "Subtasks", de: "Subtasks", ko: "서브태스크", ja: "サブタスク" },
  allocations: { en: "Alloc", de: "Allok", ko: "할당", ja: "割当" },
  updated: { en: "Updated", de: "Aktualisiert", ko: "업데이트", ja: "更新" },
  showLogs: { en: "Show logs", de: "Logs zeigen", ko: "로그 보기", ja: "ログ表示" },
  hideLogs: { en: "Hide logs", de: "Logs ausblenden", ko: "로그 숨기기", ja: "ログ非表示" },
  loadingLogs: { en: "Loading logs...", de: "Lade Logs...", ko: "로그 불러오는 중...", ja: "ログ読み込み中..." },
  noLogs: {
    en: "No terminal output yet",
    de: "Noch keine Terminal-Ausgabe",
    ko: "아직 터미널 출력이 없습니다",
    ja: "端末出力はまだありません",
  },
  logPath: { en: "Log path", de: "Log-Pfad", ko: "로그 경로", ja: "ログパス" },
  capacity: { en: "Capacity", de: "Kapazität", ko: "용량", ja: "容量" },
  queue: { en: "Queue", de: "Warteschlange", ko: "대기열", ja: "キュー" },
  health: { en: "Health", de: "Gesundheit", ko: "헬스", ja: "ヘルス" },
  source: { en: "Source", de: "Quelle", ko: "소스", ja: "ソース" },
} as const;

function resolveLocale(language: string, locale: string): LocaleKey {
  const langCode = (language || "").toLowerCase();
  if (langCode === "ko") return "ko";
  if (langCode === "ja") return "ja";
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
              operations
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
