import { useState } from "react";
import type {
  Agent,
  Department,
  ServerAllocation,
  ServerNode,
  SubTask,
  Task,
  WorkflowPackKey,
  WSEventType,
} from "../../types";
import { useProviderTokenUsage } from "../../hooks/useTokenUsage";
import AgentSidebarPanel from "../mission-control/AgentSidebarPanel";
import MiniKanban from "../mission-control/MiniKanban";
import MetricsStrip from "../mission-control/MetricsStrip";
import CreateTaskModal from "../taskboard/CreateTaskModal";
import RetroOfficeView from "../RetroOfficeView";

type SegmentTab = "agents" | "kanban" | "metrics";

const TABS: { key: SegmentTab; label: string }[] = [
  { key: "agents", label: "Agents" },
  { key: "kanban", label: "Kanban" },
  { key: "metrics", label: "Metrics" },
];

interface MobileMissionControlProps {
  agents: Agent[];
  tasks: Task[];
  departments: Department[];
  servers: ServerNode[];
  serverAllocations: ServerAllocation[];
  activePackKey?: WorkflowPackKey;
  subtasks: SubTask[];
  socketOn: (event: WSEventType, handler: (payload: unknown) => void) => () => void;
  onAgentClick: (agent: Agent) => void;
  onSelectDepartment: (dept: Department) => void;
  onSelectServer: (server: ServerNode | null) => void;
  onTaskClick: (task: Task) => void;
  onCreateTask: (input: {
    title: string;
    description?: string;
    department_id?: string;
    task_type?: string;
    priority?: number;
    project_id?: string;
    project_path?: string;
    assigned_agent_id?: string;
    workflow_pack_key?: WorkflowPackKey;
    workflow_meta_json?: string;
  }) => void;
  onAssignTask: (taskId: string, agentId: string) => Promise<void>;
  onFullBoard: () => void;
  onExpandOffice: () => void;
  showCreateTask?: boolean;
  onCloseCreateTask?: () => void;
}

export function MobileMissionControl({
  agents,
  tasks,
  departments,
  servers,
  serverAllocations,
  onAgentClick,
  onSelectDepartment,
  onSelectServer,
  onTaskClick,
  onCreateTask,
  onAssignTask,
  onFullBoard,
  showCreateTask: showCreateTaskProp,
  onCloseCreateTask,
  activePackKey,
}: MobileMissionControlProps) {
  const [activeTab, setActiveTab] = useState<SegmentTab>("agents");
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  const providerData = useProviderTokenUsage();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Office canvas -- ~40% height when expanded, 0 when collapsed */}
      {!canvasCollapsed && (
        <div
          style={{
            flex: "0 0 40%",
            minHeight: 160,
            position: "relative",
            background: "linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-base) 100%)",
          }}
        >
          <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <RetroOfficeView
              agents={agents}
              departments={departments}
              servers={servers}
              serverAllocations={serverAllocations}
              onSelectAgent={onAgentClick}
              onSelectServer={onSelectServer}
              onSelectDepartment={onSelectDepartment}
            />
          </div>
        </div>
      )}

      {/* Collapse/expand toggle */}
      <button
        onClick={() => setCanvasCollapsed((prev) => !prev)}
        aria-label={canvasCollapsed ? "Show Office" : "Hide Office"}
        style={{
          flexShrink: 0,
          width: "100%",
          minHeight: 28,
          padding: "8px 12px",
          border: "none",
          borderBottom: "1px solid var(--th-border)",
          background: "var(--th-bg-primary)",
          cursor: "pointer",
          fontFamily: "'Press Start 2P', monospace",
          fontSize: 8,
          color: "var(--th-text-secondary)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textAlign: "center",
          transition: "color 0.15s, background 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--th-text-secondary)";
        }}
      >
        {canvasCollapsed ? "\u25B2 Show Office" : "\u25BC Hide Office"}
      </button>

      {/* Segment tabs */}
      <div
        role="tablist"
        style={{
          display: "flex",
          borderBottom: "1px solid var(--th-border)",
          background: "var(--th-bg-primary)",
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1,
                minHeight: 44,
                padding: "12px 0",
                border: "none",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                background: isActive ? "var(--accent-subtle, rgba(52, 211, 153, 0.08))" : "transparent",
                cursor: "pointer",
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 9,
                color: isActive ? "var(--accent)" : "var(--th-text-secondary)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                transition: "color 0.15s, border-color 0.15s, background 0.15s",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content -- scrollable remainder */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {activeTab === "agents" && <AgentSidebarPanel agents={agents} onAgentClick={onAgentClick} />}
        {activeTab === "kanban" && (
          <MiniKanban tasks={tasks} agents={agents} onTaskClick={onTaskClick} onFullBoard={onFullBoard} />
        )}
        {activeTab === "metrics" && (
          <MetricsStrip tasks={tasks} agents={agents} departments={departments} providerData={providerData} />
        )}
      </div>

      {showCreateTaskProp && (
        <CreateTaskModal
          agents={agents}
          departments={departments}
          activePackKey={activePackKey}
          onClose={() => onCloseCreateTask?.()}
          onCreate={(input) => {
            onCreateTask(input);
            onCloseCreateTask?.();
          }}
          onAssign={onAssignTask}
        />
      )}
    </div>
  );
}
