import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import type {
  Department,
  Agent,
  Task,
  Message,
  CompanyStats,
  CompanySettings,
  CliStatusMap,
  ServerAllocation,
  ServerNode,
  SubTask,
  MeetingPresence,
  SubAgent,
  CrossDeptDelivery,
  CeoOfficeCall,
  AutonomousActionEvent,
  RoomTheme,
} from "./types";
import type { TaskReportDetail } from "./api";
import * as api from "./api";
import { detectBrowserLanguage } from "./i18n";
import { useTheme } from "./ThemeContext";
import { UPDATE_BANNER_DISMISS_STORAGE_KEY } from "./app/constants";
import { detectRuntimeOs, isForceUpdateBannerEnabled, mergeSettingsWithDefaults } from "./app/utils";
import type { OAuthCallbackResult, RuntimeOs, RoomThemeMap, TaskPanelTab, View } from "./app/types";
import { useRealtimeSync } from "./app/useRealtimeSync";
import { useAppLabels } from "./app/useAppLabels";
import AppLoadingScreen from "./app/AppLoadingScreen";
import AppMainLayout from "./app/AppMainLayout";
import AppOverlays from "./app/AppOverlays";
import { NotificationToast } from "./components/NotificationToast";
import DiffModal from "./components/taskboard/DiffModal";
import { useAppActions } from "./app/useAppActions";
import { useActiveMeetingTaskId } from "./app/useActiveMeetingTaskId";
import { useUpdateStatusPolling } from "./app/useUpdateStatusPolling";
import { useAppViewEffects } from "./app/useAppViewEffects";
import { useAppBootstrapData } from "./app/useAppBootstrapData";
import { useLiveSyncScheduler } from "./app/useLiveSyncScheduler";
import { resolvePackAgentViews, resolvePackDepartmentsForDisplay } from "./app/office-pack-display";
import { normalizeOfficeWorkflowPack } from "./app/office-workflow-pack";
import { RoomThemesProvider, useRoomThemes } from "./app/contexts/RoomThemesContext";
import { DecisionInboxProvider, useDecisionInbox } from "./app/contexts/DecisionInboxContext";
import { useOfficePackBootstrap } from "./app/hooks/useOfficePackBootstrap";
import { getSetupStatus, type SetupStatus } from "./api/messaging-runtime-oauth";
import SetupWizard from "./components/onboarding/SetupWizard";
import LoginPage from "./pages/LoginPage";
import { checkAuthStatus, writeStoredCsrfToken } from "./api/core";

export type { OAuthCallbackResult } from "./app/types";

export default function App() {
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "login_required">("checking");

  useEffect(() => {
    checkAuthStatus()
      .then((status) => {
        if (!status.isRemote || status.authenticated) {
          setAuthState("authenticated");
        } else if (status.passwordConfigured) {
          setAuthState("login_required");
        } else {
          setAuthState("authenticated");
        }
      })
      .catch(() => {
        setAuthState("authenticated");
      });
  }, []);

  if (authState === "checking") {
    return <AppLoadingScreen language="en" title="OctoOffice" subtitle="" />;
  }

  if (authState === "login_required") {
    return (
      <LoginPage
        onSuccess={(csrfToken) => {
          writeStoredCsrfToken(csrfToken);
          setAuthState("authenticated");
        }}
      />
    );
  }

  return (
    <RoomThemesProvider>
      <DecisionInboxProvider>
        <AppAuthenticated />
      </DecisionInboxProvider>
    </RoomThemesProvider>
  );
}

function AppAuthenticated() {
  const { theme, toggleTheme, setTheme } = useTheme();
  const {
    customRoomThemes,
    setCustomRoomThemes,
    activeRoomThemeTargetId,
    setActiveRoomThemeTargetId,
    hasLocalRoomThemesRef,
    initialRoomThemes,
    handleRoomThemeChange,
  } = useRoomThemes();
  const {
    showDecisionInbox,
    setShowDecisionInbox,
    decisionInboxLoading,
    setDecisionInboxLoading,
    decisionInboxItems,
    setDecisionInboxItems,
    decisionReplyBusyKey,
    setDecisionReplyBusyKey,
  } = useDecisionInbox();
  const [view, setView] = useState<View>("office");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [settings, setSettings] = useState<CompanySettings>(() =>
    mergeSettingsWithDefaults({ language: detectBrowserLanguage() }),
  );
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [subtasks, setSubtasks] = useState<SubTask[]>([]);
  const [servers, setServers] = useState<ServerNode[]>([]);
  const [serverAllocations, setServerAllocations] = useState<ServerAllocation[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerNode | null>(null);
  const [showServerPanel, setShowServerPanel] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>();
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ taskId: string; tab: TaskPanelTab } | null>(null);
  const [diffTaskId, setDiffTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreadAgentIds, setUnreadAgentIds] = useState<Set<string>>(new Set());
  const [crossDeptDeliveries, setCrossDeptDeliveries] = useState<CrossDeptDelivery[]>([]);
  const [ceoOfficeCalls, setCeoOfficeCalls] = useState<CeoOfficeCall[]>([]);
  const [meetingPresence, setMeetingPresence] = useState<MeetingPresence[]>([]);
  const [oauthResult, setOauthResult] = useState<OAuthCallbackResult | null>(null);
  const [taskReport, setTaskReport] = useState<TaskReportDetail | null>(null);
  const [autonomousActions, setAutonomousActions] = useState<AutonomousActionEvent[]>([]);
  const [showReportHistory, setShowReportHistory] = useState(false);
  const [showAgentStatus, setShowAgentStatus] = useState(false);
  const [showRoomManager, setShowRoomManager] = useState(false);
  const [agentSidebarOpen, setAgentSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileHeaderMenuOpen, setMobileHeaderMenuOpen] = useState(false);
  const [runtimeOs] = useState<RuntimeOs>(() => detectRuntimeOs());
  const [forceUpdateBanner] = useState<boolean>(() => isForceUpdateBannerEnabled());
  const [updateStatus, setUpdateStatus] = useState<api.UpdateStatus | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(UPDATE_BANNER_DISMISS_STORAGE_KEY) ?? "";
  });
  const [streamingMessage, setStreamingMessage] = useState<{
    message_id: string;
    agent_id: string;
    agent_name: string;
    agent_avatar: string;
    content: string;
  } | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const viewRef = useRef<View>("office");
  viewRef.current = view;
  const agentsRef = useRef<Agent[]>(agents);
  agentsRef.current = agents;
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const subAgentsRef = useRef<SubAgent[]>(subAgents);
  subAgentsRef.current = subAgents;
  const codexThreadToSubAgentIdRef = useRef<Map<string, string>>(new Map());
  const codexThreadBindingTsRef = useRef<Map<string, number>>(new Map());
  const subAgentStreamTailRef = useRef<Map<string, string>>(new Map());
  const activeChatRef = useRef<{ showChat: boolean; agentId: string | null }>({ showChat: false, agentId: null });
  activeChatRef.current = { showChat, agentId: chatAgent?.id ?? null };

  const { officePackBootstrappingLabel, handleOfficeWorkflowPackChange } = useOfficePackBootstrap({
    settings,
    setSettings,
    departments,
    setDepartments,
    agents,
    setAgents,
    customRoomThemes,
  });

  const { connected, on } = useWebSocket();
  const shouldIncludeSeedAgents = useCallback(
    () => normalizeOfficeWorkflowPack(settings.officeWorkflowPack ?? "development") !== "development",
    [settings.officeWorkflowPack],
  );
  const scheduleLiveSync = useLiveSyncScheduler({
    setTasks,
    setAgents,
    setSubtasks,
    setStats,
    setDecisionInboxItems,
    shouldIncludeSeedAgents,
  });

  useAppBootstrapData({
    initialRoomThemes,
    hasLocalRoomThemesRef,
    setDepartments,
    setAgents,
    setTasks,
    setStats,
    setSettings,
    setSubtasks,
    setServers,
    setServerAllocations,
    setMeetingPresence,
    setDecisionInboxItems,
    setCustomRoomThemes,
    setLoading,
  });

  useUpdateStatusPolling(setUpdateStatus);
  useAppViewEffects({
    view,
    cliStatus,
    setView,
    setOauthResult,
    setCliStatus,
    setMobileNavOpen,
    setMeetingPresence,
  });

  useRealtimeSync({
    on,
    scheduleLiveSync,
    agentsRef,
    tasksRef,
    subAgentsRef,
    viewRef,
    activeChatRef,
    codexThreadToSubAgentIdRef,
    codexThreadBindingTsRef,
    subAgentStreamTailRef,
    setAgents,
    setMessages,
    setUnreadAgentIds,
    setTaskReport,
    setCrossDeptDeliveries,
    setCeoOfficeCalls,
    setMeetingPresence,
    setSubtasks,
    setSubAgents,
    setStreamingMessage,
    setAutonomousActions,
  });

  const actions = useAppActions({
    agents,
    settings,
    scheduleLiveSync,
    setSettings,
    setAgents,
    setDepartments,
    setTasks,
    setStats,
    setMessages,
    setChatAgent,
    setShowChat,
    setUnreadAgentIds,
    setShowDecisionInbox,
    setDecisionInboxLoading,
    setDecisionInboxItems,
    setDecisionReplyBusyKey,
    setCliStatus,
  });

  const activeMeetingTaskId = useActiveMeetingTaskId(meetingPresence);

  const handleNavigateToServerSettings = useCallback((_serverId: string) => {
    setSettingsInitialTab("servers");
    setView("settings");
  }, []);

  // Clear one-shot settings tab override when navigating away from settings
  useEffect(() => {
    if (view !== "settings") setSettingsInitialTab(undefined);
  }, [view]);

  const refreshServers = useCallback(async () => {
    const [nextServers, nextAllocations] = await Promise.all([
      api.getServers().catch(() => []),
      api.getServerAllocations("active").catch(() => []),
    ]);
    setServers(nextServers);
    setServerAllocations(nextAllocations);
  }, []);

  useEffect(() => {
    const unsub = on("server_update", () => {
      void refreshServers();
    });
    const timer = window.setInterval(() => {
      void refreshServers();
    }, 20_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [on, refreshServers]);

  useEffect(() => {
    if (loading) return;
    getSetupStatus()
      .then((status) => {
        setSetupStatus(status);
        if (!status.onboarding_completed) {
          setShowOnboarding(true);
        }
      })
      .catch(() => {
        // If endpoint fails, skip onboarding
      });
  }, [loading]);

  // Sync theme from DB settings on initial load only
  const settingsThemeRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!settings?.theme) return;
    // Only sync from DB when the DB value itself changes (not on every theme toggle)
    if (settingsThemeRef.current !== settings.theme) {
      settingsThemeRef.current = settings.theme;
      setTheme(settings.theme as "light" | "dark");
    }
  }, [setTheme, settings?.theme]);

  const labels = useAppLabels({
    view,
    settings,
    departments,
    theme,
    runtimeOs,
    forceUpdateBanner,
    updateStatus,
    dismissedUpdateVersion,
  });

  const activePackKey = normalizeOfficeWorkflowPack(settings.officeWorkflowPack ?? "development");
  const activePackProfile =
    activePackKey === "development" ? null : (settings.officePackProfiles?.[activePackKey] ?? null);
  const overlayDepartments = useMemo(
    () =>
      resolvePackDepartmentsForDisplay({
        packKey: activePackKey,
        globalDepartments: departments,
        packDepartments: activePackProfile?.departments ?? null,
      }),
    [activePackKey, activePackProfile?.departments, departments],
  );
  const { mergedAgents: overlayAgents } = useMemo(
    () =>
      resolvePackAgentViews({
        packKey: activePackKey,
        globalAgents: agents,
        packAgents: activePackProfile?.agents ?? null,
      }),
    [activePackKey, activePackProfile?.agents, agents],
  );

  // Memoized handlers passed to AppMainLayout / AppOverlays
  const handleToggleAgentSidebar = useCallback(() => setAgentSidebarOpen((prev) => !prev), []);
  const handleCrossDeptDeliveryProcessed = useCallback(
    (id: string) => setCrossDeptDeliveries((prev) => prev.filter((d) => d.id !== id)),
    [],
  );
  const handleCeoOfficeCallProcessed = useCallback(
    (id: string) => setCeoOfficeCalls((prev) => prev.filter((d) => d.id !== id)),
    [],
  );
  const handleOpenActiveMeetingMinutes = useCallback((taskId: string) => setTaskPanel({ taskId, tab: "minutes" }), []);
  const handleSelectServer = useCallback((server: ServerNode | null) => {
    setSelectedServer(server);
    setShowServerPanel(server !== null);
  }, []);
  const handleSelectDepartmentLayout = useCallback((department: Department) => setSelectedDepartment(department), []);
  const handleOpenTerminalPanel = useCallback((taskId: string) => setTaskPanel({ taskId, tab: "terminal" }), []);
  const handleOpenMeetingMinutesPanel = useCallback((taskId: string) => setTaskPanel({ taskId, tab: "minutes" }), []);
  const handleOauthResultClear = useCallback(() => setOauthResult(null), []);
  const handleOpenAgentStatus = useCallback(() => setShowAgentStatus(true), []);
  const handleOpenReportHistory = useCallback(() => setShowReportHistory(true), []);
  const handleOpenRoomManager = useCallback(() => setShowRoomManager(true), []);
  const handleDismissUpdate = useCallback(() => {
    const latest = labels.effectiveUpdateStatus?.latest_version ?? "";
    setDismissedUpdateVersion(latest);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UPDATE_BANNER_DISMISS_STORAGE_KEY, latest);
    }
  }, [labels.effectiveUpdateStatus?.latest_version]);
  const handleCloseChat = useCallback(() => setShowChat(false), []);
  const handleOpenChat = useCallback(
    (agent?: Agent) => {
      if (agent) {
        actions.handleOpenChat(agent);
      } else {
        setShowChat(true);
      }
    },
    [actions],
  );
  const handleSelectChatAgent = useCallback(
    (agent: Agent | null) => {
      if (agent) {
        actions.handleOpenChat(agent);
      } else {
        setChatAgent(null);
      }
    },
    [actions],
  );

  // AppOverlays memoized handlers
  const handleCloseDecisionInbox = useCallback(() => setShowDecisionInbox(false), [setShowDecisionInbox]);
  const handleRefreshDecisionInbox = useCallback(() => {
    void actions.loadDecisionInbox();
  }, [actions]);
  const handleOpenDecisionDiff = useCallback((taskId: string) => setDiffTaskId(taskId), []);
  const handleOpenDecisionTerminal = useCallback((taskId: string) => {
    setTaskPanel({ taskId, tab: "terminal" });
  }, []);
  const handleOpenDecisionTaskReport = useCallback((taskId: string) => {
    api
      .getTaskReportDetail(taskId)
      .then((detail) => setTaskReport(detail))
      .catch(console.error);
  }, []);
  const handleCloseSelectedDepartment = useCallback(() => setSelectedDepartment(null), []);
  const handleSelectAgentFromDepartment = useCallback((agent: Agent) => {
    setSelectedDepartment(null);
    setSelectedAgent(agent);
  }, []);
  const handleChatFromDepartment = useCallback(
    (agent: Agent) => {
      setSelectedDepartment(null);
      actions.handleOpenChat(agent);
    },
    [actions],
  );
  const handleCloseSelectedAgent = useCallback(() => setSelectedAgent(null), []);
  const handleCloseSelectedServer = useCallback(() => {
    setSelectedServer(null);
    setShowServerPanel(false);
  }, []);
  const handleChatFromAgentDetail = useCallback(
    (agent: Agent) => {
      setSelectedAgent(null);
      actions.handleOpenChat(agent);
    },
    [actions],
  );
  const handleAssignTaskFromAgentDetail = useCallback(() => {
    setSelectedAgent(null);
    setView("tasks");
  }, []);
  const handleOpenTerminalFromAgentDetail = useCallback((taskId: string) => {
    setSelectedAgent(null);
    setTaskPanel({ taskId, tab: "terminal" });
  }, []);
  const handleAgentUpdated = useCallback(() => {
    api
      .getSettings()
      .then(async (nextSettingsRaw) => {
        const nextSettings = mergeSettingsWithDefaults(nextSettingsRaw);
        const activePack = nextSettings.officeWorkflowPack ?? "development";
        const nextAgents = await api.getAgents({ includeSeed: activePack !== "development" });
        setAgents(nextAgents);
        setSettings(nextSettings);

        if (!selectedAgent) return;
        const fromAgents = nextAgents.find((agent) => agent.id === selectedAgent.id);
        if (fromAgents) {
          setSelectedAgent(fromAgents);
          return;
        }

        const profilePackKey = nextSettings.officeWorkflowPack ?? "development";
        const fromPackProfile = nextSettings.officePackProfiles?.[profilePackKey]?.agents?.find(
          (agent) => agent.id === selectedAgent.id,
        );
        if (fromPackProfile) {
          setSelectedAgent(fromPackProfile);
        }
      })
      .catch(console.error);
  }, [selectedAgent]);
  const handleServerUpdated = useCallback(() => {
    void refreshServers();
    if (!selectedServer) return;
    api
      .getServer(selectedServer.id)
      .then((payload) => setSelectedServer(payload.server))
      .catch(() => {
        setSelectedServer(null);
      });
  }, [refreshServers, selectedServer]);
  const handleCloseTaskPanel = useCallback(() => setTaskPanel(null), []);
  const handleCloseTaskReport = useCallback(() => setTaskReport(null), []);
  const handleCloseReportHistory = useCallback(() => setShowReportHistory(false), []);
  const handleCloseAgentStatus = useCallback(() => setShowAgentStatus(false), []);
  const handleRoomThemeChangeOverlay = useCallback(
    (themes: Record<string, RoomTheme>) => {
      handleRoomThemeChange(themes as RoomThemeMap);
    },
    [handleRoomThemeChange],
  );
  const handleCloseRoomManager = useCallback(() => {
    setShowRoomManager(false);
    setActiveRoomThemeTargetId(null);
  }, [setActiveRoomThemeTargetId]);
  const handleCloseDiffModal = useCallback(() => setDiffTaskId(null), []);
  const handleSetupWizardComplete = useCallback(() => {
    setShowOnboarding(false);
    getSetupStatus()
      .then(setSetupStatus)
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <AppLoadingScreen language={labels.uiLanguage} title={labels.loadingTitle} subtitle={labels.loadingSubtitle} />
    );
  }

  return (
    <>
      {showOnboarding && (
        <SetupWizard settings={settings} cliStatus={cliStatus} onComplete={handleSetupWizardComplete} />
      )}
      <AppMainLayout
        connected={connected}
        socketOn={on}
        view={view}
        agentSidebarOpen={agentSidebarOpen}
        onToggleAgentSidebar={handleToggleAgentSidebar}
        setView={setView}
        departments={departments}
        agents={agents}
        stats={stats}
        tasks={tasks}
        subtasks={subtasks}
        subAgents={subAgents}
        meetingPresence={meetingPresence}
        settings={settings}
        cliStatus={cliStatus}
        oauthResult={oauthResult}
        labels={labels}
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
        mobileHeaderMenuOpen={mobileHeaderMenuOpen}
        setMobileHeaderMenuOpen={setMobileHeaderMenuOpen}
        theme={theme}
        toggleTheme={toggleTheme}
        decisionInboxLoading={decisionInboxLoading}
        decisionInboxCount={decisionInboxItems.length}
        activeMeetingTaskId={activeMeetingTaskId}
        unreadAgentIds={unreadAgentIds}
        crossDeptDeliveries={crossDeptDeliveries}
        ceoOfficeCalls={ceoOfficeCalls}
        servers={servers}
        serverAllocations={serverAllocations}
        customRoomThemes={customRoomThemes}
        activeRoomThemeTargetId={activeRoomThemeTargetId}
        onCrossDeptDeliveryProcessed={handleCrossDeptDeliveryProcessed}
        onCeoOfficeCallProcessed={handleCeoOfficeCallProcessed}
        onOpenActiveMeetingMinutes={handleOpenActiveMeetingMinutes}
        onSelectAgent={setSelectedAgent}
        onSelectServer={handleSelectServer}
        onSelectDepartment={handleSelectDepartmentLayout}
        onCreateTask={actions.handleCreateTask}
        onUpdateTask={actions.handleUpdateTask}
        onDeleteTask={actions.handleDeleteTask}
        onAssignTask={actions.handleAssignTask}
        onRunTask={actions.handleRunTask}
        onStopTask={actions.handleStopTask}
        onPauseTask={actions.handlePauseTask}
        onResumeTask={actions.handleResumeTask}
        onOpenTerminal={handleOpenTerminalPanel}
        onOpenMeetingMinutes={handleOpenMeetingMinutesPanel}
        onAgentsChange={actions.handleAgentsChange}
        activeOfficeWorkflowPack={settings.officeWorkflowPack ?? "development"}
        onChangeOfficeWorkflowPack={handleOfficeWorkflowPackChange}
        onSaveSettings={actions.handleSaveSettings}
        onRefreshCli={actions.handleRefreshCli}
        onOauthResultClear={handleOauthResultClear}
        onOpenDecisionInbox={actions.handleOpenDecisionInbox}
        onOpenAgentStatus={handleOpenAgentStatus}
        onOpenReportHistory={handleOpenReportHistory}
        onOpenAnnouncement={actions.handleOpenAnnouncement}
        onOpenRoomManager={handleOpenRoomManager}
        onDismissAutoUpdateNotice={actions.handleDismissAutoUpdateNotice}
        onDismissUpdate={handleDismissUpdate}
        setupStatus={setupStatus}
        officePackBootstrappingLabel={officePackBootstrappingLabel}
        autonomousActions={autonomousActions}
        onNavigateToServerSettings={handleNavigateToServerSettings}
        settingsInitialTab={settingsInitialTab}
        showChat={showChat}
        chatAgent={chatAgent}
        chatMessages={messages}
        chatStreamingMessage={streamingMessage}
        onSendMessage={actions.handleSendMessage}
        onSendAnnouncement={actions.handleSendAnnouncement}
        onSendDirective={actions.handleSendDirective}
        onClearMessages={actions.handleClearMessages}
        onOpenChat={handleOpenChat}
        onCloseChat={handleCloseChat}
        onSelectChatAgent={handleSelectChatAgent}
      >
        <AppOverlays
          chatEmbedded={view === "office"}
          showChat={showChat}
          chatAgent={chatAgent}
          messages={messages}
          agents={overlayAgents}
          streamingMessage={streamingMessage}
          onSendMessage={actions.handleSendMessage}
          onSendAnnouncement={actions.handleSendAnnouncement}
          onSendDirective={actions.handleSendDirective}
          onClearMessages={actions.handleClearMessages}
          onCloseChat={handleCloseChat}
          onSelectChatAgent={handleSelectChatAgent}
          showDecisionInbox={showDecisionInbox}
          decisionInboxLoading={decisionInboxLoading}
          decisionInboxItems={decisionInboxItems}
          decisionReplyBusyKey={decisionReplyBusyKey}
          uiLanguage={labels.uiLanguage}
          onCloseDecisionInbox={handleCloseDecisionInbox}
          onRefreshDecisionInbox={handleRefreshDecisionInbox}
          onReplyDecisionOption={actions.handleReplyDecisionOption}
          onOpenDecisionChat={actions.handleOpenDecisionChat}
          onOpenDecisionDiff={handleOpenDecisionDiff}
          onOpenDecisionTerminal={handleOpenDecisionTerminal}
          onOpenDecisionTaskReport={handleOpenDecisionTaskReport}
          selectedAgent={selectedAgent}
          showServerPanel={showServerPanel}
          selectedServer={selectedServer}
          activeOfficeWorkflowPack={settings.officeWorkflowPack ?? "development"}
          departments={overlayDepartments}
          servers={servers}
          serverAllocations={serverAllocations}
          tasks={tasks}
          subAgents={subAgents}
          subtasks={subtasks}
          selectedDepartment={selectedDepartment}
          onCloseSelectedDepartment={handleCloseSelectedDepartment}
          onSelectAgentFromDepartment={handleSelectAgentFromDepartment}
          onChatFromDepartment={handleChatFromDepartment}
          onCloseSelectedAgent={handleCloseSelectedAgent}
          onCloseSelectedServer={handleCloseSelectedServer}
          onChatFromAgentDetail={handleChatFromAgentDetail}
          onAssignTaskFromAgentDetail={handleAssignTaskFromAgentDetail}
          onOpenTerminalFromAgentDetail={handleOpenTerminalFromAgentDetail}
          onAgentUpdated={handleAgentUpdated}
          onServerUpdated={handleServerUpdated}
          taskPanel={taskPanel}
          onCloseTaskPanel={handleCloseTaskPanel}
          taskReport={taskReport}
          onCloseTaskReport={handleCloseTaskReport}
          showReportHistory={showReportHistory}
          onCloseReportHistory={handleCloseReportHistory}
          showAgentStatus={showAgentStatus}
          onCloseAgentStatus={handleCloseAgentStatus}
          showRoomManager={showRoomManager}
          roomManagerDepartments={labels.roomManagerDepartments}
          customRoomThemes={customRoomThemes}
          onActiveRoomThemeTargetIdChange={setActiveRoomThemeTargetId}
          onRoomThemeChange={handleRoomThemeChangeOverlay}
          onCloseRoomManager={handleCloseRoomManager}
        />
        {diffTaskId && <DiffModal taskId={diffTaskId} onClose={handleCloseDiffModal} />}
        <NotificationToast socketOn={on} />
      </AppMainLayout>
    </>
  );
}
