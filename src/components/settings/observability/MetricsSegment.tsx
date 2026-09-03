import { useCallback, useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { fetchMetricsSummary, fetchMetricTimeSeries, type ObsMetricRow } from "../../../api/observability";
import type { TFunction } from "../types";
import { TIME_RANGES } from "./constants";
import { aggregateToHourlyBuckets, mergeWorkflowBuckets } from "./utils";

export function MetricsSegment({ t }: { t: TFunction }) {
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState(86_400_000); // 24h default
  const [spawnData, setSpawnData] = useState<Array<{ time: string; value: number }>>([]);
  const [workflowData, setWorkflowData] = useState<Array<{ time: string; started: number; completed: number }>>([]);

  // Stabilize `since` — only recompute when timeRange changes, not on every render
  const [sinceTs, setSinceTs] = useState(() => Date.now() - timeRange);
  useEffect(() => {
    setSinceTs(Date.now() - timeRange);
  }, [timeRange]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, spawnRes, startedRes, completedRes] = await Promise.all([
        fetchMetricsSummary(sinceTs),
        fetchMetricTimeSeries("agent.spawn", sinceTs),
        fetchMetricTimeSeries("workflow.started", sinceTs),
        fetchMetricTimeSeries("workflow.completed", sinceTs),
      ]);

      setSummary(summaryRes.summary);

      // Aggregate spawn data into hourly buckets for the chart
      const spawnBuckets = aggregateToHourlyBuckets(spawnRes.data as ObsMetricRow[], sinceTs);
      setSpawnData(spawnBuckets);

      // Merge started/completed into workflow chart data
      const startedBuckets = aggregateToHourlyBuckets(startedRes.data as ObsMetricRow[], sinceTs);
      const completedBuckets = aggregateToHourlyBuckets(completedRes.data as ObsMetricRow[], sinceTs);
      const merged = mergeWorkflowBuckets(startedBuckets, completedBuckets);
      setWorkflowData(merged);
    } catch (err) {
      console.error("[Observability] Failed to load metrics:", err);
    } finally {
      setLoading(false);
    }
  }, [sinceTs]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  return (
    <div className="space-y-4">
      {/* Time range selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({ ko: "기간", en: "Range", ja: "期間", zh: "Range", de: "Zeitraum" })}:
        </span>
        {TIME_RANGES.map((r) => (
          <button
            key={r.label}
            onClick={() => setTimeRange(r.ms)}
            className="rounded px-2 py-1 text-xs font-medium transition-colors"
            style={
              timeRange === r.ms
                ? { background: "var(--th-accent, #3b82f6)", color: "#fff" }
                : { color: "var(--th-text-secondary)" }
            }
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          label={t({
            ko: "워크플로우 시작",
            en: "Workflows Started",
            ja: "ワークフロー開始",
            zh: "Workflows Started",
            de: "Workflows gestartet",
          })}
          value={summary["workflow.started"] ?? 0}
          loading={loading}
        />
        <SummaryCard
          label={t({
            ko: "워크플로우 완료",
            en: "Workflows Completed",
            ja: "ワークフロー完了",
            zh: "Workflows Completed",
            de: "Workflows abgeschlossen",
          })}
          value={summary["workflow.completed"] ?? 0}
          loading={loading}
        />
        <SummaryCard
          label={t({
            ko: "에이전트 생성",
            en: "Agent Spawns",
            ja: "エージェント生成",
            zh: "Agent Spawns",
            de: "Agent-Starts",
          })}
          value={summary["agent.spawn"] ?? 0}
          loading={loading}
        />
      </div>

      {/* Charts */}
      {!loading && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Workflow BarChart */}
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          >
            <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {t({
                ko: "워크플로우 시작/완료",
                en: "Workflow Started / Completed",
                ja: "ワークフロー 開始/完了",
                zh: "Workflow Started / Completed",
                de: "Workflow gestartet / abgeschlossen",
              })}
            </h4>
            {workflowData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={workflowData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--th-text-secondary)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--th-text-secondary)" }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--th-bg-primary)",
                      border: "1px solid var(--th-border)",
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="started" fill="#60a5fa" name="Started" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="completed" fill="#22c55e" name="Completed" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div
                className="flex h-[200px] items-center justify-center text-xs"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {t({ ko: "데이터 없음", en: "No data", ja: "データなし", zh: "No data", de: "Keine Daten" })}
              </div>
            )}
          </div>

          {/* Agent Spawn LineChart */}
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          >
            <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {t({
                ko: "에이전트 생성률",
                en: "Agent Spawn Rate",
                ja: "エージェント生成率",
                zh: "Agent Spawn Rate",
                de: "Agent-Start-Rate",
              })}
            </h4>
            {spawnData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={spawnData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--th-text-secondary)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--th-text-secondary)" }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--th-bg-primary)",
                      border: "1px solid var(--th-border)",
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                  />
                  <Line type="monotone" dataKey="value" stroke="#a78bfa" strokeWidth={2} dot={false} name="Spawns" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div
                className="flex h-[200px] items-center justify-center text-xs"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {t({ ko: "데이터 없음", en: "No data", ja: "データなし", zh: "No data", de: "Keine Daten" })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div
      className="rounded-lg border p-3 text-center"
      style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
    >
      <div className="text-2xl font-bold" style={{ color: "var(--th-text-primary)" }}>
        {loading ? "..." : value.toLocaleString()}
      </div>
      <div className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {label}
      </div>
    </div>
  );
}
