import { useCallback, useEffect, useState } from "react";
import {
  fetchScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  toggleScheduledTask,
  triggerScheduledTask,
  fetchScheduleHistory,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduleHistoryEntry,
} from "../../api/scheduled-tasks";
import { fetchPackRegistry } from "../../api/workflow-packs";
import type { PackRegistryEntry, Department } from "../../types";
import ScheduleModal from "./ScheduleModal";
import { cronToHuman } from "./CronPicker";

interface SchedulesViewProps {
  departments: Department[];
}

function formatTs(ts: number | null, tz?: string): string {
  if (!ts) return "--";
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      options.timeZone = tz;
    } catch {
      // invalid tz — fall back to local time
    }
  }
  return new Date(ts).toLocaleString(undefined, options);
}

export default function SchedulesView({ departments }: SchedulesViewProps) {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [packs, setPacks] = useState<PackRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [modalSchedule, setModalSchedule] = useState<ScheduledTask | null | undefined>(undefined);
  // undefined = closed, null = create mode, ScheduledTask = edit mode

  // History state (keyed by schedule id)
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ScheduleHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchScheduledTasks();
      setSchedules(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    fetchPackRegistry()
      .then(setPacks)
      .catch(() => {});
  }, [load]);

  // Live-refresh when the server broadcasts a schedule change (create/update/delete/toggle).
  useEffect(() => {
    const handler = () => {
      void load();
    };
    window.addEventListener("octooffice:schedules-changed", handler);
    return () => window.removeEventListener("octooffice:schedules-changed", handler);
  }, [load]);

  const handleCreate = useCallback(
    async (input: ScheduledTaskInput) => {
      await createScheduledTask(input);
      await load();
    },
    [load],
  );

  const handleUpdate = useCallback(
    async (input: ScheduledTaskInput) => {
      if (!modalSchedule) return;
      await updateScheduledTask(modalSchedule.id, input);
      await load();
    },
    [modalSchedule, load],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteScheduledTask(id);
      await load();
    },
    [load],
  );

  const handleToggle = useCallback(
    async (id: string) => {
      await toggleScheduledTask(id);
      await load();
    },
    [load],
  );

  const handleTrigger = useCallback(
    async (id: string) => {
      await triggerScheduledTask(id);
      await load();
    },
    [load],
  );

  const handleShowHistory = useCallback(
    async (id: string) => {
      if (expandedHistory === id) {
        setExpandedHistory(null);
        return;
      }
      setExpandedHistory(id);
      setHistoryLoading(true);
      try {
        const entries = await fetchScheduleHistory(id);
        setHistoryEntries(entries);
      } catch {
        setHistoryEntries([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    [expandedHistory],
  );

  const deptMap = new Map(departments.map((d) => [d.id, d.name]));
  const packMap = new Map(packs.map((p) => [p.key, p.name.en ?? p.key]));

  const badgeStyle = (bg: string, color: string): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 600,
    background: bg,
    color,
    whiteSpace: "nowrap",
  });

  if (loading) {
    return (
      <div
        style={{
          padding: 24,
          color: "var(--th-text-tertiary)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
        Loading schedules...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 14,
            color: "var(--th-text-primary)",
          }}
        >
          SCHEDULES
        </h1>
        <button
          type="button"
          onClick={() => setModalSchedule(null)}
          className="bg-blue-600 hover:bg-blue-500"
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "none",
            color: "#fff",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 120ms",
          }}
        >
          + New Schedule
        </button>
      </div>

      {error && (
        <div
          style={{
            color: "#ef4444",
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            padding: "8px 12px",
            background: "rgba(239,68,68,0.1)",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {schedules.length === 0 && !error && (
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "var(--th-text-tertiary)",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 12 }}>{"\u{1F570}"}</div>
          <div
            style={{
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 12,
              marginBottom: 8,
              color: "var(--th-text-secondary)",
            }}
          >
            No schedules yet
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
            Create a schedule to automate recurring tasks.
          </div>
        </div>
      )}

      {/* Schedule cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {schedules.map((s) => (
          <div
            key={s.id}
            style={{
              background: "var(--th-card-bg)",
              border: "1px solid var(--th-card-border)",
              borderRadius: 10,
              padding: 16,
            }}
          >
            {/* Top row */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              {/* Status dot */}
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: s.enabled ? "#22c55e" : "#6b7280",
                  flexShrink: 0,
                  boxShadow: s.enabled ? "0 0 6px rgba(34,197,94,0.4)" : "none",
                }}
              />
              {/* Title */}
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--th-text-primary)",
                  flex: 1,
                }}
              >
                {s.title}
              </span>
              {/* Action buttons */}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => handleToggle(s.id)}
                  title={s.enabled ? "Disable" : "Enable"}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--th-card-border)",
                    background: s.enabled ? "rgba(34,197,94,0.15)" : "var(--th-input-bg)",
                    color: s.enabled ? "#22c55e" : "var(--th-text-tertiary)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {s.enabled ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  onClick={() => handleTrigger(s.id)}
                  title="Run Now"
                  style={{
                    padding: "3px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--th-card-border)",
                    background: "var(--th-input-bg)",
                    color: "var(--th-text-secondary)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {"\u25B6"}
                </button>
                <button
                  type="button"
                  onClick={() => setModalSchedule(s)}
                  title="Edit"
                  style={{
                    padding: "3px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--th-card-border)",
                    background: "var(--th-input-bg)",
                    color: "var(--th-text-secondary)",
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleShowHistory(s.id)}
                  title="History"
                  style={{
                    padding: "3px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--th-card-border)",
                    background: expandedHistory === s.id ? "var(--th-bg-surface-hover)" : "var(--th-input-bg)",
                    color: "var(--th-text-secondary)",
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  Log
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  title="Delete"
                  style={{
                    padding: "3px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--th-card-border)",
                    background: "var(--th-input-bg)",
                    color: "#ef4444",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {"\u2715"}
                </button>
              </div>
            </div>

            {/* Schedule info */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <span
                style={{
                  color: "var(--th-text-secondary)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                }}
              >
                {cronToHuman(s.cron_expression)}
              </span>
              <span
                style={{
                  color: "var(--th-text-tertiary)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                }}
              >
                {s.cron_expression}
              </span>
            </div>

            {/* Badges + timestamps */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {s.workflow_pack_key && (
                <span style={badgeStyle("rgba(59,130,246,0.15)", "#60a5fa")}>
                  {packMap.get(s.workflow_pack_key) ?? s.workflow_pack_key}
                </span>
              )}
              {s.department_id && (
                <span style={badgeStyle("rgba(168,85,247,0.15)", "#c084fc")}>
                  {deptMap.get(s.department_id) ?? s.department_id}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span
                style={{ color: "var(--th-text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}
              >
                Next: {formatTs(s.next_run_at, s.timezone)}
              </span>
              <span
                style={{ color: "var(--th-text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}
              >
                Last: {formatTs(s.last_run_at, s.timezone)}
              </span>
            </div>

            {/* Expandable history */}
            {expandedHistory === s.id && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: "1px solid var(--th-card-border)",
                }}
              >
                <span
                  style={{
                    color: "var(--th-text-tertiary)",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.05em",
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  RUN HISTORY
                </span>
                {historyLoading && <span style={{ color: "var(--th-text-tertiary)", fontSize: 11 }}>Loading...</span>}
                {!historyLoading && historyEntries.length === 0 && (
                  <span style={{ color: "var(--th-text-tertiary)", fontSize: 11 }}>No runs yet.</span>
                )}
                {!historyLoading &&
                  historyEntries.map((h) => (
                    <div
                      key={h.id}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                        padding: "4px 0",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background:
                            h.status === "completed"
                              ? "#22c55e"
                              : h.status === "failed"
                                ? "#ef4444"
                                : "var(--th-text-tertiary)",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: "var(--th-text-secondary)", flex: 1 }}>{h.title}</span>
                      <span style={{ color: "var(--th-text-tertiary)", fontSize: 10 }}>{h.status}</span>
                      <span style={{ color: "var(--th-text-tertiary)", fontSize: 10 }}>{formatTs(h.created_at)}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modal */}
      {modalSchedule !== undefined && (
        <ScheduleModal
          schedule={modalSchedule}
          packs={packs}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          onSave={modalSchedule ? handleUpdate : handleCreate}
          onClose={() => setModalSchedule(undefined)}
        />
      )}
    </div>
  );
}
