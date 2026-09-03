interface TokenBarsProps {
  inputTokens: number;
  outputTokens: number;
  maxInput?: number;
  maxOutput?: number;
  budgetPct?: number;
}

function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function TokenBars({
  inputTokens,
  outputTokens,
  maxInput = 0,
  maxOutput = 0,
  budgetPct,
}: TokenBarsProps) {
  const inPct = maxInput > 0 ? Math.min(100, (inputTokens / maxInput) * 100) : inputTokens > 0 ? 50 : 0;
  const outPct = maxOutput > 0 ? Math.min(100, (outputTokens / maxOutput) * 100) : outputTokens > 0 ? 50 : 0;
  const isWarning = budgetPct != null && budgetPct >= 80;
  const isCritical = budgetPct != null && budgetPct >= 100;

  const barGradient = isCritical
    ? "linear-gradient(90deg, #EF4444, #F87171)"
    : isWarning
      ? "linear-gradient(90deg, #F97316, #FB923C)"
      : "linear-gradient(90deg, var(--accent-dim), var(--accent))";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            color: "var(--text-muted)",
            width: 24,
            fontWeight: 700,
          }}
        >
          IN
        </span>
        <div style={{ flex: 1, height: 4, background: "var(--bg-surface-hover)", borderRadius: 2, overflow: "hidden" }}>
          <div
            style={{
              width: `${inPct}%`,
              height: "100%",
              borderRadius: 2,
              background: barGradient,
              transition: "width 0.5s ease",
            }}
          />
        </div>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "var(--text-secondary)",
            width: 36,
            textAlign: "right" as const,
            fontWeight: 600,
          }}
        >
          {formatTokens(inputTokens)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            color: "var(--text-muted)",
            width: 24,
            fontWeight: 700,
          }}
        >
          OUT
        </span>
        <div style={{ flex: 1, height: 4, background: "var(--bg-surface-hover)", borderRadius: 2, overflow: "hidden" }}>
          <div
            style={{
              width: `${outPct}%`,
              height: "100%",
              borderRadius: 2,
              background: barGradient,
              transition: "width 0.5s ease",
            }}
          />
        </div>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "var(--text-secondary)",
            width: 36,
            textAlign: "right" as const,
            fontWeight: 600,
          }}
        >
          {formatTokens(outputTokens)}
        </span>
      </div>
      {isWarning && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: "JetBrains Mono, monospace",
            color: isCritical ? "#EF4444" : "#F97316",
            background: isCritical ? "rgba(239,68,68,0.1)" : "rgba(249,115,22,0.1)",
            border: `1px solid ${isCritical ? "rgba(239,68,68,0.2)" : "rgba(249,115,22,0.2)"}`,
            borderRadius: 6,
            padding: "4px 8px",
          }}
        >
          {isCritical ? "🛑" : "⚠"} {budgetPct}% budget
        </div>
      )}
    </div>
  );
}
