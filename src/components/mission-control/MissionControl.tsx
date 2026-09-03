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
import { useMobile } from "../../hooks/useMobile";
import { useProviderTokenUsage } from "../../hooks/useTokenUsage";
import AgentSidebarPanel from "./AgentSidebarPanel";
import MiniKanban from "./MiniKanban";
import MetricsStrip from "./MetricsStrip";
import RetroOfficeView from "../RetroOfficeView";
import CreateTaskModal from "../taskboard/CreateTaskModal";
import LiveTaskView from "../live-task-view/LiveTaskView";
import { SubsystemErrorBoundary } from "../SubsystemErrorBoundary";
import { MobileMissionControl } from "../mobile/MobileMissionControl";

interface MissionControlProps {
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

export default function MissionControl(props: MissionControlProps) {
  const { isMobile } = useMobile();

  const {
    agents,
    tasks,
    departments,
    servers,
    serverAllocations,
    activePackKey,
    subtasks,
    socketOn,
    onAgentClick,
    onSelectDepartment,
    onSelectServer,
    onTaskClick,
    onCreateTask,
    onAssignTask,
    onFullBoard,
    onExpandOffice,
    showCreateTask: showCreateTaskProp,
    onCloseCreateTask,
  } = props;
  const providerData = useProviderTokenUsage();
  const [showCreateTaskLocal, setShowCreateTaskLocal] = useState(false);
  const showCreateTask = showCreateTaskProp || showCreateTaskLocal;
  const handleCloseCreate = () => {
    setShowCreateTaskLocal(false);
    onCloseCreateTask?.();
  };

  if (isMobile) return <MobileMissionControl {...props} />;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left column: Agent Sidebar (hidden on small screens) */}
      <div className="hidden lg:flex">
        <AgentSidebarPanel agents={agents} onAgentClick={onAgentClick} />
      </div>

      {/* Center column: scrollable */}
      <div style={{ flex: 1, overflowY: "auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Office View + LiveTaskView side by side */}
        <div
          style={{
            flex: 1,
            minHeight: 260,
            display: "flex",
            gap: 0,
            flexShrink: 0,
          }}
        >
          {/* Office Map — fills remaining space */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              position: "relative",
              background: "linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-base) 100%)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {/* OctoOffice label + live pulse dot */}
            <div
              style={{
                position: "absolute",
                top: 10,
                left: 14,
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                gap: 8,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: 8,
                  color: "var(--text-secondary)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                OctoOffice
              </span>
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  boxShadow: "0 0 8px var(--accent-glow)",
                  animation: "pulse 2s infinite",
                }}
              />
            </div>

            {/* Expand button */}
            <button
              onClick={onExpandOffice}
              style={{
                position: "absolute",
                top: 8,
                right: 12,
                zIndex: 2,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                color: "var(--text-muted)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                padding: "5px 12px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-glow)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
              }}
            >
              ↗ Expand
            </button>

            {/* Pixi.js canvas fills the full office area */}
            <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
              <SubsystemErrorBoundary name="Office View" resetKey={activePackKey ?? ""}>
                <RetroOfficeView
                  agents={agents}
                  departments={departments}
                  servers={servers}
                  serverAllocations={serverAllocations}
                  onSelectAgent={onAgentClick}
                  onSelectServer={onSelectServer}
                  onSelectDepartment={onSelectDepartment}
                />
              </SubsystemErrorBoundary>
            </div>
          </div>

          {/* LiveTaskView — fixed width, hidden on small screens */}
          <div className="hidden lg:flex" style={{ borderBottom: "1px solid var(--border)" }}>
            <SubsystemErrorBoundary name="Live Task View" resetKey={activePackKey ?? ""}>
              <LiveTaskView agents={agents} tasks={tasks} subtasks={subtasks} socketOn={socketOn} />
            </SubsystemErrorBoundary>
          </div>
        </div>

        {/* Mini Kanban Board */}
        <div style={{ flexShrink: 0 }}>
          <MiniKanban
            tasks={tasks}
            agents={agents}
            onTaskClick={onTaskClick}
            onNewTask={() => setShowCreateTaskLocal(true)}
            onFullBoard={onFullBoard}
          />
        </div>

        {/* Metrics Strip */}
        <div style={{ flexShrink: 0 }}>
          <MetricsStrip tasks={tasks} agents={agents} departments={departments} providerData={providerData} />
        </div>
      </div>

      {/* Create Task Modal */}
      {showCreateTask && (
        <CreateTaskModal
          activePackKey={activePackKey}
          agents={agents}
          departments={departments}
          onClose={handleCloseCreate}
          onCreate={onCreateTask}
          onAssign={onAssignTask}
        />
      )}
    </div>
  );
}
