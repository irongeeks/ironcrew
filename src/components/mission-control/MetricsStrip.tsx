import React, { useMemo, useEffect, useState } from "react";
import type { Agent, Task, Department } from "../../types";
import type { ProviderTokenData } from "../../hooks/useTokenUsage";
import TokenDonut from "./TokenDonut";

interface MetricsStripProps {
  tasks: Task[];
  agents: Agent[];
  departments: Department[];
  providerData: ProviderTokenData | null;
}

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

const MetricsStrip = React.memo(function MetricsStrip({ tasks, agents, departments, providerData }: MetricsStripProps) {
  const isMobile = useIsMobile();

  const { completedToday, completedWeek, successRate, recentCount } = useMemo(() => {
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const _completedToday = tasks.filter(
      (t) => t.status === "done" && t.completed_at != null && nowMs - t.completed_at < dayMs,
    ).length;
    const _completedWeek = tasks.filter(
      (t) => t.status === "done" && t.completed_at != null && nowMs - t.completed_at < dayMs * 7,
    ).length;

    const recent = [...tasks]
      .filter((t) => t.status === "done" || t.status === "cancelled")
      .sort((a, b) => (b.completed_at ?? b.updated_at) - (a.completed_at ?? a.updated_at))
      .slice(0, 25);
    const _successRate =
      recent.length > 0 ? Math.round((recent.filter((t) => t.status === "done").length / recent.length) * 100) : 0;

    return {
      completedToday: _completedToday,
      completedWeek: _completedWeek,
      successRate: _successRate,
      recentCount: recent.length,
    };
  }, [tasks]);

  const totalInput = providerData?.providers.reduce((s, p) => s + (p.total_input ?? 0), 0) ?? 0;
  const totalOutput = providerData?.providers.reduce((s, p) => s + (p.total_output ?? 0), 0) ?? 0;

  const deptCounts = useMemo(
    () =>
      departments.map((d) => ({
        name: d.name,
        count: agents.filter((a) => a.department_id === d.id && a.status === "working").length,
      })),
    [departments, agents],
  );

  const DEPT_COLORS = ["var(--accent)", "#FBBF24", "#F97316", "#EF4444", "#60a5fa", "#a855f7", "#ec4899", "#14b8a6"];

  // On mobile: 2-column grid (Token Usage spans full width, then 3 stats in row/wrap)
  // On desktop: single row with flex ratios
  const mc: React.CSSProperties = isMobile
    ? {
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 12,
      }
    : {
        flex: 1,
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 14,
      };

  const mcLabel: React.CSSProperties = {
    fontFamily: "'Press Start 2P', monospace",
    fontSize: 7,
    color: "var(--text-muted)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: 10,
  };

  if (isMobile) {
    return (
      <div style={{ padding: "12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Token Usage — full width on mobile */}
        <div style={{ ...mc }}>
          <div style={mcLabel}>Token Usage</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <TokenDonut inputTokens={totalInput} outputTokens={totalOutput} cacheTokens={0} />
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 2 }}>
              <div>
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    marginRight: 6,
                  }}
                />
                Input <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{fmtK(totalInput)}</span>
              </div>
              <div>
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#FBBF24",
                    marginRight: 6,
                  }}
                />
                Output <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{fmtK(totalOutput)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 2-column row: Today + Success */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={mc}>
            <div style={mcLabel}>Today</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1, color: "var(--accent)" }}>{completedToday}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{completedWeek} this week</div>
          </div>
          <div style={mc}>
            <div style={mcLabel}>Success</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1, color: "var(--text-secondary)" }}>
              {successRate}%
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>last {recentCount} tasks</div>
          </div>
        </div>

        {/* Departments — full width */}
        <div style={mc}>
          <div style={mcLabel}>Departments</div>
          <div style={{ marginTop: 6 }}>
            {deptCounts.slice(0, 4).map((d, i) => (
              <div
                key={d.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  padding: "3px 0",
                }}
              >
                <span style={{ width: 64, fontWeight: 600 }}>{d.name}</span>
                <div
                  style={{
                    flex: 1,
                    height: 4,
                    background: "var(--bg-surface-hover)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, d.count * 25)}%`,
                      height: "100%",
                      borderRadius: 2,
                      background: DEPT_COLORS[i % DEPT_COLORS.length],
                    }}
                  />
                </div>
                <span style={{ width: 20, textAlign: "right" as const, color: "var(--text-primary)", fontWeight: 700 }}>
                  {d.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Desktop layout — unchanged
  return (
    <div style={{ padding: "16px 18px", display: "flex", gap: 12 }}>
      {/* Token Usage (wide) */}
      <div style={{ ...mc, flex: 2.5 }}>
        <div style={mcLabel}>Token Usage</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <TokenDonut inputTokens={totalInput} outputTokens={totalOutput} cacheTokens={0} />
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 2 }}>
            <div>
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  marginRight: 6,
                }}
              />
              Input <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{fmtK(totalInput)}</span>
            </div>
            <div>
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#FBBF24",
                  marginRight: 6,
                }}
              />
              Output <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{fmtK(totalOutput)}</span>
            </div>
          </div>
          {/* Provider breakdown */}
          {providerData && providerData.providers.length > 0 && (
            <div
              style={{
                borderLeft: "1px solid var(--border)",
                paddingLeft: 14,
                marginLeft: 6,
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              {providerData.providers.slice(0, 3).map((p) => (
                <div
                  key={p.provider}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)" }}
                >
                  <span style={{ width: 48, fontWeight: 600 }}>{p.provider}</span>
                  <div
                    style={{
                      flex: 1,
                      height: 4,
                      background: "var(--bg-surface-hover)",
                      borderRadius: 2,
                      overflow: "hidden",
                      minWidth: 40,
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, totalInput > 0 ? (p.total_input / totalInput) * 100 : 0)}%`,
                        height: "100%",
                        borderRadius: 2,
                        background: "linear-gradient(90deg, var(--accent-dim), var(--accent))",
                      }}
                    />
                  </div>
                  <span
                    style={{ width: 36, textAlign: "right" as const, color: "var(--text-primary)", fontWeight: 700 }}
                  >
                    {fmtK(p.total_input + p.total_output)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Today */}
      <div style={mc}>
        <div style={mcLabel}>Today</div>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: "var(--accent)" }}>{completedToday}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{completedWeek} this week</div>
      </div>

      {/* Success */}
      <div style={mc}>
        <div style={mcLabel}>Success</div>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: "var(--text-secondary)" }}>
          {successRate}%
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>last {recentCount} tasks</div>
      </div>

      {/* Departments */}
      <div style={mc}>
        <div style={mcLabel}>Departments</div>
        <div style={{ marginTop: 6 }}>
          {deptCounts.slice(0, 4).map((d, i) => (
            <div
              key={d.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--text-secondary)",
                padding: "3px 0",
              }}
            >
              <span style={{ width: 64, fontWeight: 600 }}>{d.name}</span>
              <div
                style={{
                  flex: 1,
                  height: 4,
                  background: "var(--bg-surface-hover)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, d.count * 25)}%`,
                    height: "100%",
                    borderRadius: 2,
                    background: DEPT_COLORS[i % DEPT_COLORS.length],
                  }}
                />
              </div>
              <span style={{ width: 20, textAlign: "right" as const, color: "var(--text-primary)", fontWeight: 700 }}>
                {d.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default MetricsStrip;

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
