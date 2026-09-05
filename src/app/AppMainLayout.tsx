import { useCallback, useEffect, useState, type ReactNode } from "react";
import RetroSidebar from "../components/RetroSidebar";
import IronCrewTopBar from "../components/IronCrewTopBar";
import { CommandCenterView } from "../ironcrew/CommandCenterView";
import { IdentityGate } from "../ironcrew/IdentityGate";
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
  agentSidebarOpen: _agentSidebarOpen,
  onToggleAgentSidebar: _onToggleAgentSidebar,
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
  servers: _servers,
  serverAllocations: _serverAllocations,
  customRoomThemes,
  activeRoomThemeTargetId: _activeRoomThemeTargetId,
  onCrossDeptDeliveryProcessed: _onCrossDeptDeliveryProcessed,
  onCeoOfficeCallProcessed: _onCeoOfficeCallProcessed,
  onOpenActiveMeetingMinutes: _onOpenActiveMeetingMinutes,
  onSelectAgent: _onSelectAgent,
  onSelectServer: _onSelectServer,
  onSelectDepartment: _onSelectDepartment,
  onCreateTask,
  onUpdateTask: _onUpdateTask,
  onDeleteTask: _onDeleteTask,
  onAssignTask: _onAssignTask,
  onRunTask: _onRunTask,
  onStopTask: _onStopTask,
  onPauseTask: _onPauseTask,
  onResumeTask: _onResumeTask,
  onOpenTerminal: _onOpenTerminal,
  onOpenMeetingMinutes: _onOpenMeetingMinutes,
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
  chatAgent: _chatAgent,
  chatMessages: _chatMessages,
  chatStreamingMessage: _chatStreamingMessage,
  onSendMessage: _onSendMessage,
  onSendAnnouncement: _onSendAnnouncement,
  onSendDirective: _onSendDirective,
  onClearMessages: _onClearMessages,
  onSelectChatAgent: _onSelectChatAgent,
  onOpenChat: _onOpenChat,
  onCloseChat,
  children,
}: AppMainLayoutProps) {
  const { isMobile } = useMobile();

  const [newMissionRequest, setNewMissionRequest] = useState(0);
  const canonicalView = view === "office" || view === "command" || view === "tasks";

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
      if (nextView === "command") setNewMissionRequest((request) => request + 1);
      setMobileNavOpen(false);
      setMobileHeaderMenuOpen(false);
      // Close embedded chat when leaving office view
      if (showChat) {
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
        {/* Desktop navigation */}
        {
          <div className="hidden lg:block shrink-0">
            <IronCrewTopBar
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
              onNewMission={() => handleChangeView("command")}
              officePackControl={
                canonicalView
                  ? null
                  : {
                      label: pack.officePackLabel,
                      value: pack.officePackKey,
                      options: pack.officePackOptions,
                      onChange: onChangeOfficeWorkflowPack,
                    }
              }
              connected={connected}
              setupStatus={setupStatus}
            />
          </div>
        }

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

        {/* Mobile header */}
        {
          <MobileHeader
            showLegacyActions={!canonicalView}
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
        }

        {/* Content area */}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* Office, board and CEO conversation share one company and one mounted control plane. */}
          {canonicalView && (
            <main className="crew-command-host flex min-h-0 min-w-0 flex-1 flex-col overflow-auto pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
              <IdentityGate>
                <CommandCenterView
                  initialView={view === "tasks" ? "tasks" : "office"}
                  newMissionRequest={newMissionRequest}
                />
              </IdentityGate>
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
          {!canonicalView && view !== "workflows" && (
            <main
              className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0"
              style={{ background: "var(--bg-base)" }}
            >
              <div className="p-3 sm:p-4 md:p-6">
                {(view === "agents" || view === "projects" || view === "schedules") && (
                  <p
                    role="note"
                    className="mb-4 rounded border border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)]"
                  >
                    OctoOffice-Werkzeuge · Dieser Bereich verwaltet die bisherigen Daten. Ihre aktuelle Crew, Projekte
                    und Aufgaben finden Sie im Command Center.
                    <button type="button" className="ml-2 underline" onClick={() => handleChangeView("command")}>
                      Zum Command Center
                    </button>
                  </p>
                )}
                {view === "operations" && (
                  <SubsystemErrorBoundary name="Operations Center">
                    <OperationsCenter socketOn={socketOn} onNavigateToServerSettings={onNavigateToServerSettings} />
                  </SubsystemErrorBoundary>
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

        {/* Mobile navigation */}
        {isMobile && (
          <MobileBottomTabBar
            activeView={view}
            onChangeView={handleChangeView}
            onOpenChat={() => handleChangeView("command")}
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
