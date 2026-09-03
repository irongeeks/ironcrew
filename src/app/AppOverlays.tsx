import type { TaskReportDetail } from "../api";
import { ChatPanel } from "../components/ChatPanel";
import DecisionInboxModal from "../components/DecisionInboxModal";
import AgentDetail from "../components/AgentDetail";
import DepartmentDetail from "../components/DepartmentDetail";
import TerminalPanel from "../components/TerminalPanel";
import TaskReportPopup from "../components/TaskReportPopup";
import ReportHistory from "../components/ReportHistory";
import AgentStatusPanel from "../components/AgentStatusPanel";
import OfficeRoomManager from "../components/OfficeRoomManager";
import ServerConfigPanel from "../components/ServerConfigPanel";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type {
  Agent,
  Department,
  Message,
  RoomTheme,
  ServerAllocation,
  ServerNode,
  SubAgent,
  SubTask,
  Task,
  WorkflowPackKey,
} from "../types";
import type { UiLanguage } from "../i18n";
import type { ProjectMetaPayload, RoomThemeMap, TaskPanelTab } from "./types";

interface AppOverlaysProps {
  /** When true, ChatPanel is rendered inline elsewhere — skip overlay rendering */
  chatEmbedded?: boolean;
  showChat: boolean;
  chatAgent: Agent | null;
  messages: Message[];
  agents: Agent[];
  streamingMessage: {
    message_id: string;
    agent_id: string;
    agent_name: string;
    agent_avatar: string;
    content: string;
  } | null;
  onSendMessage: (
    content: string,
    receiverType: "agent" | "department" | "all",
    receiverId?: string,
    messageType?: string,
    projectMeta?: ProjectMetaPayload,
  ) => Promise<void>;
  onSendAnnouncement: (content: string) => Promise<void>;
  onSendDirective: (content: string, projectMeta?: ProjectMetaPayload) => Promise<void>;
  onClearMessages: (agentId?: string) => Promise<void>;
  onSelectChatAgent?: (agent: Agent | null) => void;
  onCloseChat: () => void;
  showDecisionInbox: boolean;
  decisionInboxLoading: boolean;
  decisionInboxItems: DecisionInboxItem[];
  decisionReplyBusyKey: string | null;
  uiLanguage: UiLanguage;
  onCloseDecisionInbox: () => void;
  onRefreshDecisionInbox: () => void;
  onReplyDecisionOption: (
    item: DecisionInboxItem,
    optionNumber: number,
    payloadInput?: { note?: string; selected_option_numbers?: number[] },
  ) => Promise<void>;
  onOpenDecisionChat: (agentId: string) => void;
  onOpenDecisionTaskReport: (taskId: string) => void;
  onOpenDecisionDiff?: (taskId: string) => void;
  onOpenDecisionTerminal?: (taskId: string) => void;
  selectedAgent: Agent | null;
  selectedDepartment: Department | null;
  onCloseSelectedDepartment: () => void;
  onSelectAgentFromDepartment: (agent: Agent) => void;
  onChatFromDepartment: (agent: Agent) => void;
  showServerPanel: boolean;
  selectedServer: ServerNode | null;
  activeOfficeWorkflowPack: WorkflowPackKey;
  departments: Department[];
  servers: ServerNode[];
  serverAllocations: ServerAllocation[];
  tasks: Task[];
  subAgents: SubAgent[];
  subtasks: SubTask[];
  onCloseSelectedAgent: () => void;
  onCloseSelectedServer: () => void;
  onServerUpdated: () => void;
  onChatFromAgentDetail: (agent: Agent) => void;
  onAssignTaskFromAgentDetail: () => void;
  onOpenTerminalFromAgentDetail: (taskId: string) => void;
  onAgentUpdated: () => void;
  taskPanel: { taskId: string; tab: TaskPanelTab } | null;
  onCloseTaskPanel: () => void;
  taskReport: TaskReportDetail | null;
  onCloseTaskReport: () => void;
  showReportHistory: boolean;
  onCloseReportHistory: () => void;
  showAgentStatus: boolean;
  onCloseAgentStatus: () => void;
  showRoomManager: boolean;
  roomManagerDepartments: { id: string; name: string }[];
  customRoomThemes: RoomThemeMap;
  onActiveRoomThemeTargetIdChange: (departmentId: string | null) => void;
  onRoomThemeChange: (themes: Record<string, RoomTheme>) => void;
  onCloseRoomManager: () => void;
}

export default function AppOverlays({
  chatEmbedded,
  showChat,
  chatAgent,
  messages,
  agents,
  streamingMessage,
  onSendMessage,
  onSendAnnouncement,
  onSendDirective,
  onClearMessages,
  onSelectChatAgent,
  onCloseChat,
  showDecisionInbox,
  decisionInboxLoading,
  decisionInboxItems,
  decisionReplyBusyKey,
  uiLanguage,
  onCloseDecisionInbox,
  onRefreshDecisionInbox,
  onReplyDecisionOption,
  onOpenDecisionChat,
  onOpenDecisionTaskReport,
  onOpenDecisionDiff,
  onOpenDecisionTerminal,
  selectedAgent,
  selectedDepartment,
  onCloseSelectedDepartment,
  onSelectAgentFromDepartment,
  onChatFromDepartment,
  showServerPanel,
  selectedServer,
  activeOfficeWorkflowPack,
  departments,
  servers,
  serverAllocations,
  tasks,
  subAgents,
  subtasks,
  onCloseSelectedAgent,
  onCloseSelectedServer,
  onServerUpdated,
  onChatFromAgentDetail,
  onAssignTaskFromAgentDetail,
  onOpenTerminalFromAgentDetail,
  onAgentUpdated,
  taskPanel,
  onCloseTaskPanel,
  taskReport,
  onCloseTaskReport,
  showReportHistory,
  onCloseReportHistory,
  showAgentStatus,
  onCloseAgentStatus,
  showRoomManager,
  roomManagerDepartments,
  customRoomThemes,
  onActiveRoomThemeTargetIdChange,
  onRoomThemeChange,
  onCloseRoomManager,
}: AppOverlaysProps) {
  return (
    <>
      {showChat && !chatEmbedded && (
        <ChatPanel
          selectedAgent={chatAgent}
          messages={messages}
          agents={agents}
          streamingMessage={streamingMessage}
          onSendMessage={onSendMessage}
          onSendAnnouncement={onSendAnnouncement}
          onSendDirective={onSendDirective}
          onClearMessages={onClearMessages}
          onSelectAgent={onSelectChatAgent}
          onClose={onCloseChat}
        />
      )}

      {showDecisionInbox && (
        <DecisionInboxModal
          open={showDecisionInbox}
          loading={decisionInboxLoading}
          items={decisionInboxItems}
          agents={agents}
          busyKey={decisionReplyBusyKey}
          uiLanguage={uiLanguage}
          onClose={onCloseDecisionInbox}
          onRefresh={onRefreshDecisionInbox}
          onReplyOption={onReplyDecisionOption}
          onOpenChat={onOpenDecisionChat}
          onOpenTaskReport={onOpenDecisionTaskReport}
          onOpenDiff={onOpenDecisionDiff}
          onOpenTerminal={onOpenDecisionTerminal}
        />
      )}

      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          agents={agents}
          department={departments.find((d) => d.id === selectedAgent.department_id)}
          departments={departments}
          tasks={tasks}
          subAgents={subAgents}
          subtasks={subtasks}
          onClose={onCloseSelectedAgent}
          onChat={onChatFromAgentDetail}
          onAssignTask={onAssignTaskFromAgentDetail}
          onOpenTerminal={onOpenTerminalFromAgentDetail}
          onAgentUpdated={onAgentUpdated}
          activeOfficeWorkflowPack={activeOfficeWorkflowPack}
        />
      )}

      {selectedDepartment && (
        <DepartmentDetail
          department={selectedDepartment}
          agents={agents}
          tasks={tasks}
          onClose={onCloseSelectedDepartment}
          onSelectAgent={onSelectAgentFromDepartment}
          onChat={onChatFromDepartment}
        />
      )}

      {showServerPanel && (
        <ServerConfigPanel
          server={selectedServer ? (servers.find((s) => s.id === selectedServer.id) ?? selectedServer) : null}
          servers={servers}
          agents={agents}
          initialAllocations={
            selectedServer ? serverAllocations.filter((entry) => entry.server_id === selectedServer.id) : []
          }
          onClose={onCloseSelectedServer}
          onUpdated={onServerUpdated}
        />
      )}

      {taskPanel && (
        <TerminalPanel
          taskId={taskPanel.taskId}
          initialTab={taskPanel.tab}
          task={tasks.find((t) => t.id === taskPanel.taskId)}
          agent={agents.find(
            (a) =>
              a.current_task_id === taskPanel.taskId ||
              tasks.find((t) => t.id === taskPanel.taskId)?.assigned_agent_id === a.id,
          )}
          agents={agents}
          onClose={onCloseTaskPanel}
        />
      )}

      {taskReport && (
        <TaskReportPopup
          report={taskReport}
          agents={agents}
          departments={departments}
          uiLanguage={uiLanguage}
          onClose={onCloseTaskReport}
        />
      )}

      {showReportHistory && (
        <ReportHistory
          agents={agents}
          departments={departments}
          uiLanguage={uiLanguage}
          onClose={onCloseReportHistory}
        />
      )}

      {showAgentStatus && <AgentStatusPanel agents={agents} uiLanguage={uiLanguage} onClose={onCloseAgentStatus} />}

      {showRoomManager && (
        <OfficeRoomManager
          departments={roomManagerDepartments}
          customThemes={customRoomThemes}
          onActiveDeptChange={onActiveRoomThemeTargetIdChange}
          onThemeChange={onRoomThemeChange}
          onClose={onCloseRoomManager}
          language={uiLanguage}
        />
      )}
    </>
  );
}
