import React from "react";

interface TokenDonutProps {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  budgetTotal?: number;
  size?: number;
}

const TokenDonut = React.memo(function TokenDonut({
  inputTokens,
  outputTokens,
  cacheTokens,
  budgetTotal,
  size = 58,
}: TokenDonutProps) {
  const total = inputTokens + outputTokens + cacheTokens;
  const budget = budgetTotal ?? total;
  const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : 0;

  const r = 26;
  const C = 2 * Math.PI * r;
  const inputArc = budget > 0 ? (inputTokens / budget) * C : 0;
  const outputArc = budget > 0 ? (outputTokens / budget) * C : 0;
  const cacheArc = budget > 0 ? (cacheTokens / budget) * C : 0;

  const startOffset = C * 0.25;

  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="5" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="5"
        strokeDasharray={`${inputArc} ${C}`}
        strokeDashoffset={startOffset}
        strokeLinecap="round"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="#FBBF24"
        strokeWidth="5"
        strokeDasharray={`${outputArc} ${C}`}
        strokeDashoffset={startOffset - inputArc}
        strokeLinecap="round"
      />
      {cacheArc > 0 && (
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#3f3f46"
          strokeWidth="5"
          strokeDasharray={`${cacheArc} ${C}`}
          strokeDashoffset={startOffset - inputArc - outputArc}
          strokeLinecap="round"
        />
      )}
      <text
        x="32"
        y="29"
        textAnchor="middle"
        fill="var(--text-primary, #e4e4e7)"
        fontFamily="JetBrains Mono, monospace"
        fontSize="12"
        fontWeight="800"
      >
        {pct}%
      </text>
      <text
        x="32"
        y="40"
        textAnchor="middle"
        fill="var(--text-muted, #71717a)"
        fontFamily="JetBrains Mono, monospace"
        fontSize="7"
        fontWeight="600"
      >
        BUDGET
      </text>
    </svg>
  );
});

export default TokenDonut;
