import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { Agent, Department, SubAgent, SubTask, Task, WorkflowPackKey } from "../types";
import AgentDetailHeader from "./agent-detail/AgentDetailHeader";
import AgentDetailTabContent from "./agent-detail/AgentDetailTabContent";
import { useAgentDetailState } from "./agent-detail/useAgentDetailState";

interface AgentDetailProps {
  agent: Agent;
  agents: Agent[];
  department: Department | undefined;
  departments: Department[];
  tasks: Task[];
  subAgents: SubAgent[];
  subtasks: SubTask[];
  activeOfficeWorkflowPack: WorkflowPackKey;
  onClose: () => void;
  onChat: (agent: Agent) => void;
  onAssignTask: (agentId: string) => void;
  onOpenTerminal?: (taskId: string) => void;
  onAgentUpdated?: () => void;
}

export default function AgentDetail({
  agent,
  agents,
  department,
  departments,
  tasks,
  subAgents,
  subtasks,
  activeOfficeWorkflowPack,
  onClose,
  onChat,
  onAssignTask,
  onOpenTerminal,
  onAgentUpdated,
}: AgentDetailProps) {
  const { t, language } = useI18n();
  const [tab, setTab] = useState<"info" | "tasks" | "alba">("info");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const state = useAgentDetailState(agent, activeOfficeWorkflowPack, onAgentUpdated);

  const agentTasks = tasks.filter((task) => task.assigned_agent_id === agent.id);
  const subtasksByTask = useMemo(() => {
    const grouped: Record<string, SubTask[]> = {};
    for (const subtask of subtasks) {
      if (!grouped[subtask.task_id]) grouped[subtask.task_id] = [];
      grouped[subtask.task_id].push(subtask);
    }
    return grouped;
  }, [subtasks]);
  const agentSubAgents = subAgents.filter((subAgent) => subAgent.parentAgentId === agent.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="w-[calc(100vw-1.5rem)] max-w-[480px] max-h-[85vh] overflow-hidden"
        style={{
          background: "var(--th-card-bg)",
          border: "1px solid var(--th-card-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
        }}
      >
        <AgentDetailHeader
          agent={agent}
          agents={agents}
          department={department}
          state={state}
          activeOfficeWorkflowPack={activeOfficeWorkflowPack}
          onClose={onClose}
          t={t}
          language={language}
        />

        <div className="flex" style={{ borderBottom: "1px solid var(--th-border)" }}>
          {[
            { key: "info", label: t({ ko: "정보", en: "Info", ja: "情報", zh: "Info", de: "Info" }) },
            {
              key: "tasks",
              label: `${t({ ko: "업무", en: "Tasks", ja: "タスク", zh: "Tasks", de: "Aufgaben" })} (${agentTasks.length})`,
            },
            {
              key: "alba",
              label: `${t({ ko: "알바생", en: "Sub-agents", ja: "サブエージェント", zh: "Sub-agents", de: "Unteragenten" })} (${agentSubAgents.length})`,
            },
          ].map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key as typeof tab)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === tabItem.key ? "border-b-2 hover:opacity-100" : "hover:opacity-80"
              }`}
              style={
                tab === tabItem.key
                  ? { color: "var(--accent)", borderBottomColor: "var(--accent)" }
                  : { color: "var(--th-text-secondary)" }
              }
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto max-h-[40vh]">
          <AgentDetailTabContent
            tab={tab}
            t={t}
            language={language}
            agent={agent}
            departments={departments}
            agentTasks={agentTasks}
            agentSubAgents={agentSubAgents}
            subtasksByTask={subtasksByTask}
            expandedTaskId={expandedTaskId}
            setExpandedTaskId={setExpandedTaskId}
            onChat={onChat}
            onAssignTask={onAssignTask}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
      </div>
    </div>
  );
}
