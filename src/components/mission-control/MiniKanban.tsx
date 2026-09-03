import React, { useEffect, useState } from "react";
import type { Task, Agent, TaskStatus } from "../../types";

interface MiniKanbanProps {
  tasks: Task[];
  agents: Agent[];
  onTaskClick?: (task: Task) => void;
  onNewTask?: () => void;
  onFullBoard?: () => void;
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

// TODO(theme): No CSS tokens exist yet for task-status colors (inbox/planned/review/done).
// Only --status-working/--status-idle exist in index.part01.css, which are for agent status,
// not task status. Leaving hex values until a task-status token palette is introduced.
const COLUMNS: { status: TaskStatus; label: string; color: string; bg: string; maxCards: number }[] = [
  { status: "inbox", label: "Inbox", color: "#94A3B8", bg: "rgba(148,163,184,0.08)", maxCards: 5 },
  { status: "planned", label: "Planned", color: "#60A5FA", bg: "rgba(96,165,250,0.08)", maxCards: 5 },
  { status: "in_progress", label: "In Progress", color: "var(--accent)", bg: "var(--accent-subtle)", maxCards: 5 },
  { status: "review", label: "Review", color: "#F97316", bg: "rgba(249,115,22,0.08)", maxCards: 5 },
  { status: "done", label: "Done", color: "#6B7280", bg: "rgba(107,114,128,0.05)", maxCards: 2 },
];

const TaskCard = React.memo(function TaskCard({
  task,
  agents,
  onClick,
  dimmed,
  isMobile,
}: {
  task: Task;
  agents: Agent[];
  onClick?: () => void;
  dimmed?: boolean;
  isMobile?: boolean;
}) {
  const agent = task.assigned_agent_id ? agents.find((a) => a.id === task.assigned_agent_id) : null;
  const agentName = agent?.name ?? task.agent_name ?? null;
  const agentEmoji = agent?.avatar_emoji ?? task.agent_avatar ?? null;

  return (
    <button
      onClick={onClick}
      aria-label={`Open task: ${task.title}`}
      style={{
        display: "block",
        width: "100%",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: isMobile ? "10px 12px" : "8px 10px",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        opacity: dimmed ? 0.5 : 1,
        transition: "background 0.15s, border-color 0.15s",
        minHeight: isMobile ? 44 : undefined,
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-strong)";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
      }}
    >
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: isMobile ? 12 : 11,
          fontWeight: 600,
          color: "var(--text-primary, #F1F5F9)",
          lineHeight: 1.4,
          marginBottom: agentName ? 5 : 0,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {task.title}
      </div>
      {agentName && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "var(--text-muted, #64748B)",
            fontWeight: 500,
          }}
        >
          {agentEmoji && <span style={{ fontSize: 12 }}>{agentEmoji}</span>}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agentName}</span>
        </div>
      )}
    </button>
  );
});

const KanbanColumn = React.memo(function KanbanColumn({
  label,
  color,
  bg,
  tasks,
  agents,
  maxCards,
  onTaskClick,
}: {
  label: string;
  color: string;
  bg: string;
  tasks: Task[];
  agents: Agent[];
  maxCards: number;
  onTaskClick?: (task: Task) => void;
}) {
  const isDone = label === "Done";
  const visible = tasks.slice(0, maxCards);
  const overflow = tasks.length - maxCards;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 0,
        background: bg,
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      {/* Column header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: '"Press Start 2P", monospace',
              fontSize: 8,
              color,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {label}
          </span>
        </div>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            fontWeight: 700,
            color,
            background: `${color}22`,
            border: `1px solid ${color}44`,
            borderRadius: 10,
            padding: "1px 6px",
            minWidth: 20,
            textAlign: "center",
          }}
        >
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 8,
          overflowY: "auto",
        }}
      >
        {visible.length === 0 && (
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "var(--text-muted, #64748B)",
              textAlign: "center",
              padding: "12px 0",
              opacity: 0.5,
            }}
          >
            empty
          </div>
        )}
        {visible.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            agents={agents}
            onClick={onTaskClick ? () => onTaskClick(task) : undefined}
            dimmed={isDone}
          />
        ))}
        {overflow > 0 && (
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "var(--text-muted, #64748B)",
              textAlign: "center",
              padding: "4px 0",
            }}
          >
            +{overflow} more
          </div>
        )}
      </div>
    </div>
  );
});

const MobileSection = React.memo(function MobileSection({
  label,
  color,
  bg,
  tasks,
  agents,
  maxCards,
  defaultExpanded,
  onTaskClick,
}: {
  label: string;
  color: string;
  bg: string;
  tasks: Task[];
  agents: Agent[];
  maxCards: number;
  defaultExpanded: boolean;
  onTaskClick?: (task: Task) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isDone = label === "Done";
  const visible = tasks.slice(0, maxCards);
  const overflow = tasks.length - maxCards;

  return (
    <div
      style={{
        background: bg,
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {/* Section header — tappable to expand/collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "12px 14px",
          background: "none",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          minHeight: 48,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: '"Press Start 2P", monospace',
              fontSize: 8,
              color,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color,
              background: `${color}22`,
              border: `1px solid ${color}44`,
              borderRadius: 10,
              padding: "1px 6px",
              minWidth: 20,
              textAlign: "center",
            }}
          >
            {tasks.length}
          </span>
        </div>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 12,
            color: "var(--text-muted, #64748B)",
            lineHeight: 1,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform 0.2s",
            display: "inline-block",
          }}
        >
          ▾
        </span>
      </button>

      {/* Collapsible card list */}
      {expanded && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 10,
          }}
        >
          {visible.length === 0 && (
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "var(--text-muted, #64748B)",
                textAlign: "center",
                padding: "10px 0",
                opacity: 0.5,
              }}
            >
              empty
            </div>
          )}
          {visible.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              onClick={onTaskClick ? () => onTaskClick(task) : undefined}
              dimmed={isDone}
              isMobile
            />
          ))}
          {overflow > 0 && (
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                color: "var(--text-muted, #64748B)",
                textAlign: "center",
                padding: "4px 0",
              }}
            >
              +{overflow} more
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default function MiniKanban({ tasks, agents, onTaskClick, onNewTask, onFullBoard }: MiniKanbanProps) {
  const isMobile = useIsMobile();
  const byStatus = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "10px 12px" : "12px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          minHeight: isMobile ? 44 : undefined,
        }}
      >
        <span
          style={{
            fontFamily: '"Press Start 2P", monospace',
            fontSize: isMobile ? 8 : 10,
            color: "var(--text-primary, #F1F5F9)",
            letterSpacing: "0.05em",
          }}
        >
          TASK BOARD
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 10 }}>
          {onFullBoard && (
            <button
              onClick={onFullBoard}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "#60A5FA",
                fontWeight: 600,
                padding: isMobile ? "6px 4px" : 0,
                minHeight: isMobile ? 44 : undefined,
                display: "flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              <span>↗</span>
              <span>Full Board</span>
            </button>
          )}
          {onNewTask && (
            <button
              onClick={onNewTask}
              style={{
                background: "var(--accent-subtle)",
                border: "1px solid var(--accent-dim)",
                borderRadius: 6,
                cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "var(--accent)",
                fontWeight: 700,
                padding: isMobile ? "10px 14px" : "4px 10px",
                minHeight: isMobile ? 44 : undefined,
              }}
            >
              + New Task
            </button>
          )}
        </div>
      </div>

      {isMobile ? (
        /* Mobile: vertical stack of collapsible sections */
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "10px 12px",
            overflowY: "auto",
            maxHeight: 480,
          }}
        >
          {COLUMNS.map((col) => (
            <MobileSection
              key={col.status}
              label={col.label}
              color={col.color}
              bg={col.bg}
              tasks={byStatus(col.status)}
              agents={agents}
              maxCards={col.maxCards}
              defaultExpanded={col.status === "in_progress"}
              onTaskClick={onTaskClick}
            />
          ))}
        </div>
      ) : (
        /* Desktop: horizontal columns */
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 12,
            overflowX: "auto",
            maxHeight: 320,
          }}
        >
          {COLUMNS.map((col) => (
            <div key={col.status} style={{ flex: 1, minWidth: 0 }}>
              <KanbanColumn
                label={col.label}
                color={col.color}
                bg={col.bg}
                tasks={byStatus(col.status)}
                agents={agents}
                maxCards={col.maxCards}
                onTaskClick={onTaskClick}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
