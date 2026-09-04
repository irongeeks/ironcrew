import { useCallback, useEffect, useState, type ReactNode } from "react";
import RetroSidebar from "../components/RetroSidebar";
import OctoOfficeTopBar from "../components/OctoOfficeTopBar";
import MissionControl from "../components/mission-control/MissionControl";
import { ChatPanel } from "../components/ChatPanel";
import AgentSidebar from "../components/AgentSidebar";
import RetroOfficeView from "../components/RetroOfficeView";
import { CommandCenterView } from "../ironcrew/CommandCenterView";
import { IdentityGate } from "../ironcrew/IdentityGate";
import TaskBoard from "../components/TaskBoard";
import AgentManager from "../components/AgentManager";
import SkillsLibrary from "../components/SkillsLibrary";
import SettingsPanel from "../components/SettingsPanel";
import type { SettingsTab } from "../components/settings/types";
import OperationsCenter from "../components/OperationsCenter";
import ProjectsView from "../components/ProjectsView";
import SchedulesView from "../components/schedules/SchedulesView";
import { WorkflowEditorPage } from "../components/workflow-editor/WorkflowEditorPage";
import { SubsystemErrorBoundary } from "../components/SubsystemErrorBoundary";
import { I18nProvider } from "../i18n";
import type {
  Agent,
  AutonomousActionEvent,
  CeoOfficeCall,
  CliStatusMap,
  CompanyStats,
  CompanySettings,
  CrossDeptDelivery,
  Department,
  MeetingPresence,
  Message,
  ServerAllocation,
  ServerNode,
  SubAgent,
  SubTask,
  Task,
  WorkflowPackKey,
  WSEventType,
} from "../types";
import type { UpdateStatus } from "../api";
import type { OAuthCallbackResult, RoomThemeMap, View } from "./types";
import type { UiLanguage } from "../i18n";
import type { SetupStatus } from "../api/messaging-runtime-oauth";
import MobileHeader from "./MobileHeader";
import { useMobile } from "../hooks/useMobile";
import { MobileBottomTabBar } from "../components/mobile/MobileBottomTabBar";
import { useOfficePackResolution } from "./useOfficePackResolution";

interface AppMainLayoutLabels {
  uiLanguage: string;
  viewTitle: string;
  announcementLabel: string;
  roomManagerLabel: string;
  roomManagerDepartments: { id: string; name: string }[];
  reportLabel: string;
  tasksPrimaryLabel: string;
  agentStatusLabel: string;
  decisionLabel: string;
  autoUpdateNoticeVisible: boolean;
  autoUpdateNoticeTitle: string;
  autoUpdateNoticeHint: string;
  autoUpdateNoticeActionLabel: string;
  autoUpdateNoticeContainerClass: string;
  autoUpdateNoticeTextClass: string;
  autoUpdateNoticeHintClass: string;
  autoUpdateNoticeButtonClass: string;
  effectiveUpdateStatus: UpdateStatus | null;
  updateBannerVisible: boolean;
  updateReleaseUrl: string;
  updateTitle: string;
  updateHint: string;
  updateReleaseLabel: string;
  updateDismissLabel: string;
  updateTestModeHint: string;
}

interface AppMainLayoutProps {
  connected: boolean;
  socketOn: (event: WSEventType, handler: (payload: unknown) => void) => () => void;
  view: View;
  setView: (view: View) => void;
  agentSidebarOpen: boolean;
  onToggleAgentSidebar: () => void;
  departments: Department[];
  agents: Agent[];
  stats: CompanyStats | null;
  tasks: Task[];
  subtasks: SubTask[];
  subAgents: SubAgent[];
  meetingPresence: MeetingPresence[];
  settings: CompanySettings;
  cliStatus: CliStatusMap | null;
  oauthResult: OAuthCallbackResult | null;
  labels: AppMainLayoutLabels;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  mobileHeaderMenuOpen: boolean;
  setMobileHeaderMenuOpen: (open: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  decisionInboxLoading: boolean;
  decisionInboxCount: number;
  activeMeetingTaskId: string | null;
  unreadAgentIds: Set<string>;
  crossDeptDeliveries: CrossDeptDelivery[];
  ceoOfficeCalls: CeoOfficeCall[];
  servers: ServerNode[];
  serverAllocations: ServerAllocation[];
  customRoomThemes: RoomThemeMap;
  activeRoomThemeTargetId: string | null;
  onCrossDeptDeliveryProcessed: (id: string) => void;
  onCeoOfficeCallProcessed: (id: string) => void;
  onOpenActiveMeetingMinutes: (taskId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onSelectServer: (server: ServerNode | null) => void;
  onSelectDepartment: (department: Department) => void;
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
  }) => Promise<void>;
  onUpdateTask: (id: string, data: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onAssignTask: (taskId: string, agentId: string) => Promise<void>;
  onRunTask: (id: string) => Promise<void>;
  onStopTask: (id: string) => Promise<void>;
  onPauseTask: (id: string) => Promise<void>;
  onResumeTask: (id: string) => Promise<void>;
  onOpenTerminal: (taskId: string) => void;
  onOpenMeetingMinutes: (taskId: string) => void;
  onAgentsChange: () => void;
  activeOfficeWorkflowPack: WorkflowPackKey;
  onChangeOfficeWorkflowPack: (packKey: WorkflowPackKey) => void;
  onSaveSettings: (settings: CompanySettings) => Promise<void>;
  onRefreshCli: () => Promise<void>;
  onOauthResultClear: () => void;
  onOpenDecisionInbox: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenAnnouncement: () => void;
  onOpenRoomManager: () => void;
  onDismissAutoUpdateNotice: () => Promise<void>;
  onDismissUpdate: () => void;
  setupStatus?: SetupStatus | null;
  officePackBootstrappingLabel?: string | null;
  autonomousActions?: AutonomousActionEvent[];
  onNavigateToServerSettings?: (serverId: string) => void;
  settingsInitialTab?: string;
  // Chat panel props for embedded chat in office view
  showChat: boolean;
  chatAgent: Agent | null;
  chatMessages: Message[];
  chatStreamingMessage?: {
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
    projectMeta?: { project_id?: string; project_path?: string; project_context?: string },
  ) => void | Promise<void>;
  onSendAnnouncement: (content: string) => void;
  onSendDirective: (
    content: string,
    projectMeta?: { project_id?: string; project_path?: string; project_context?: string },
  ) => void;
  onClearMessages?: (agentId?: string) => void;
  onSelectChatAgent?: (agent: Agent | null) => void;
  onOpenChat: (agent?: Agent) => void;
  onCloseChat: () => void;
  children?: ReactNode;
}

export default function AppMainLayout({
  connected,
  socketOn,
  view,
  setView,
  agentSidebarOpen,
  onToggleAgentSidebar,
  departments,
  agents,
  stats: _stats,
  tasks,
  subtasks,
  subAgents: _subAgents,
  meetingPresence: _meetingPresence,
  settings,
  cliStatus,
  oauthResult,
  labels,
  mobileNavOpen,
  setMobileNavOpen,
  mobileHeaderMenuOpen,
  setMobileHeaderMenuOpen,
  theme,
  toggleTheme,
  decisionInboxLoading,
  decisionInboxCount,
  activeMeetingTaskId: _activeMeetingTaskId,
  unreadAgentIds: _unreadAgentIds,
  crossDeptDeliveries: _crossDeptDeliveries,
  ceoOfficeCalls: _ceoOfficeCalls,
  servers,
  serverAllocations,
  customRoomThemes,
  activeRoomThemeTargetId: _activeRoomThemeTargetId,
  onCrossDeptDeliveryProcessed: _onCrossDeptDeliveryProcessed,
  onCeoOfficeCallProcessed: _onCeoOfficeCallProcessed,
  onOpenActiveMeetingMinutes: _onOpenActiveMeetingMinutes,
  onSelectAgent,
  onSelectServer,
  onSelectDepartment,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onAgentsChange,
  activeOfficeWorkflowPack,
  onChangeOfficeWorkflowPack,
  onSaveSettings,
  onRefreshCli,
  onOauthResultClear,
  onOpenDecisionInbox,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenAnnouncement,
  onOpenRoomManager,
  onDismissAutoUpdateNotice: _onDismissAutoUpdateNotice,
  onDismissUpdate: _onDismissUpdate,
  setupStatus,
  officePackBootstrappingLabel: _officePackBootstrappingLabel,
  autonomousActions: _autonomousActions,
  onNavigateToServerSettings,
  settingsInitialTab,
  showChat,
  chatAgent,
  chatMessages,
  chatStreamingMessage,
  onSendMessage,
  onSendAnnouncement,
  onSendDirective,
  onClearMessages,
  onSelectChatAgent,
  onOpenChat,
  onCloseChat,
  children,
}: AppMainLayoutProps) {
  const { isMobile } = useMobile();

  const [officeExpanded, setOfficeExpanded] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);

  const uiLanguage =
    labels.uiLanguage === "ko" || labels.uiLanguage === "ja" || labels.uiLanguage === "zh" || labels.uiLanguage === "de"
      ? labels.uiLanguage
      : "en";

  const pack = useOfficePackResolution({
    activeOfficeWorkflowPack,
    departments,
    agents,
    tasks,
    settings,
    customRoomThemes,
    uiLanguage,
    onCreateTask,
  });

  useEffect(() => {
    setMobileNavOpen(false);
    setMobileHeaderMenuOpen(false);
  }, [setMobileHeaderMenuOpen, setMobileNavOpen, view]);

  const handleChangeView = useCallback(
    (nextView: View) => {
      setView(nextView);
      setMobileNavOpen(false);
      setMobileHeaderMenuOpen(false);
      // Close embedded chat when leaving office view
      if (nextView !== "office" && showChat) {
        onCloseChat();
      }
    },
    [setMobileHeaderMenuOpen, setMobileNavOpen, setView, showChat, onCloseChat],
  );
  const handleLanguageChange = useCallback(
    (nextLanguage: UiLanguage) => {
      if (settings.language === nextLanguage) return;
      void onSaveSettings({
        ...settings,
        language: nextLanguage,
      });
    },
    [onSaveSettings, settings],
  );

  return (
    <I18nProvider language={labels.uiLanguage}>
      <div
        className="app-shell flex flex-col h-dvh overflow-hidden"
        style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}
      >
        {/* Desktop: Top Bar (hidden on mobile, hidden when office expanded) */}
        {!officeExpanded && (
          <div className="hidden lg:block">
            <OctoOfficeTopBar
              view={view}
              onChangeView={handleChangeView}
              language={uiLanguage}
              onLanguageChange={handleLanguageChange}
              theme={theme}
              onToggleTheme={toggleTheme}
              decisionInboxCount={decisionInboxCount}
              decisionInboxLoading={decisionInboxLoading}
              onOpenDecisionInbox={onOpenDecisionInbox}
              onOpenAnnouncement={onOpenAnnouncement}
              onOpenAgentStatus={onOpenAgentStatus}
              onOpenReportHistory={onOpenReportHistory}
              onOpenRoomManager={onOpenRoomManager}
              onNewMission={() => setShowCreateTask(true)}
              officePackControl={{
                label: pack.officePackLabel,
                value: pack.officePackKey,
                options: pack.officePackOptions,
                onChange: onChangeOfficeWorkflowPack,
              }}
              connected={connected}
              setupStatus={setupStatus}
            />
          </div>
        )}

        {/* Mobile: Sidebar overlay (for mid-range screens where BottomTabBar is not shown) */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileNavOpen(false)} />
        )}
        {mobileNavOpen && (
          <aside
            className="fixed inset-y-0 left-0 z-50 w-72 lg:hidden"
            style={{ background: "var(--bg-surface-solid)" }}
          >
            <RetroSidebar
              view={view}
              onChangeView={(v) => {
                handleChangeView(v);
                setMobileNavOpen(false);
              }}
              connected={connected}
            />
          </aside>
        )}

        {/* Mobile header (hidden when office expanded) */}
        {!officeExpanded && (
          <MobileHeader
            labels={labels}
            connected={connected}
            uiLanguage={uiLanguage}
            languageLabel={pack.languageLabel}
            theme={theme}
            decisionInboxLoading={decisionInboxLoading}
            decisionInboxCount={decisionInboxCount}
            mobileHeaderMenuOpen={mobileHeaderMenuOpen}
            setMobileHeaderMenuOpen={setMobileHeaderMenuOpen}
            onChangeView={handleChangeView}
            onLanguageChange={handleLanguageChange}
            onOpenDecisionInbox={onOpenDecisionInbox}
            onOpenAnnouncement={onOpenAnnouncement}
            onOpenAgentStatus={onOpenAgentStatus}
            onOpenReportHistory={onOpenReportHistory}
            onOpenRoomManager={onOpenRoomManager}
            toggleTheme={toggleTheme}
            setMobileNavOpen={setMobileNavOpen}
          />
        )}

        {/* Content area */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* IronCrew control plane. Its own full-surface shell: it owns
              the CEO chat, the board and the decision inbox, so it renders
              standalone rather than inside the office chrome. */}
          {view === "command" && (
            <IdentityGate>
              <CommandCenterView />
            </IdentityGate>
          )}

          {/* Office view: MissionControl (normal) or fullscreen RetroOfficeView (expanded) */}
          {view === "office" && !officeExpanded && (
            <>
              <main
                className="flex-1 overflow-hidden pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0"
                style={{ background: "var(--bg-base)" }}
              >
                <MissionControl
                  agents={pack.officePresentation.agents}
                  tasks={pack.tasksForActivePack}
                  departments={pack.officePresentation.departments}
                  servers={servers}
                  serverAllocations={serverAllocations}
                  activePackKey={pack.officePackKey}
                  subtasks={subtasks}
                  socketOn={socketOn}
                  onAgentClick={onSelectAgent}
                  onSelectDepartment={onSelectDepartment}
                  onSelectServer={onSelectServer}
                  onTaskClick={(task) => onOpenTerminal(task.id)}
                  onCreateTask={pack.handleCreateTaskForActivePack}
                  onAssignTask={onAssignTask}
                  onFullBoard={() => handleChangeView("tasks")}
                  onExpandOffice={() => setOfficeExpanded(true)}
                  showCreateTask={showCreateTask}
                  onCloseCreateTask={() => setShowCreateTask(false)}
                />
              </main>

              {/* Chat toggle button (when chat is closed) */}
              {!showChat && (
                <button
                  onClick={() => onOpenChat()}
                  className="hidden lg:flex items-center justify-center"
                  style={{
                    width: 40,
                    flexShrink: 0,
                    background: "var(--bg-surface-solid)",
                    borderLeft: "1px solid var(--border)",
                    cursor: "pointer",
                    writingMode: "vertical-rl",
                    fontFamily: "'Press Start 2P', monospace",
                    fontSize: 7,
                    color: "var(--text-muted)",
                    letterSpacing: "0.1em",
                    transition: "color 0.15s",
                  }}
                  title="Open Chat"
                >
                  💬 CHAT
                </button>
              )}

              {/* Embedded ChatPanel (when open) */}
              {showChat && (
                <div className="hidden lg:flex flex-shrink-0" style={{ width: 384 }}>
                  <ChatPanel
                    selectedAgent={chatAgent}
                    messages={chatMessages}
                    agents={pack.officePresentation.agents}
                    streamingMessage={chatStreamingMessage}
                    onSendMessage={onSendMessage}
                    onSendAnnouncement={onSendAnnouncement}
                    onSendDirective={onSendDirective}
                    onClearMessages={onClearMessages}
                    onSelectAgent={onSelectChatAgent}
                    onClose={onCloseChat}
                  />
                </div>
              )}
            </>
          )}

          {view === "office" && officeExpanded && (
            <main className="flex-1 overflow-hidden relative" style={{ background: "var(--bg-base)" }}>
              <div className="relative h-full">
                <RetroOfficeView
                  departments={pack.officePresentation.departments}
                  agents={pack.officePresentation.agents}
                  servers={servers}
                  serverAllocations={serverAllocations}
                  onSelectAgent={onSelectAgent}
                  onSelectServer={onSelectServer}
                  onSelectDepartment={onSelectDepartment}
                />
                {/* Vignette overlay */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    boxShadow: "inset 0 0 60px 20px rgba(0,0,0,0.3)",
                    borderRadius: 0,
                  }}
                />
                {/* Collapse button */}
                <button
                  onClick={() => setOfficeExpanded(false)}
                  style={{
                    position: "absolute",
                    bottom: 16,
                    left: 16,
                    zIndex: 20,
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    background: "rgba(0,0,0,0.6)",
                    border: "1px solid var(--border)",
                    padding: "6px 14px",
                    borderRadius: 6,
                    cursor: "pointer",
                    backdropFilter: "blur(8px)",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.8)";
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.6)";
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                  }}
                >
                  ↙ Collapse
                </button>
              </div>

              {/* Right sidebar: only in expanded office, desktop only */}
              <div className="hidden lg:block absolute right-0 top-0 bottom-0 z-10" style={{ pointerEvents: "auto" }}>
                <AgentSidebar
                  agents={pack.officePresentation.agents}
                  departments={pack.officePresentation.departments}
                  collapsed={!agentSidebarOpen}
                  onToggleCollapse={onToggleAgentSidebar}
                  onSelectAgent={onSelectAgent}
                />
              </div>
            </main>
          )}

          {/* Workflow view: full-height without padding (ReactFlow needs explicit container height) */}
          {view === "workflows" && (
            <main
              className="flex flex-1 flex-col overflow-hidden pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0"
              style={{ background: "var(--bg-base)" }}
            >
              <SubsystemErrorBoundary name="Workflow Editor" resetKey={pack.officePackKey}>
                <WorkflowEditorPage subtasks={subtasks} activePackKey={pack.officePackKey} />
              </SubsystemErrorBoundary>
            </main>
          )}

          {/* All other views: padded content */}
          {view !== "office" && view !== "workflows" && (
            <main
              className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0"
              style={{ background: "var(--bg-base)" }}
            >
              <div className="p-3 sm:p-4 md:p-6">
                {view === "operations" && (
                  <SubsystemErrorBoundary name="Operations Center">
                    <OperationsCenter socketOn={socketOn} onNavigateToServerSettings={onNavigateToServerSettings} />
                  </SubsystemErrorBoundary>
                )}

                {view === "tasks" && (
                  <TaskBoard
                    activePackKey={pack.officePackKey}
                    tasks={pack.tasksForActivePack}
                    agents={pack.officePresentation.agents}
                    departments={pack.officePresentation.departments}
                    subtasks={subtasks}
                    onCreateTask={pack.handleCreateTaskForActivePack}
                    onUpdateTask={onUpdateTask}
                    onDeleteTask={onDeleteTask}
                    onAssignTask={onAssignTask}
                    onRunTask={onRunTask}
                    onStopTask={onStopTask}
                    onPauseTask={onPauseTask}
                    onResumeTask={onResumeTask}
                    onOpenTerminal={onOpenTerminal}
                    onOpenMeetingMinutes={onOpenMeetingMinutes}
                  />
                )}

                {view === "agents" && (
                  <AgentManager
                    agents={pack.managerAgents}
                    departments={pack.orderedManagerDepartments}
                    onAgentsChange={onAgentsChange}
                    activeOfficeWorkflowPack={pack.officePackKey}
                    dbBackedOfficePack={false}
                    departmentRoomAssignments={pack.activeRoomAssignments}
                    onSaveDepartmentRoomAssignments={async (assignments) => {
                      await onSaveSettings({
                        ...settings,
                        departmentRoomAssignments: {
                          ...(settings.departmentRoomAssignments ?? {}),
                          [pack.officePackKey]: assignments,
                        },
                      });
                    }}
                    onSaveOfficePackProfile={async (packKey, profile) => {
                      if (packKey === "development") return;
                      await onSaveSettings({
                        ...settings,
                        officePackProfiles: {
                          ...(settings.officePackProfiles ?? {}),
                          [packKey]: profile,
                        },
                      });
                    }}
                  />
                )}

                {view === "skills" && (
                  <SubsystemErrorBoundary name="Skills Library">
                    <SkillsLibrary agents={agents} />
                  </SubsystemErrorBoundary>
                )}

                {view === "projects" && (
                  <ProjectsView agents={agents} departments={pack.officePresentation.departments} />
                )}

                {view === "schedules" && <SchedulesView departments={pack.officePresentation.departments} />}

                {view === "settings" && (
                  <SubsystemErrorBoundary name="Settings">
                    <SettingsPanel
                      settings={settings}
                      cliStatus={cliStatus}
                      agents={agents}
                      onSave={(nextSettings) => {
                        void onSaveSettings(nextSettings);
                      }}
                      onRefreshCli={() => {
                        void onRefreshCli();
                      }}
                      oauthResult={oauthResult}
                      onOauthResultClear={onOauthResultClear}
                      initialTab={settingsInitialTab as SettingsTab | undefined}
                    />
                  </SubsystemErrorBoundary>
                )}
              </div>
            </main>
          )}
        </div>

        {/* Mobile bottom nav (hidden when office expanded) */}
        {!officeExpanded && isMobile && (
          <MobileBottomTabBar
            activeView={view}
            onChangeView={handleChangeView}
            onOpenChat={() => {
              onOpenChat();
            }}
            officePackKey={pack.officePackKey}
            officePackLabel={pack.officePackLabel}
            officePackOptions={pack.officePackOptions}
            onChangeOfficeWorkflowPack={onChangeOfficeWorkflowPack}
          />
        )}

        {children}
      </div>
    </I18nProvider>
  );
}
