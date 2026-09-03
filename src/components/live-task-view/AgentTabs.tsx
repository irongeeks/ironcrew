import type { Agent } from "../../types";

interface AgentTabsProps {
  // Pre-filtered to working agents by the parent
  agents: Agent[];
  activeAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

export default function AgentTabs({ agents, activeAgentId, onSelectAgent }: AgentTabsProps) {
  if (agents.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        overflowX: "auto",
      }}
    >
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        return (
          <button
            key={agent.id}
            onClick={() => {
              if (!isActive) onSelectAgent(agent.id);
            }}
            style={{
              padding: "8px 12px",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              color: isActive ? "var(--accent)" : "var(--text-muted)",
              background: isActive ? "var(--bg-surface)" : "transparent",
              border: "none",
              borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              transition: "color 0.15s",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
                display: "inline-block",
                boxShadow: isActive ? "0 0 6px var(--accent-glow)" : "none",
              }}
            />
            {agent.name}
          </button>
        );
      })}
      <div
        style={{
          marginLeft: "auto",
          padding: "8px 12px",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 9,
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          letterSpacing: "0.05em",
          opacity: 0.5,
        }}
      >
        LIVE
      </div>
    </div>
  );
}
