import React, { useState } from "react";
import type { Agent, AgentStatus } from "../../types";
import { useBulkAgentTokenUsage, type TokenTotals } from "../../hooks/useTokenUsage";
import TokenBars from "./TokenBars";

function charAvatarPath(agent: Agent): string {
  const idx =
    agent.sprite_number != null && agent.sprite_number >= 0 && agent.sprite_number < 40
      ? agent.sprite_number
      : Math.abs([...agent.id].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 40;
  return `/assets/characters/${String(idx).padStart(3, "0")}.png`;
}

interface AgentSidebarPanelProps {
  agents: Agent[];
  onAgentClick?: (agent: Agent) => void;
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  working: 0,
  break: 1,
  idle: 2,
  offline: 3,
};

const STATUS_DOT_COLOR: Record<AgentStatus, string> = {
  working: "var(--accent)",
  break: "#F97316",
  idle: "#6B7280",
  offline: "#374151",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  break: "Break",
  idle: "Idle",
  offline: "Offline",
};

const ROLE_LABEL: Record<string, string> = {
  team_leader: "Lead",
  senior: "Senior",
  junior: "Junior",
  intern: "Intern",
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: "#A78BFA",
  codex: "#60A5FA",
  gemini: "var(--accent)",
  opencode: "#F472B6",
  copilot: "#38BDF8",
  antigravity: "#FB923C",
  openclaw: "#FBBF24",
  api: "#94A3B8",
};

const AgentCard = React.memo(function AgentCard({
  agent,
  tokenTotals,
  onClick,
}: {
  agent: Agent;
  tokenTotals?: TokenTotals;
  onClick?: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const isWorking = agent.status === "working";
  const providerColor = PROVIDER_COLORS[agent.cli_provider] ?? "#94A3B8";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        width: "100%",
        textAlign: "left",
        background: isWorking ? "var(--accent-glow)" : "var(--bg-surface)",
        border: `1px solid ${isWorking ? "var(--accent-dim)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "10px 10px 8px",
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {/* Avatar */}
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            flexShrink: 0,
            overflow: "hidden",
            border: `1px solid ${isWorking ? "var(--accent-dim)" : "var(--border)"}`,
            background: isWorking ? "var(--accent-subtle)" : "var(--bg-surface)",
            display: imgFailed ? "flex" : "block",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
          }}
        >
          {imgFailed ? (
            (agent.avatar_emoji ?? "🤖")
          ) : (
            <img
              src={charAvatarPath(agent)}
              alt={agent.name}
              style={{
                width: 32,
                height: 48,
                objectFit: "cover",
                objectPosition: "top center",
                imageRendering: "pixelated",
              }}
              onError={() => setImgFailed(true)}
            />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              fontWeight: 700,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}
          >
            {agent.name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9,
                fontWeight: 600,
                color: "var(--text-muted)",
                textTransform: "uppercase",
              }}
            >
              {ROLE_LABEL[agent.role] ?? agent.role}
            </span>
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 8,
                fontWeight: 700,
                color: providerColor,
                background: `${providerColor}18`,
                border: `1px solid ${providerColor}30`,
                borderRadius: 4,
                padding: "1px 5px",
                textTransform: "uppercase",
              }}
            >
              {agent.cli_provider ?? "api"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: STATUS_DOT_COLOR[agent.status] ?? "#6B7280",
                flexShrink: 0,
                boxShadow: isWorking ? "0 0 6px var(--accent-glow)" : "none",
              }}
            />
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9,
                fontWeight: 600,
                color: isWorking ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              {STATUS_LABEL[agent.status] ?? agent.status}
            </span>
          </div>
        </div>
      </div>

      {tokenTotals && (
        <div style={{ marginTop: 2 }}>
          <TokenBars inputTokens={tokenTotals.input_tokens} outputTokens={tokenTotals.output_tokens} />
        </div>
      )}
    </button>
  );
});

export default function AgentSidebarPanel({ agents, onAgentClick }: AgentSidebarPanelProps) {
  const agentIds = agents.map((a) => a.id);
  const tokenMap = useBulkAgentTokenUsage(agentIds);

  const sorted = [...agents].sort((a, b) => {
    const orderA = STATUS_ORDER[a.status] ?? 99;
    const orderB = STATUS_ORDER[b.status] ?? 99;
    return orderA - orderB;
  });

  const workingCount = agents.filter((a) => a.status === "working").length;

  return (
    <div
      style={{
        width: 270,
        minWidth: 270,
        maxWidth: 270,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface-solid)",
        borderRight: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 14px 10px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 9,
            color: "var(--text-primary)",
            letterSpacing: "0.05em",
          }}
        >
          AGENTS
        </span>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            fontWeight: 700,
            color: workingCount > 0 ? "var(--accent)" : "var(--text-muted)",
            background: workingCount > 0 ? "var(--accent-subtle)" : "var(--bg-surface-hover)",
            border: `1px solid ${workingCount > 0 ? "var(--accent-dim)" : "var(--border)"}`,
            borderRadius: 10,
            padding: "2px 8px",
          }}
        >
          {workingCount}/{agents.length}
        </span>
      </div>

      {/* Scrollable agent list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {sorted.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            tokenTotals={tokenMap.get(agent.id)}
            onClick={onAgentClick ? () => onAgentClick(agent) : undefined}
          />
        ))}

        {agents.length === 0 && (
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "var(--text-muted)",
              textAlign: "center",
              padding: "24px 0",
            }}
          >
            No agents
          </div>
        )}
      </div>
    </div>
  );
}
