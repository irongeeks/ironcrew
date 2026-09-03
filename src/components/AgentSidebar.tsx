import { useMemo } from "react";
import type { Agent, AgentRole, Department } from "../types";

const CHAR_COUNT = 40;

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) | 0;
  return Math.abs(h);
}

function charAvatarPath(agent: Agent): string {
  const idx =
    agent.sprite_number != null && agent.sprite_number >= 0 && agent.sprite_number < CHAR_COUNT
      ? agent.sprite_number
      : stableHash(agent.id) % CHAR_COUNT;
  return `/assets/characters/${String(idx).padStart(3, "0")}.png`;
}

function roleLabel(role: AgentRole): string {
  switch (role) {
    case "team_leader":
      return "Team Leader";
    case "senior":
      return "Senior";
    case "junior":
      return "Junior";
    case "intern":
      return "Intern";
    default:
      return role;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "working":
      return "WORKING";
    case "idle":
      return "IDLE";
    case "break":
      return "BREAK";
    case "offline":
      return "OFFLINE";
    default:
      return status.toUpperCase();
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "working":
      return "#10b981";
    case "break":
      return "#f59e0b";
    case "offline":
      return "#6b7280";
    default:
      return "var(--text-dim, rgba(255,255,255,0.3))";
  }
}

interface AgentSidebarProps {
  agents: Agent[];
  departments: Department[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectAgent: (agent: Agent) => void;
}

export default function AgentSidebar({
  agents,
  departments,
  collapsed,
  onToggleCollapse,
  onSelectAgent,
}: AgentSidebarProps) {
  const deptIds = new Set(departments.map((d) => d.id));
  const visibleAgents = agents.filter((a) => a.department_id && deptIds.has(a.department_id));

  const { working, idle } = useMemo(() => {
    const w: Agent[] = [];
    const i: Agent[] = [];
    for (const a of visibleAgents) {
      if (a.status === "working") w.push(a);
      else i.push(a);
    }
    return { working: w, idle: i };
  }, [visibleAgents]);

  const hasWorking = working.length > 0;

  return (
    <aside
      style={{
        width: collapsed ? 48 : 240,
        minWidth: collapsed ? 48 : 240,
        transition: "width 250ms ease, min-width 250ms ease",
        background: "rgba(24, 24, 48, 0.88)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        height: "100%",
      }}
    >
      {/* Toggle button — inside panel, top-right */}
      <div
        style={{
          display: "flex",
          alignItems: collapsed ? "center" : "flex-end",
          justifyContent: collapsed ? "center" : "flex-end",
          padding: collapsed ? "8px 0" : "8px 8px 0",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggleCollapse}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "transparent",
            border: "1px solid var(--th-border)",
            color: "var(--text-muted)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "background 150ms ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(52,211,153,0.1)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          {collapsed ? "\u2039" : "\u203a"}
        </button>
      </div>

      {/* Collapsed mode: avatar stack */}
      {collapsed && (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            scrollbarWidth: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "8px 0",
          }}
        >
          {visibleAgents.map((agent) => (
            <div
              key={agent.id}
              onClick={() => onSelectAgent(agent)}
              title={agent.name}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                overflow: "hidden",
                flexShrink: 0,
                background: "var(--bg-surface-hover)",
                cursor: "pointer",
                opacity: agent.status === "working" ? 1 : 0.45,
                position: "relative",
                borderLeft: agent.status === "working" ? "2px solid #10b981" : "2px solid transparent",
              }}
            >
              <img
                src={charAvatarPath(agent)}
                alt={agent.name}
                style={{
                  width: 32,
                  height: 48,
                  imageRendering: "pixelated",
                  objectFit: "cover",
                  objectPosition: "top center",
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = "/assets/characters/003.png";
                }}
              />
              {/* Tiny status dot */}
              <span
                style={{
                  position: "absolute",
                  bottom: 2,
                  right: 2,
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: statusColor(agent.status),
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Expanded mode: full detail cards */}
      {!collapsed && (
        <>
          {/* Header */}
          <div
            style={{
              padding: "10px 12px 8px",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {hasWorking && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#10b981",
                  boxShadow: "0 0 8px rgba(16,185,129,0.6)",
                  animation: "pulse-glow 2.5s ease-in-out infinite",
                  flexShrink: 0,
                }}
              />
            )}
            <span
              style={{
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 11,
                color: "var(--text-muted)",
                fontWeight: 400,
              }}
            >
              {visibleAgents.length} agent{visibleAgents.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Agent list */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              scrollbarWidth: "none",
              padding: "0 8px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {visibleAgents.length === 0 && (
              <p
                style={{
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  textAlign: "center",
                  paddingTop: 32,
                }}
              >
                No agents assigned
              </p>
            )}

            {/* Working agents */}
            {working.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onClick={() => onSelectAgent(agent)} />
            ))}

            {/* Divider between working and idle */}
            {working.length > 0 && idle.length > 0 && (
              <div style={{ padding: "4px 0 2px" }}>
                <div
                  style={{
                    height: 1,
                    background: "var(--th-border)",
                    marginBottom: 4,
                  }}
                />
                <span
                  style={{
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontSize: 8,
                    fontWeight: 500,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.16em",
                  }}
                >
                  IDLE
                </span>
              </div>
            )}

            {/* Idle / break agents */}
            {idle.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onClick={() => onSelectAgent(agent)} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

/* ── Agent card ── */

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const isWorking = agent.status === "working";

  return (
    <div
      onClick={onClick}
      style={{
        border: "1px solid var(--th-border)",
        borderLeft: isWorking ? "2px solid #10b981" : "1px solid var(--th-border)",
        borderRadius: 8,
        padding: 10,
        cursor: "pointer",
        opacity: isWorking ? 1 : 0.6,
        transition: "background 120ms ease, opacity 120ms ease",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "var(--bg-surface)";
        if (!isWorking) (e.currentTarget as HTMLDivElement).style.opacity = "0.8";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
        if (!isWorking) (e.currentTarget as HTMLDivElement).style.opacity = "0.6";
      }}
    >
      {/* Top row: avatar + info */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Avatar — 32px, rounded-lg */}
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            overflow: "hidden",
            flexShrink: 0,
            background: "var(--bg-surface-hover)",
          }}
        >
          <img
            src={charAvatarPath(agent)}
            alt={agent.name}
            style={{
              width: 32,
              height: 48,
              imageRendering: "pixelated",
              objectFit: "cover",
              objectPosition: "top center",
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).src = "/assets/characters/003.png";
            }}
          />
        </div>

        {/* Name + role + status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name row with status dot */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                flexShrink: 0,
                background: statusColor(agent.status),
                boxShadow: isWorking ? "0 0 6px rgba(16,185,129,0.5)" : "none",
              }}
            />
            <span
              style={{
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 11,
                fontWeight: 600,
                color: isWorking ? "var(--text-primary)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {agent.name}
            </span>
          </div>

          {/* Role */}
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 10,
              color: "var(--text-muted)",
              marginTop: 1,
            }}
          >
            {roleLabel(agent.role)}
          </div>
        </div>

        {/* Status label */}
        <span
          style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 9,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: statusColor(agent.status),
            flexShrink: 0,
            alignSelf: "flex-start",
            marginTop: 2,
          }}
        >
          {statusLabel(agent.status)}
        </span>
      </div>
    </div>
  );
}
