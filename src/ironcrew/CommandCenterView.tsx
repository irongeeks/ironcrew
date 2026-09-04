/**
 * IronCrew — Command Center.
 *
 * A cinematic HUD built from accessible DOM, not a canvas. Everything here is
 * real backend state: agent status is derived server-side from the work an
 * agent actually holds, so a figure can never disagree with the control plane.
 *
 * There are no placeholder KPIs. Every figure comes from /api/crew/dashboard,
 * which reports its own source and read time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./command-center.css";
import { api, serverErrorCode, serverMessage } from "./api.ts";
import {
  AGENT_STATUS_LABEL,
  BOARD_COLUMNS,
  CHANGE_OPERATION_LABEL,
  CHANGE_PROPOSAL_STATUS_LABEL,
  MEETING_STATUS_LABEL,
  MAILBOX_ACCESS_LABEL,
  MAILBOX_KIND_LABEL,
  MARKETPLACE_ENTRY_TYPE_LABEL,
  MARKETPLACE_KIND_LABEL,
  MARKETPLACE_URL_HINT,
  MEMORY_KIND_LABEL,
  MESSENGER_CHANNEL_LABEL,
  MILESTONE_STATUS_LABEL,
  NOTIFICATION_CHANNEL_LABEL,
  NOTIFICATION_SEVERITY_LABEL,
  PAIRING_ROLE_LABEL,
  PAIRING_STATUS_LABEL,
  PROJECT_STATUS_LABEL,
  RUN_REQUEST_STATUS_LABEL,
  SECRET_PROVIDER_LABEL,
  TASK_STATUS_LABEL,
  TOOL_GRANT_SCOPE_LABEL,
  TOOL_ORIGIN_LABEL,
  TOOL_RISK_CLASS_LABEL,
  TOOL_VIA_LABEL,
  type Agent,
  type AgentTool,
  type Approval,
  type Attachment,
  type ChangeApplyConflict,
  type ChangeProposal,
  type ChangeProposalFile,
  type ChangeProposalStatus,
  type Dashboard,
  type Decision,
  type Department,
  type Goal,
  type KnownHostsPolicy,
  type Mailbox,
  type MailboxAccess,
  type MailboxKind,
  type Marketplace,
  type MarketplaceEntry,
  type MarketplaceInstall,
  type MarketplaceKind,
  type MarketplaceKindStatus,
  type MailMessage,
  type MailProviderStatus,
  type Meeting,
  type MeetingActionItem,
  type MeetingParticipant,
  type MeetingTurn,
  type MemoryKind,
  type MemoryProviderStatus,
  type MemoryRef,
  type MemorySearchHit,
  type Message,
  type MessengerChannelStatus,
  type MessengerPairing,
  type Milestone,
  type Notification,
  type NotificationChannelStatus,
  type PairingRole,
  type Project,
  type RemoteWorker,
  type RunEvent,
  type RunRequest,
  type RunRequestStatus,
  type RuntimeInfo,
  type SchedulerStatus,
  type SearchHits,
  type SearchProviderStatus,
  type Secret,
  type SecretProviderKind,
  type SecretProviderStatus,
  type TailscaleInfo,
  type Talent,
  type Task,
  type TaskStatus,
  type ToolGrantScope,
  type ToolWithGrants,
  type Vessel,
} from "./types.ts";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A duration the way a person would say it.
 *
 * A vessel's limits are stored in milliseconds, but `600000` tells an owner
 * nothing about how long a run may take — "10 min" does. Zero is not a very
 * short limit, it is the absence of one, so it is named as such.
 */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "ohne Limit";
  for (const [size, suffix] of [
    [3_600_000, "h"],
    [60_000, "min"],
    [1000, "s"],
  ] as const) {
    if (ms >= size) {
      const value = ms / size;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} ${suffix}`;
    }
  }
  return `${ms} ms`;
}

/**
 * Skill names out of a talent's stored `skills_json`.
 *
 * The inner shape of that column belongs to whoever authored the talent pack,
 * so anything unreadable yields no tags rather than taking the dialog down.
 */
function talentSkills(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const name = (entry as { name?: unknown } | null)?.name;
        return typeof name === "string" ? name : "";
      })
      .filter((name) => name !== "");
  } catch {
    return [];
  }
}

/** Reads a File as base64 (without the data: URL prefix), for the JSON upload body. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("could not read file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

function eventKind(type: string): "error" | "decision" | "normal" {
  if (type === "run.failed" || type === "tool.failed" || type === "run.cancelled") return "error";
  if (type === "approval.required" || type === "rate_limit.detected" || type === "run.waiting") return "decision";
  return "normal";
}

/**
 * The tool key the search panel goes through.
 *
 * Named here rather than inlined into a sentence, because a refusal that does
 * not say *which* tool was refused sends the operator looking through the
 * whole register.
 */
const WEB_SEARCH_TOOL_KEY = "web.search";

/**
 * Whether one grant needs an approval per use.
 *
 * `requires_approval` is deliberately nullable: NULL means "whatever the risk
 * class implies", not "nein". That is the whole reason an external tool stays
 * gated when someone forgets the field.
 */
function grantRequiresApproval(tool: ToolWithGrants, grant: { requires_approval: number | null }): boolean {
  if (grant.requires_approval === null) return tool.risk_class === "external";
  return grant.requires_approval === 1;
}

export interface CommandCenterViewProps {
  /** Injected in tests; defaults to the live REST client. */
  client?: typeof api;
}

export function CommandCenterView({ client = api }: CommandCenterViewProps): React.JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [companyName, setCompanyName] = useState("IronCrew");
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showOrgChart, setShowOrgChart] = useState(false);
  /**
   * Who is signed in, so the panel can tell "your vote" from "somebody
   * else's". Null on a pre-identity installation, where there is exactly one
   * human and the question does not arise.
   */
  const [myUserId, setMyUserId] = useState<string | null>(null);

  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [secretProviders, setSecretProviders] = useState<SecretProviderStatus[]>([]);
  const [showSecrets, setShowSecrets] = useState(false);
  const [secretTestResults, setSecretTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretProvider, setNewSecretProvider] = useState<SecretProviderKind>("vaultwarden");
  const [newSecretItemRef, setNewSecretItemRef] = useState("");
  const [newSecretField, setNewSecretField] = useState("");

  const [generalAttachments, setGeneralAttachments] = useState<Attachment[]>([]);
  const [showDocuments, setShowDocuments] = useState(false);

  const [tailscaleInfo, setTailscaleInfo] = useState<TailscaleInfo | null>(null);
  const [remoteWorkers, setRemoteWorkers] = useState<RemoteWorker[]>([]);
  const [showNetwork, setShowNetwork] = useState(false);
  const [remoteWorkerTestResults, setRemoteWorkerTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [newWorkerLabel, setNewWorkerLabel] = useState("");
  const [newWorkerEnvironment, setNewWorkerEnvironment] = useState("");
  const [newWorkerHost, setNewWorkerHost] = useState("");
  const [newWorkerSshUser, setNewWorkerSshUser] = useState("");
  const [newWorkerPrivateKeyPath, setNewWorkerPrivateKeyPath] = useState("");
  const [newWorkerKnownHosts, setNewWorkerKnownHosts] = useState<KnownHostsPolicy>("strict");

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [showMeetings, setShowMeetings] = useState(false);
  const [meetingDetail, setMeetingDetail] = useState<{
    meeting: Meeting;
    participants: MeetingParticipant[];
    turns: MeetingTurn[];
    actionItems: MeetingActionItem[];
  } | null>(null);
  const [newMeetingTopic, setNewMeetingTopic] = useState("");
  const [newMeetingModeratorId, setNewMeetingModeratorId] = useState("");
  const [newMeetingParticipantIds, setNewMeetingParticipantIds] = useState<string[]>([]);
  const [newMeetingMaxRounds, setNewMeetingMaxRounds] = useState(6);
  const [newActionItemDescription, setNewActionItemDescription] = useState("");
  const [newActionItemAssigneeId, setNewActionItemAssigneeId] = useState("");
  const [meetingMinutesDraft, setMeetingMinutesDraft] = useState("");

  const [memoryProviders, setMemoryProviders] = useState<MemoryProviderStatus[]>([]);
  const [memories, setMemories] = useState<MemoryRef[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memorySearchHits, setMemorySearchHits] = useState<MemorySearchHit[] | null>(null);
  const [memoryDetail, setMemoryDetail] = useState<{ memory: MemoryRef; content: string } | null>(null);
  const [newMemoryKind, setNewMemoryKind] = useState<MemoryKind>("note");
  const [newMemoryTitle, setNewMemoryTitle] = useState("");
  const [newMemoryContent, setNewMemoryContent] = useState("");

  const [mailProviders, setMailProviders] = useState<MailProviderStatus[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [showMailboxes, setShowMailboxes] = useState(false);
  const [mailboxTestResults, setMailboxTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [mailboxInbox, setMailboxInbox] = useState<{ mailboxId: string; messages: MailMessage[] } | null>(null);
  const [grantDraft, setGrantDraft] = useState<Record<string, { agentId: string; access: MailboxAccess }>>({});
  const [newMailboxLabel, setNewMailboxLabel] = useState("");
  const [newMailboxKind, setNewMailboxKind] = useState<MailboxKind>("imap");
  const [newMailboxAddress, setNewMailboxAddress] = useState("");
  const [newMailboxHost, setNewMailboxHost] = useState("");
  const [newMailboxUsername, setNewMailboxUsername] = useState("");
  const [newMailboxSmtpHost, setNewMailboxSmtpHost] = useState("");
  const [newMailboxSessionUrl, setNewMailboxSessionUrl] = useState("");
  const [newMailboxTenantId, setNewMailboxTenantId] = useState("");
  const [newMailboxClientId, setNewMailboxClientId] = useState("");
  const [newMailboxSecret, setNewMailboxSecret] = useState("");
  const [newMailboxRefreshToken, setNewMailboxRefreshToken] = useState("");
  const [newMailboxPoll, setNewMailboxPoll] = useState(false);
  const [newMailboxAutoTriage, setNewMailboxAutoTriage] = useState(false);
  const [marketplaceKinds, setMarketplaceKinds] = useState<MarketplaceKindStatus[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [marketplaceInstalls, setMarketplaceInstalls] = useState<MarketplaceInstall[]>([]);
  const [showMarketplaces, setShowMarketplaces] = useState(false);
  const [marketplaceEntries, setMarketplaceEntries] = useState<{ id: string; entries: MarketplaceEntry[] } | null>(
    null,
  );
  const [newMarketplaceName, setNewMarketplaceName] = useState("");
  const [newMarketplaceKind, setNewMarketplaceKind] = useState<MarketplaceKind>("catalog");
  const [newMarketplaceUrl, setNewMarketplaceUrl] = useState("");

  const [messengerChannels, setMessengerChannels] = useState<MessengerChannelStatus[]>([]);
  const [pairings, setPairings] = useState<MessengerPairing[]>([]);
  const [showMessenger, setShowMessenger] = useState(false);
  const [messengerPollResults, setMessengerPollResults] = useState<Record<string, string>>({});

  const [changeProposals, setChangeProposals] = useState<ChangeProposal[]>([]);
  const [showChangeProposals, setShowChangeProposals] = useState(false);
  const [proposalStatusFilter, setProposalStatusFilter] = useState<ChangeProposalStatus | "">("");
  const [proposalDetail, setProposalDetail] = useState<{
    proposal: ChangeProposal;
    files: ChangeProposalFile[];
  } | null>(null);
  const [proposalReason, setProposalReason] = useState<Record<string, string>>({});
  const [proposalApplyResults, setProposalApplyResults] = useState<
    Record<string, { applied: string[]; conflicts: ChangeApplyConflict[] }>
  >({});

  // --- vessels & talents: an agent is a vessel × talent pairing ----------
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [talents, setTalents] = useState<Talent[]>([]);
  const [seniorities, setSeniorities] = useState<string[]>([]);
  const [showVessels, setShowVessels] = useState(false);
  // A refused delete belongs on the row it refused. The page-wide error banner
  // sits behind the dialog backdrop, and a 409 here names the agents that
  // still use this vessel — the one piece of text the owner has to read.
  const [vesselErrors, setVesselErrors] = useState<Record<string, string>>({});
  const [talentErrors, setTalentErrors] = useState<Record<string, string>>({});
  const [editVesselId, setEditVesselId] = useState<string | null>(null);
  const [vesselDraft, setVesselDraft] = useState({
    label: "",
    runtimeProvider: "",
    model: "",
    timeoutMin: "",
    maxRetries: "",
    maxConcurrency: "",
  });
  const [editTalentId, setEditTalentId] = useState<string | null>(null);
  const [talentDraft, setTalentDraft] = useState({ professionalRole: "", roleSummary: "", seniority: "" });
  const [newVesselKey, setNewVesselKey] = useState("");
  const [newVesselLabel, setNewVesselLabel] = useState("");
  const [newVesselRuntime, setNewVesselRuntime] = useState("");
  const [newVesselModel, setNewVesselModel] = useState("");
  const [newVesselTimeoutMin, setNewVesselTimeoutMin] = useState("10");
  const [newVesselRetries, setNewVesselRetries] = useState("2");
  const [newVesselConcurrency, setNewVesselConcurrency] = useState("1");
  const [newTalentKey, setNewTalentKey] = useState("");
  const [newTalentRole, setNewTalentRole] = useState("");
  const [newTalentSummary, setNewTalentSummary] = useState("");
  const [newTalentSeniority, setNewTalentSeniority] = useState("");
  // `null` means "whatever the agent is paired with right now" — the drafts
  // only exist once the owner actually picks something else.
  const [pairingVesselId, setPairingVesselId] = useState<string | null>(null);
  const [pairingTalentId, setPairingTalentId] = useState<string | null>(null);

  // --- run queue & scheduler ---------------------------------------------
  const [runQueue, setRunQueue] = useState<RunRequest[]>([]);
  const [showRunQueue, setShowRunQueue] = useState(false);
  const [runQueueStatusFilter, setRunQueueStatusFilter] = useState<RunRequestStatus | "">("");
  const [drainResult, setDrainResult] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);

  // --- tools & search: the register says what, the grants say who ---------
  const [tools, setTools] = useState<ToolWithGrants[]>([]);
  const [showTools, setShowTools] = useState(false);
  // A 409 belongs on the tool it refused: the page-wide banner sits behind
  // this dialog's backdrop, and the server's sentence is the only text that
  // explains why waiving the gate was rejected.
  const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
  const [grantScopeKind, setGrantScopeKind] = useState<Record<string, ToolGrantScope>>({});
  const [grantScopeId, setGrantScopeId] = useState<Record<string, string>>({});
  // "default" is the absence of an opinion, which is not the same as "no":
  // it leaves `requires_approval` NULL, so the risk class keeps deciding.
  const [grantApproval, setGrantApproval] = useState<Record<string, "default" | "required" | "none">>({});
  // The one control in this dialog that removes a safety gate, so it stops
  // and asks before the request is ever built.
  const [waiverToolId, setWaiverToolId] = useState<string | null>(null);

  const [searchProviders, setSearchProviders] = useState<SearchProviderStatus[]>([]);
  const [searchAgentId, setSearchAgentId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // Four separate outcomes, four separate places to say so: hits, a refusal,
  // a waiting approval, and an unreachable provider are not the same event
  // and must not collapse into one grey error line.
  const [searchHits, setSearchHits] = useState<SearchHits | null>(null);
  const [searchDenied, setSearchDenied] = useState<string | null>(null);
  const [searchApprovalId, setSearchApprovalId] = useState<string | null>(null);
  const [searchUnreachable, setSearchUnreachable] = useState<string | null>(null);
  const [searchFailure, setSearchFailure] = useState<string | null>(null);

  // What the agent in the detail dialog may reach for, straight from the gate
  // rather than re-derived here — read-only, because granting happens in the
  // Werkzeuge dialog where the whole register is visible.
  const [agentTools, setAgentTools] = useState<AgentTool[] | null>(null);

  const [notificationChannels, setNotificationChannels] = useState<NotificationChannelStatus[]>([]);
  const [showChannels, setShowChannels] = useState(false);
  const [channelTestResults, setChannelTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showProjectList, setShowProjectList] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [projectDetail, setProjectDetail] = useState<{
    project: Project;
    milestones: Milestone[];
    tasks: Task[];
  } | null>(null);
  const [projectGoalAncestry, setProjectGoalAncestry] = useState<Goal[] | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t, c, ap, d, p, n, dec, who] = await Promise.all([
        client.agents(),
        client.tasks(),
        client.chat(),
        client.approvals(),
        client.dashboard(),
        client.projects(),
        client.notifications(),
        client.decisions(),
        // Refreshed with everything else rather than once at mount: a session
        // can end mid-shift, and a panel that still thinks it knows who you
        // are would hide the vote buttons from the next person to sign in.
        client.authStatus().catch(() => null),
      ]);
      setAgents(a.agents);
      setTasks(t.tasks);
      setMessages(c.messages);
      setApprovals(ap.approvals);
      setDashboard(d);
      setProjects(p.projects);
      setNotifications(n.notifications);
      setUnreadCount(n.unreadCount);
      setDecisions(dec.decisions);
      setMyUserId(who?.user?.id ?? null);
      setError(null);
    } catch (err) {
      // Never fail silently — an unreachable control plane is information.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Attachments are not in the plain `tasks`/project-detail payloads — they
  // need their own fetch, declared early so both the task- and
  // project-detail openers below can load them on open.
  const [taskAttachments, setTaskAttachments] = useState<Attachment[]>([]);
  const [projectAttachments, setProjectAttachments] = useState<Attachment[]>([]);

  const refreshTaskAttachments = useCallback(
    async (taskId: string) => {
      const { attachments } = await client.attachmentsForTask(taskId);
      setTaskAttachments(attachments);
    },
    [client],
  );

  const refreshProjectAttachments = useCallback(
    async (projectId: string) => {
      const { attachments } = await client.attachmentsForProject(projectId);
      setProjectAttachments(attachments);
    },
    [client],
  );

  const openProjectDetail = useCallback(
    async (projectId: string) => {
      setShowProjectList(false);
      try {
        const detail = await client.project(projectId);
        setProjectDetail(detail);
        setProjectGoalAncestry(null);
        void refreshProjectAttachments(projectId);
        if (detail.project.goal_id) {
          // Best-effort: the detail dialog still works without the goal
          // breadcrumb if this second call fails.
          client
            .goal(detail.project.goal_id)
            .then((g) => setProjectGoalAncestry(g.ancestry))
            .catch(() => setProjectGoalAncestry(null));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, refreshProjectAttachments],
  );

  const closeProjectDetail = useCallback(() => {
    setProjectDetail(null);
    setProjectGoalAncestry(null);
  }, []);

  const refreshProjectDetail = useCallback(async () => {
    if (!projectDetail) return;
    const detail = await client.project(projectDetail.project.id);
    setProjectDetail(detail);
  }, [client, projectDetail]);

  // Blocking/blocked-by are not in the plain `tasks` list — they need their
  // own fetch, same shape as the project-detail pattern above.
  const [taskBlockers, setTaskBlockers] = useState<Task[]>([]);
  const [taskBlocking, setTaskBlocking] = useState<Task[]>([]);
  const [addBlockerId, setAddBlockerId] = useState("");

  const refreshTaskDependencies = useCallback(
    async (taskId: string) => {
      try {
        const detail = await client.task(taskId);
        setTaskBlockers(detail.blockers);
        setTaskBlocking(detail.blocking);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client],
  );

  const openTaskDetail = useCallback(
    (t: Task) => {
      setSelectedTask(t);
      setAddBlockerId("");
      void refreshTaskDependencies(t.id);
      void refreshTaskAttachments(t.id);
    },
    [refreshTaskDependencies, refreshTaskAttachments],
  );

  // Provider Health: kept separate from refresh() — each registered runtime
  // probes its own CLI (e.g. `claude --version`), so this is refreshed on
  // demand from the agent-detail dialog rather than on every poll.
  const refreshRuntimes = useCallback(async () => {
    try {
      const { runtimes: r } = await client.runtimes();
      setRuntimes(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Both catalogues are small and always read together: the pairing dropdowns
  // in the agent detail need them, and so does the Vessels & Talente dialog.
  const refreshVesselsAndTalents = useCallback(async () => {
    try {
      const [{ vessels: v }, { talents: t }] = await Promise.all([client.vessels(), client.talents()]);
      setVessels(v);
      setTalents(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Shared by the roster and the org chart — the same agent-detail dialog
  // opens from either place.
  const openAgentDetail = useCallback(
    (agent: Agent) => {
      setSelectedAgent(agent);
      setPairingVesselId(null);
      setPairingTalentId(null);
      setAgentTools(null);
      void refreshRuntimes();
      // Which vessel and talent this agent sits in is read back out of the
      // catalogues rather than from a duplicated field on the agent, so the
      // dropdowns can never disagree with the lists they are filled from.
      void refreshVesselsAndTalents();
      // Asked of the gate rather than assembled from the grant list here:
      // precedence is agent > project > talent, and only the server applies
      // it, so anything computed in the UI could disagree with the answer a
      // run actually gets.
      client
        .agentTools(agent.id)
        .then((r) => setAgentTools(r.tools))
        .catch(() => setAgentTools([]));
    },
    [client, refreshRuntimes, refreshVesselsAndTalents],
  );

  useEffect(() => {
    void refresh();
    client
      .company()
      .then((r) => {
        setCompanyName(r.company.name);
        setDepartments(r.departments);
      })
      .catch(() => {
        /* header falls back to the default name; org chart stays empty */
      });
  }, [refresh, client]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    // Element.scrollTo is absent in jsdom and in some older embedded webviews;
    // assigning scrollTop works everywhere and has the same effect here.
    if (typeof log.scrollTo === "function") log.scrollTo({ top: log.scrollHeight });
    else log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.sendMessage(body);
      setDraft("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, client, refresh]);

  const runNext = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.executeNext();
      if (result.executed && result.runId) {
        const { events: runEvents } = await client.runEvents(result.runId);
        setEvents((prev) => [...prev, ...runEvents].slice(-200));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  // Shared mutation-dispatch shape: set busy, run the mutation, then run
  // whichever read-back keeps that dialog's own data current — `refresh()`
  // for the main poll, or a dialog-scoped refresher (refreshSecrets(),
  // refreshTaskAttachments(), ...) for state `refresh()` doesn't cover.
  const actWith = useCallback(async (fn: () => Promise<unknown>, after: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback((fn: () => Promise<unknown>) => actWith(fn, refresh), [actWith, refresh]);

  const markNotificationRead = useCallback(
    (id: string) => {
      void act(() => client.markNotificationRead(id));
    },
    [act, client],
  );

  // --- secrets (password-manager integration) -----------------------------

  const refreshSecrets = useCallback(async () => {
    const { secrets: s } = await client.secrets();
    setSecrets(s);
  }, [client]);

  const openSecrets = useCallback(() => {
    setShowSecrets(true);
    setSecretTestResults({});
    void refreshSecrets();
    client
      .secretProviders()
      .then((r) => setSecretProviders(r.providers))
      .catch(() => setSecretProviders([]));
  }, [client, refreshSecrets]);

  const createSecret = useCallback(() => {
    const name = newSecretName.trim();
    const itemRef = newSecretItemRef.trim();
    if (!name || !itemRef) return;
    void actWith(
      () =>
        client.createSecret({
          name,
          provider: newSecretProvider,
          itemRef,
          field: newSecretField.trim() || undefined,
        }),
      async () => {
        setNewSecretName("");
        setNewSecretItemRef("");
        setNewSecretField("");
        await refreshSecrets();
      },
    );
  }, [actWith, client, newSecretName, newSecretProvider, newSecretItemRef, newSecretField, refreshSecrets]);

  const deleteSecret = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteSecret(id),
        async () => {
          setSecretTestResults((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          await refreshSecrets();
        },
      );
    },
    [actWith, client, refreshSecrets],
  );

  const testSecret = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.testSecret(id);
          setSecretTestResults((prev) => ({
            ...prev,
            [id]: { ok: result.ok, message: result.ok ? `OK (${result.length ?? 0} Zeichen)` : (result.message ?? "") },
          }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- network (Tailscale/Headscale status + remote workers over the tailnet) ---

  const refreshRemoteWorkers = useCallback(async () => {
    const { remoteWorkers: w } = await client.remoteWorkers();
    setRemoteWorkers(w);
  }, [client]);

  const openNetwork = useCallback(() => {
    setShowNetwork(true);
    setRemoteWorkerTestResults({});
    void refreshRemoteWorkers();
    client
      .tailscale()
      .then(setTailscaleInfo)
      .catch((err) =>
        setTailscaleInfo({ backendState: "Unknown", self: null, peers: [], ok: false, message: String(err) }),
      );
  }, [client, refreshRemoteWorkers]);

  const createRemoteWorker = useCallback(() => {
    const label = newWorkerLabel.trim();
    const host = newWorkerHost.trim();
    const sshUser = newWorkerSshUser.trim();
    const privateKeyPath = newWorkerPrivateKeyPath.trim();
    if (!label || !host || !sshUser || !privateKeyPath) return;
    void actWith(
      () =>
        client.createRemoteWorker({
          label,
          environment: newWorkerEnvironment.trim() || undefined,
          host,
          sshUser,
          privateKeyPath,
          knownHostsPolicy: newWorkerKnownHosts,
        }),
      async () => {
        setNewWorkerLabel("");
        setNewWorkerEnvironment("");
        setNewWorkerHost("");
        setNewWorkerSshUser("");
        setNewWorkerPrivateKeyPath("");
        await refreshRemoteWorkers();
      },
    );
  }, [
    actWith,
    client,
    newWorkerLabel,
    newWorkerEnvironment,
    newWorkerHost,
    newWorkerSshUser,
    newWorkerPrivateKeyPath,
    newWorkerKnownHosts,
    refreshRemoteWorkers,
  ]);

  const deleteRemoteWorker = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteRemoteWorker(id),
        async () => {
          setRemoteWorkerTestResults((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          await refreshRemoteWorkers();
        },
      );
    },
    [actWith, client, refreshRemoteWorkers],
  );

  const testRemoteWorker = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.testRemoteWorker(id);
          setRemoteWorkerTestResults((prev) => ({ ...prev, [id]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- meetings (moderator, bounded rounds, budget) -----------------------
  // One round is one participant's turn, so a meeting self-closes on its own
  // once max_rounds (or its budget cap) is reached — "Nächste Wortmeldung"
  // after that is a harmless no-op the backend reports with turn: null.

  const refreshMeetings = useCallback(async () => {
    const { meetings: m } = await client.meetings();
    setMeetings(m);
  }, [client]);

  const openMeetings = useCallback(() => {
    setShowMeetings(true);
    void refreshMeetings();
  }, [refreshMeetings]);

  const openMeetingDetail = useCallback(
    async (id: string) => {
      const detail = await client.meeting(id);
      setMeetingDetail(detail);
      setMeetingMinutesDraft(detail.meeting.minutes);
    },
    [client],
  );

  const refreshMeetingDetail = useCallback(async () => {
    if (!meetingDetail) return;
    const detail = await client.meeting(meetingDetail.meeting.id);
    setMeetingDetail(detail);
  }, [client, meetingDetail]);

  const closeMeetingDetail = useCallback(() => {
    setMeetingDetail(null);
    setNewActionItemDescription("");
    setNewActionItemAssigneeId("");
  }, []);

  const toggleMeetingParticipant = useCallback((agentId: string) => {
    setNewMeetingParticipantIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  }, []);

  const createMeeting = useCallback(() => {
    const topic = newMeetingTopic.trim();
    if (!topic || !newMeetingModeratorId || newMeetingParticipantIds.length === 0) return;
    void actWith(
      () =>
        client.createMeeting({
          topic,
          moderatorAgentId: newMeetingModeratorId,
          participantAgentIds: newMeetingParticipantIds,
          maxRounds: newMeetingMaxRounds,
        }),
      async () => {
        setNewMeetingTopic("");
        setNewMeetingParticipantIds([]);
        await refreshMeetings();
      },
    );
  }, [
    actWith,
    client,
    newMeetingTopic,
    newMeetingModeratorId,
    newMeetingParticipantIds,
    newMeetingMaxRounds,
    refreshMeetings,
  ]);

  const startMeeting = useCallback(
    (id: string) => {
      void actWith(
        () => client.startMeeting(id),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const nextMeetingTurn = useCallback(
    (id: string, agentId?: string) => {
      void actWith(
        () => client.nextMeetingTurn(id, agentId),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const endMeeting = useCallback(
    (id: string, minutes: string) => {
      void actWith(
        () => client.endMeeting(id, minutes),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const cancelMeeting = useCallback(
    (id: string) => {
      void actWith(
        () => client.cancelMeeting(id),
        async () => {
          await refreshMeetings();
          closeMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, closeMeetingDetail],
  );

  const addMeetingActionItem = useCallback(
    (id: string) => {
      const description = newActionItemDescription.trim();
      if (!description) return;
      void actWith(
        () =>
          client.addMeetingActionItem(id, {
            description,
            assignedAgentId: newActionItemAssigneeId || undefined,
          }),
        async () => {
          setNewActionItemDescription("");
          setNewActionItemAssigneeId("");
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, newActionItemDescription, newActionItemAssigneeId, refreshMeetingDetail],
  );

  const convertActionItem = useCallback(
    (actionItemId: string) => {
      void actWith(
        () => client.convertActionItemToTask(actionItemId),
        async () => {
          await refreshMeetingDetail();
          await refresh();
        },
      );
    },
    [actWith, client, refreshMeetingDetail, refresh],
  );

  // --- memory (the Obsidian vault, the first MemoryProvider) --------------

  const refreshMemory = useCallback(async () => {
    const [{ providers }, { memories: m }] = await Promise.all([client.memoryProviders(), client.memories()]);
    setMemoryProviders(providers);
    setMemories(m);
  }, [client]);

  const openMemory = useCallback(() => {
    setShowMemory(true);
    setMemorySearchHits(null);
    setMemoryQuery("");
    void refreshMemory();
  }, [refreshMemory]);

  const recordMemory = useCallback(() => {
    const title = newMemoryTitle.trim();
    const content = newMemoryContent.trim();
    const provider = memoryProviders[0]?.kind;
    if (!title || !content || !provider) return;
    void actWith(
      () => client.recordMemory({ provider, kind: newMemoryKind, title, content }),
      async () => {
        setNewMemoryTitle("");
        setNewMemoryContent("");
        await refreshMemory();
      },
    );
  }, [actWith, client, newMemoryKind, newMemoryTitle, newMemoryContent, memoryProviders, refreshMemory]);

  const openMemoryDetail = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.memoryContent(id);
          setMemoryDetail(result);
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const deleteMemoryEntry = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteMemory(id),
        async () => {
          setMemoryDetail(null);
          await refreshMemory();
        },
      );
    },
    [actWith, client, refreshMemory],
  );

  const searchMemory = useCallback(() => {
    const query = memoryQuery.trim();
    const provider = memoryProviders[0]?.kind;
    if (!query || !provider) return;
    void actWith(
      async () => {
        const { hits } = await client.searchMemory(provider, query);
        setMemorySearchHits(hits);
      },
      async () => {},
    );
  }, [actWith, client, memoryQuery, memoryProviders]);

  // --- mailboxes (IMAP/JMAP/M365/Gmail, n:n against agents) ---------------

  const refreshMailboxes = useCallback(async () => {
    const [{ providers }, { mailboxes: list }] = await Promise.all([client.mailProviders(), client.mailboxes()]);
    setMailProviders(providers);
    setMailboxes(list);
  }, [client]);

  const openMailboxes = useCallback(() => {
    setShowMailboxes(true);
    setMailboxTestResults({});
    setMailboxInbox(null);
    void refreshMailboxes();
  }, [refreshMailboxes]);

  const createMailbox = useCallback(() => {
    const label = newMailboxLabel.trim();
    const emailAddress = newMailboxAddress.trim();
    if (!label || !emailAddress) return;

    // Only the fields the chosen kind actually needs are sent; the server
    // validates the same rule again (mailbox-store.ts#assertConnectable).
    const credentials =
      newMailboxKind === "jmap"
        ? { bearerToken: newMailboxSecret || undefined }
        : newMailboxKind === "imap"
          ? { password: newMailboxSecret || undefined }
          : { clientSecret: newMailboxSecret || undefined, refreshToken: newMailboxRefreshToken || undefined };

    void actWith(
      () =>
        client.createMailbox({
          label,
          kind: newMailboxKind,
          emailAddress,
          host: newMailboxHost.trim() || undefined,
          username: newMailboxUsername.trim() || undefined,
          smtpHost: newMailboxSmtpHost.trim() || undefined,
          sessionUrl: newMailboxSessionUrl.trim() || undefined,
          tenantId: newMailboxTenantId.trim() || undefined,
          clientId: newMailboxClientId.trim() || undefined,
          credentials,
          pollEnabled: newMailboxPoll,
          autoTriage: newMailboxAutoTriage,
        }),
      async () => {
        setNewMailboxLabel("");
        setNewMailboxAddress("");
        setNewMailboxHost("");
        setNewMailboxUsername("");
        setNewMailboxSmtpHost("");
        setNewMailboxSessionUrl("");
        setNewMailboxTenantId("");
        setNewMailboxClientId("");
        setNewMailboxSecret("");
        setNewMailboxRefreshToken("");
        setNewMailboxPoll(false);
        setNewMailboxAutoTriage(false);
        await refreshMailboxes();
      },
    );
  }, [
    actWith,
    client,
    newMailboxLabel,
    newMailboxKind,
    newMailboxAddress,
    newMailboxHost,
    newMailboxUsername,
    newMailboxSmtpHost,
    newMailboxSessionUrl,
    newMailboxTenantId,
    newMailboxClientId,
    newMailboxSecret,
    newMailboxRefreshToken,
    newMailboxPoll,
    newMailboxAutoTriage,
    refreshMailboxes,
  ]);

  const testMailbox = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.testMailbox(id);
          setMailboxTestResults((prev) => ({ ...prev, [id]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const deleteMailbox = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteMailbox(id),
        async () => {
          setMailboxInbox((prev) => (prev?.mailboxId === id ? null : prev));
          await refreshMailboxes();
        },
      );
    },
    [actWith, client, refreshMailboxes],
  );

  const toggleMailboxSetting = useCallback(
    (mailbox: Mailbox, patch: { pollEnabled?: boolean; autoTriage?: boolean }) => {
      void actWith(() => client.updateMailbox(mailbox.id, patch), refreshMailboxes);
    },
    [actWith, client, refreshMailboxes],
  );

  const grantMailboxAgent = useCallback(
    (mailboxId: string) => {
      const draft = grantDraft[mailboxId];
      if (!draft?.agentId) return;
      void actWith(
        () => client.grantMailboxAgent(mailboxId, draft.agentId, draft.access ?? "read"),
        async () => {
          setGrantDraft((prev) => ({ ...prev, [mailboxId]: { agentId: "", access: "read" } }));
          await refreshMailboxes();
        },
      );
    },
    [actWith, client, grantDraft, refreshMailboxes],
  );

  const revokeMailboxAgent = useCallback(
    (mailboxId: string, agentId: string) => {
      void actWith(() => client.revokeMailboxAgent(mailboxId, agentId), refreshMailboxes);
    },
    [actWith, client, refreshMailboxes],
  );

  const openMailboxInbox = useCallback(
    (mailboxId: string) => {
      void actWith(
        async () => {
          const { messages } = await client.mailboxMessages(mailboxId);
          setMailboxInbox({ mailboxId, messages });
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const pollMailbox = useCallback(
    (mailboxId: string) => {
      void actWith(
        async () => {
          const result = await client.pollMailbox(mailboxId);
          setMailboxTestResults((prev) => ({
            ...prev,
            [mailboxId]: {
              ok: true,
              message: `${result.newMessages} neu, ${result.tasksCreated} Aufgabe${result.tasksCreated === 1 ? "" : "n"}`,
            },
          }));
        },
        async () => {
          await refreshMailboxes();
          await refresh();
        },
      );
    },
    [actWith, client, refreshMailboxes, refresh],
  );

  // --- marketplaces (skills and MCP servers from outside this machine) -----

  const refreshMarketplaces = useCallback(async () => {
    const [{ kinds }, { marketplaces: list, installs }] = await Promise.all([
      client.marketplaceKinds(),
      client.marketplaces(),
    ]);
    setMarketplaceKinds(kinds);
    setMarketplaces(list);
    setMarketplaceInstalls(installs);
  }, [client]);

  const openMarketplaces = useCallback(() => {
    setShowMarketplaces(true);
    setMarketplaceEntries(null);
    void refreshMarketplaces();
  }, [refreshMarketplaces]);

  const createMarketplace = useCallback(() => {
    const name = newMarketplaceName.trim();
    const url = newMarketplaceUrl.trim();
    if (!name || !url) return;
    void actWith(
      () => client.createMarketplace({ name, kind: newMarketplaceKind, url }),
      async () => {
        setNewMarketplaceName("");
        setNewMarketplaceUrl("");
        await refreshMarketplaces();
      },
    );
  }, [actWith, client, newMarketplaceName, newMarketplaceKind, newMarketplaceUrl, refreshMarketplaces]);

  const deleteMarketplace = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteMarketplace(id),
        async () => {
          setMarketplaceEntries((prev) => (prev?.id === id ? null : prev));
          await refreshMarketplaces();
        },
      );
    },
    [actWith, client, refreshMarketplaces],
  );

  const toggleMarketplace = useCallback(
    (marketplace: Marketplace) => {
      void actWith(
        () => client.updateMarketplace(marketplace.id, { enabled: marketplace.enabled !== 1 }),
        refreshMarketplaces,
      );
    },
    [actWith, client, refreshMarketplaces],
  );

  const browseMarketplace = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const { entries } = await client.marketplaceEntries(id);
          setMarketplaceEntries({ id, entries });
        },
        // A browse records its outcome on the row (entry count, or the
        // reason it failed), so the list is refreshed either way.
        refreshMarketplaces,
      );
    },
    [actWith, client, refreshMarketplaces],
  );

  const installEntry = useCallback(
    (marketplaceId: string, entry: MarketplaceEntry) => {
      // Variables the entry declares but cannot carry (API keys and the
      // like) are asked for here, one prompt each, rather than installing
      // with an empty value that fails on first connect.
      const env: Record<string, string> = {};
      for (const key of Object.keys(entry.mcp?.env ?? {})) {
        const value = window.prompt(`Wert für ${key} (${entry.title})`, "");
        if (value === null) return;
        env[key] = value;
      }
      void actWith(() => client.installFromMarketplace(marketplaceId, { entryId: entry.id, env }), refreshMarketplaces);
    },
    [actWith, client, refreshMarketplaces],
  );

  const uninstallEntry = useCallback(
    (install: MarketplaceInstall) => {
      void actWith(() => client.uninstallFromMarketplace(install.entry_type, install.name), refreshMarketplaces);
    },
    [actWith, client, refreshMarketplaces],
  );

  // --- messenger pairings (who may talk to the EA, and with what authority) -

  const refreshMessenger = useCallback(async () => {
    const [{ channels }, { pairings: list }] = await Promise.all([
      client.messengerChannels(),
      client.messengerPairings(),
    ]);
    setMessengerChannels(channels);
    setPairings(list);
  }, [client]);

  const openMessenger = useCallback(() => {
    setShowMessenger(true);
    setMessengerPollResults({});
    void refreshMessenger();
  }, [refreshMessenger]);

  const pollMessengerChannel = useCallback(
    (kind: string) => {
      void actWith(
        async () => {
          const result = await client.pollMessengerChannel(kind);
          setMessengerPollResults((prev) => ({
            ...prev,
            [kind]: `${result.received} empfangen · ${result.handled} bearbeitet · ${result.pairingPrompts} wartet auf Freigabe`,
          }));
        },
        // A poll is what turns an unknown sender into a pending row with a
        // code, so the list has to be re-read or that code is nowhere to be
        // seen.
        refreshMessenger,
      );
    },
    [actWith, client, refreshMessenger],
  );

  const acceptPairing = useCallback(
    (id: string, role: PairingRole) => {
      void actWith(() => client.acceptMessengerPairing(id, role), refreshMessenger);
    },
    [actWith, client, refreshMessenger],
  );

  const blockPairing = useCallback(
    (id: string) => {
      void actWith(() => client.blockMessengerPairing(id), refreshMessenger);
    },
    [actWith, client, refreshMessenger],
  );

  const revokePairing = useCallback(
    (id: string) => {
      void actWith(() => client.revokeMessengerPairing(id), refreshMessenger);
    },
    [actWith, client, refreshMessenger],
  );

  const unblockPairing = useCallback(
    (id: string) => {
      void actWith(() => client.unblockMessengerPairing(id), refreshMessenger);
    },
    [actWith, client, refreshMessenger],
  );

  // --- change proposals (nothing is written until the CEO approves) --------

  const refreshChangeProposals = useCallback(
    async (status: ChangeProposalStatus | "") => {
      const { proposals } = await client.changeProposals(status === "" ? undefined : status);
      setChangeProposals(proposals);
    },
    [client],
  );

  const openChangeProposals = useCallback(() => {
    setShowChangeProposals(true);
    setProposalDetail(null);
    setProposalApplyResults({});
    void refreshChangeProposals(proposalStatusFilter);
  }, [refreshChangeProposals, proposalStatusFilter]);

  const filterChangeProposals = useCallback(
    (status: ChangeProposalStatus | "") => {
      setProposalStatusFilter(status);
      setProposalDetail(null);
      void actWith(
        () => refreshChangeProposals(status),
        async () => {},
      );
    },
    [actWith, refreshChangeProposals],
  );

  const openProposalDetail = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const detail = await client.changeProposal(id);
          setProposalDetail(detail);
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const decideProposal = useCallback(
    (id: string, decision: "approved" | "rejected") => {
      const reason = proposalReason[id]?.trim();
      void actWith(
        () => client.decideChangeProposal(id, decision, decision === "rejected" ? reason || undefined : undefined),
        async () => {
          setProposalReason((prev) => ({ ...prev, [id]: "" }));
          await refreshChangeProposals(proposalStatusFilter);
        },
      );
    },
    [actWith, client, proposalReason, proposalStatusFilter, refreshChangeProposals],
  );

  const applyProposal = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.applyChangeProposal(id);
          setProposalApplyResults((prev) => ({
            ...prev,
            [id]: { applied: result.applied, conflicts: result.conflicts },
          }));
        },
        // Apply is all-or-nothing, so the row's own status is the only honest
        // report of what happened — re-read it rather than assuming success.
        () => refreshChangeProposals(proposalStatusFilter),
      );
    },
    [actWith, client, proposalStatusFilter, refreshChangeProposals],
  );

  // --- vessels & talents (a vessel is *how* a run may go, never *what*) ----

  const openVessels = useCallback(() => {
    setShowVessels(true);
    setVesselErrors({});
    setTalentErrors({});
    setEditVesselId(null);
    setEditTalentId(null);
    void refreshVesselsAndTalents();
    // The runtime list fills the vessel's runtime dropdown; the seniority
    // vocabulary is the server's to define, so it is asked for rather than
    // hardcoded here where it would drift.
    void refreshRuntimes();
    client
      .talentSeniorities()
      .then((r) => setSeniorities(r.seniorities))
      .catch(() => setSeniorities([]));
  }, [client, refreshRuntimes, refreshVesselsAndTalents]);

  /** Minutes in the form, milliseconds on the wire — `0`/blank means "leave it". */
  const timeoutMsFrom = useCallback((minutes: string): number | undefined => {
    const value = Number(minutes);
    return Number.isFinite(value) && value > 0 ? Math.round(value * 60_000) : undefined;
  }, []);

  const countFrom = useCallback((raw: string, min: number): number | undefined => {
    const value = Number(raw);
    return Number.isFinite(value) && raw.trim() !== "" && value >= min ? Math.round(value) : undefined;
  }, []);

  const createVessel = useCallback(() => {
    const key = newVesselKey.trim();
    const runtimeProvider = newVesselRuntime.trim();
    if (!key || !runtimeProvider) return;
    void actWith(
      () =>
        client.createVessel({
          key,
          label: newVesselLabel.trim() || undefined,
          runtimeProvider,
          model: newVesselModel.trim() || undefined,
          timeoutMs: timeoutMsFrom(newVesselTimeoutMin),
          maxRetries: countFrom(newVesselRetries, 0),
          maxConcurrency: countFrom(newVesselConcurrency, 1),
        }),
      async () => {
        setNewVesselKey("");
        setNewVesselLabel("");
        setNewVesselModel("");
        await refreshVesselsAndTalents();
      },
    );
  }, [
    actWith,
    client,
    countFrom,
    newVesselConcurrency,
    newVesselKey,
    newVesselLabel,
    newVesselModel,
    newVesselRetries,
    newVesselRuntime,
    newVesselTimeoutMin,
    refreshVesselsAndTalents,
    timeoutMsFrom,
  ]);

  const startEditVessel = useCallback((vessel: Vessel) => {
    setEditVesselId(vessel.id);
    setVesselDraft({
      label: vessel.label,
      runtimeProvider: vessel.runtime_provider,
      model: vessel.model,
      timeoutMin: String(vessel.timeout_ms / 60_000),
      maxRetries: String(vessel.max_retries),
      maxConcurrency: String(vessel.max_concurrency),
    });
  }, []);

  const saveVessel = useCallback(
    (id: string) => {
      void actWith(
        () =>
          client.updateVessel(id, {
            label: vesselDraft.label.trim(),
            runtimeProvider: vesselDraft.runtimeProvider,
            model: vesselDraft.model.trim(),
            timeoutMs: timeoutMsFrom(vesselDraft.timeoutMin),
            maxRetries: countFrom(vesselDraft.maxRetries, 0),
            maxConcurrency: countFrom(vesselDraft.maxConcurrency, 1),
          }),
        async () => {
          setEditVesselId(null);
          await refreshVesselsAndTalents();
        },
      );
    },
    [actWith, client, countFrom, refreshVesselsAndTalents, timeoutMsFrom, vesselDraft],
  );

  const deleteVessel = useCallback(
    (id: string) => {
      void actWith(async () => {
        setVesselErrors((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        try {
          await client.deleteVessel(id);
        } catch (err) {
          // A 409 here is a refusal, not a transport failure: agents still
          // run in this vessel and the server's message is what names them.
          // It has to land on the row, because the page-wide banner is
          // hidden behind this dialog's backdrop.
          setVesselErrors((prev) => ({ ...prev, [id]: serverMessage(err) }));
        }
      }, refreshVesselsAndTalents);
    },
    [actWith, client, refreshVesselsAndTalents],
  );

  const createTalent = useCallback(() => {
    const key = newTalentKey.trim();
    const professionalRole = newTalentRole.trim();
    if (!key || !professionalRole) return;
    void actWith(
      () =>
        client.createTalent({
          key,
          professionalRole,
          roleSummary: newTalentSummary.trim() || undefined,
          seniority: newTalentSeniority || undefined,
        }),
      async () => {
        setNewTalentKey("");
        setNewTalentRole("");
        setNewTalentSummary("");
        await refreshVesselsAndTalents();
      },
    );
  }, [actWith, client, newTalentKey, newTalentRole, newTalentSeniority, newTalentSummary, refreshVesselsAndTalents]);

  const startEditTalent = useCallback((talent: Talent) => {
    setEditTalentId(talent.id);
    setTalentDraft({
      professionalRole: talent.professional_role,
      roleSummary: talent.role_summary,
      seniority: talent.seniority,
    });
  }, []);

  const saveTalent = useCallback(
    (id: string) => {
      void actWith(
        () =>
          client.updateTalent(id, {
            professionalRole: talentDraft.professionalRole.trim(),
            roleSummary: talentDraft.roleSummary.trim(),
            seniority: talentDraft.seniority,
          }),
        async () => {
          setEditTalentId(null);
          await refreshVesselsAndTalents();
        },
      );
    },
    [actWith, client, refreshVesselsAndTalents, talentDraft],
  );

  const deleteTalent = useCallback(
    (id: string) => {
      void actWith(async () => {
        setTalentErrors((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        try {
          await client.deleteTalent(id);
        } catch (err) {
          // Same refusal as a vessel delete: the message names the agents.
          setTalentErrors((prev) => ({ ...prev, [id]: serverMessage(err) }));
        }
      }, refreshVesselsAndTalents);
    },
    [actWith, client, refreshVesselsAndTalents],
  );

  // --- tools & search -----------------------------------------------------
  //
  // Two tables, two statements: the register says what this server *can*
  // perform, the grants say who *may*. Nothing here registers a tool — that
  // happens at start-up and on install — so everything this dialog does is
  // about permission, and the register is only shown so the operator can see
  // what there is to permit.

  const refreshTools = useCallback(async () => {
    const { tools: rows } = await client.tools();
    setTools(rows);
  }, [client]);

  const openTools = useCallback(() => {
    setShowTools(true);
    setToolErrors({});
    setWaiverToolId(null);
    // A refusal or a hit list from the last time this dialog was open says
    // nothing about the query nobody has typed yet.
    setSearchHits(null);
    setSearchDenied(null);
    setSearchApprovalId(null);
    setSearchUnreachable(null);
    setSearchFailure(null);
    void actWith(
      async () => {
        // Talents are not in the main poll, and a grant that names one has to
        // be able to say whose role it is rather than printing an id.
        await Promise.all([refreshTools(), refreshVesselsAndTalents()]);
        // A provider that is configured but unreachable is information, not a
        // failure of this dialog, so it must not take the register down with it.
        await client
          .searchProviders()
          .then((r) => setSearchProviders(r.providers))
          .catch(() => setSearchProviders([]));
      },
      async () => {},
    );
  }, [actWith, client, refreshTools, refreshVesselsAndTalents]);

  const setToolEnabled = useCallback(
    (toolId: string, enabled: boolean) => {
      void actWith(() => client.setToolEnabled(toolId, enabled), refreshTools);
    },
    [actWith, client, refreshTools],
  );

  const revokeToolGrant = useCallback(
    (grantId: string) => {
      void actWith(() => client.revokeToolGrant(grantId), refreshTools);
    },
    [actWith, client, refreshTools],
  );

  /**
   * Sends one grant.
   *
   * Waiving the approval on an `external` tool is the single control in this
   * dialog that takes a gate away, so the first click only asks: the request
   * that carries `allowUnapprovedExternal` is built exclusively on the second,
   * confirmed one. The server refuses the flagless version anyway — this is so
   * the operator meets the question before the server does.
   */
  const submitGrant = useCallback(
    (tool: ToolWithGrants, confirmedWaiver = false) => {
      const kind = grantScopeKind[tool.id] ?? "agent";
      const scopeId = grantScopeId[tool.id] ?? "";
      if (scopeId === "") return;
      const approval = grantApproval[tool.id] ?? "default";
      const requiresApproval = approval === "default" ? null : approval === "required";

      if (requiresApproval === false && tool.risk_class === "external" && !confirmedWaiver) {
        setWaiverToolId(tool.id);
        return;
      }

      const scope =
        kind === "agent" ? { agentId: scopeId } : kind === "project" ? { projectId: scopeId } : { talentId: scopeId };

      void actWith(async () => {
        setToolErrors((prev) => {
          const next = { ...prev };
          delete next[tool.id];
          return next;
        });
        try {
          await client.grantTool(tool.id, {
            ...scope,
            requiresApproval,
            ...(confirmedWaiver ? { allowUnapprovedExternal: true } : {}),
          });
          setWaiverToolId(null);
          setGrantScopeId((prev) => ({ ...prev, [tool.id]: "" }));
        } catch (err) {
          // 409 invalid_tool_mutation: the message explains why the waiver was
          // refused, and no wording of ours could say it better.
          setToolErrors((prev) => ({ ...prev, [tool.id]: serverMessage(err) }));
        }
      }, refreshTools);
    },
    [actWith, client, grantApproval, grantScopeId, grantScopeKind, refreshTools],
  );

  /** Whom a grant is for, by name — falling back to the id it stores. */
  const grantHolder = useCallback(
    (grant: { agent_id: string | null; talent_id: string | null; project_id: string | null }): string => {
      if (grant.agent_id) {
        const found = agents.find((a) => a.id === grant.agent_id);
        return `Agent: ${found ? found.displayName : grant.agent_id}`;
      }
      if (grant.project_id) {
        const found = projects.find((p) => p.id === grant.project_id);
        return `Projekt: ${found ? found.title : grant.project_id}`;
      }
      if (grant.talent_id) {
        const found = talents.find((t) => t.id === grant.talent_id);
        return `Talent: ${found ? found.professional_role : grant.talent_id}`;
      }
      return "—";
    },
    [agents, projects, talents],
  );

  const runSearch = useCallback(() => {
    const query = searchQuery.trim();
    if (query === "" || searchAgentId === "") return;
    setSearchHits(null);
    setSearchDenied(null);
    setSearchApprovalId(null);
    setSearchUnreachable(null);
    setSearchFailure(null);
    void actWith(
      async () => {
        try {
          const outcome = await client.search({ agentId: searchAgentId, query });
          // 202 arrives as a success on the wire and is a refusal in effect:
          // nothing was searched, an approval is now waiting for the operator.
          if ("approvalRequired" in outcome) setSearchApprovalId(outcome.approvalId);
          else setSearchHits(outcome);
        } catch (err) {
          const code = serverErrorCode(err);
          if (code === "tool_denied") setSearchDenied(serverMessage(err));
          else if (code === "search_unreachable") setSearchUnreachable(serverMessage(err));
          else setSearchFailure(serverMessage(err));
        }
      },
      async () => {},
    );
  }, [actWith, client, searchAgentId, searchQuery]);

  // --- run queue & scheduler (the durable intent to run, and its worker) ---

  const refreshRunQueue = useCallback(
    async (status: RunRequestStatus | "") => {
      const { requests } = await client.runQueue(status === "" ? undefined : status);
      setRunQueue(requests);
    },
    [client],
  );

  const refreshScheduler = useCallback(async () => {
    setScheduler(await client.scheduler());
  }, [client]);

  const openRunQueue = useCallback(() => {
    setShowRunQueue(true);
    setDrainResult(null);
    void actWith(
      async () => {
        await Promise.all([refreshRunQueue(runQueueStatusFilter), refreshScheduler()]);
      },
      async () => {},
    );
  }, [actWith, refreshRunQueue, refreshScheduler, runQueueStatusFilter]);

  const filterRunQueue = useCallback(
    (status: RunRequestStatus | "") => {
      setRunQueueStatusFilter(status);
      void actWith(
        () => refreshRunQueue(status),
        async () => {},
      );
    },
    [actWith, refreshRunQueue],
  );

  const cancelRunRequest = useCallback(
    (id: string) => {
      void actWith(
        () => client.cancelRunRequest(id),
        () => refreshRunQueue(runQueueStatusFilter),
      );
    },
    [actWith, client, refreshRunQueue, runQueueStatusFilter],
  );

  const drainRunQueue = useCallback(() => {
    void actWith(
      async () => {
        const result = await client.drainRunQueue();
        setDrainResult(
          `${result.claimed} übernommen · ${result.completed} erledigt · ${result.failed} fehlgeschlagen · ${result.deferred} zurückgestellt`,
        );
      },
      // Only the re-read is honest about what moved: a drain defers as well as
      // finishes, and a request whose attempts are spent is never claimed.
      async () => {
        await refreshRunQueue(runQueueStatusFilter);
        await refreshScheduler();
      },
    );
  }, [actWith, client, refreshRunQueue, refreshScheduler, runQueueStatusFilter]);

  const runSchedulerJob = useCallback(
    (name: string) => {
      void actWith(
        () => client.runSchedulerJob(name),
        async () => {
          await refreshScheduler();
          await refreshRunQueue(runQueueStatusFilter);
        },
      );
    },
    [actWith, client, refreshRunQueue, refreshScheduler, runQueueStatusFilter],
  );

  // --- notification channels (Discord, Telegram, email fan-out) -----------

  const refreshChannels = useCallback(async () => {
    const { channels } = await client.notificationChannels();
    setNotificationChannels(channels);
  }, [client]);

  const openChannels = useCallback(() => {
    setShowChannels(true);
    setChannelTestResults({});
    void refreshChannels();
  }, [refreshChannels]);

  const testChannel = useCallback(
    (kind: string) => {
      void actWith(
        async () => {
          const result = await client.testNotificationChannel(kind);
          setChannelTestResults((prev) => ({ ...prev, [kind]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const sendTestNotification = useCallback(
    (kind: string) => {
      void actWith(
        async () => {
          const result = await client.sendTestNotification(kind);
          setChannelTestResults((prev) => ({ ...prev, [kind]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- attachments (task/project-scoped + the general document store) ----
  // refreshTaskAttachments / refreshProjectAttachments are declared earlier,
  // alongside openTaskDetail / openProjectDetail, which call them on open.

  const refreshGeneralAttachments = useCallback(async () => {
    const { attachments } = await client.attachmentsGeneral();
    setGeneralAttachments(attachments);
  }, [client]);

  const openDocuments = useCallback(() => {
    setShowDocuments(true);
    void refreshGeneralAttachments();
  }, [refreshGeneralAttachments]);

  const uploadAttachment = useCallback(
    (file: File, scope: { taskId?: string; projectId?: string }, after: () => Promise<void>) => {
      void actWith(async () => {
        const dataBase64 = await readFileAsBase64(file);
        await client.uploadAttachment({
          filename: file.name,
          contentType: file.type || undefined,
          dataBase64,
          ...scope,
        });
      }, after);
    },
    [actWith, client],
  );

  const deleteAttachment = useCallback(
    (id: string, after: () => Promise<void>) => {
      void actWith(() => client.deleteAttachment(id), after);
    },
    [actWith, client],
  );

  // Kanban drag & drop. There is no optimistic local mutation: a card only
  // ever moves to the column its `status` field in `tasks` actually says,
  // and that only changes once refresh() re-reads it after the server
  // accepted the move. A rejected move (409, illegal transition) surfaces
  // through the same `error` banner every other action uses, and the card
  // stays exactly where the backend still has it — "state changes must
  // never be frontend-only" (docs/ROADMAP.md Phase 2).
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  const moveTask = useCallback(
    (taskId: string, status: TaskStatus) => {
      const current = tasks.find((t) => t.id === taskId);
      if (!current || current.status === status || busy) return;
      void act(() => client.setTaskStatus(taskId, status));
    },
    [tasks, busy, act, client],
  );

  const byStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    return map;
  }, [tasks]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const reviewable = tasks.filter((t) => t.status === "review");
  // Re-derived from the live agents list on every render, never a stale
  // snapshot: a runtime change made in the dialog is reflected the moment
  // refresh() lands, same as every other figure in this view.
  const currentAgent = selectedAgent ? (agentById.get(selectedAgent.id) ?? selectedAgent) : null;
  const currentRuntime = currentAgent ? runtimes.find((r) => r.type === currentAgent.runtimeProvider) : undefined;
  // The pairing is read out of the catalogues, not off the agent: whichever
  // vessel lists this agent *is* its vessel, so the dropdown and the "genutzt
  // von" line on the vessel row can never tell different stories.
  const currentVesselId = useMemo(
    () => (currentAgent ? (vessels.find((v) => v.agents.some((a) => a.id === currentAgent.id))?.id ?? "") : ""),
    [currentAgent, vessels],
  );
  const currentTalentId = useMemo(
    () => (currentAgent ? (talents.find((t) => t.agents.some((a) => a.id === currentAgent.id))?.id ?? "") : ""),
    [currentAgent, talents],
  );
  const effectiveVesselId = pairingVesselId ?? currentVesselId;
  const effectiveTalentId = pairingTalentId ?? currentTalentId;
  const pairingChanged = effectiveVesselId !== currentVesselId || effectiveTalentId !== currentTalentId;

  const savePairing = useCallback(() => {
    if (!currentAgent) return;
    // An omitted field leaves that half untouched server-side, so only the
    // half the owner actually changed is sent.
    const body: { vesselId?: string; talentId?: string } = {};
    if (effectiveVesselId !== "" && effectiveVesselId !== currentVesselId) body.vesselId = effectiveVesselId;
    if (effectiveTalentId !== "" && effectiveTalentId !== currentTalentId) body.talentId = effectiveTalentId;
    if (Object.keys(body).length === 0) return;
    void actWith(
      () => client.setAgentPairing(currentAgent.id, body),
      async () => {
        setPairingVesselId(null);
        setPairingTalentId(null);
        await refreshVesselsAndTalents();
        await refresh();
      },
    );
  }, [
    actWith,
    client,
    currentAgent,
    currentTalentId,
    currentVesselId,
    effectiveTalentId,
    effectiveVesselId,
    refresh,
    refreshVesselsAndTalents,
  ]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const currentTask = selectedTask ? (taskById.get(selectedTask.id) ?? selectedTask) : null;
  // Pending first: those are the only rows still waiting on the CEO.
  const sortedProposals = useMemo(
    () =>
      [...changeProposals].sort(
        (a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.created_at - a.created_at,
      ),
    [changeProposals],
  );
  const agentsByDepartment = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const list = map.get(a.departmentId ?? "") ?? [];
      list.push(a);
      map.set(a.departmentId ?? "", list);
    }
    return map;
  }, [agents]);

  return (
    <div className="ic-root" data-testid="command-center">
      {/* ------------------------------------------------------- top bar */}
      <header className="ic-topbar">
        <div className="ic-brand">
          <span className="ic-brand-mark">IRONCREW</span>
          <span className="ic-brand-sub">{companyName}</span>
        </div>

        <button type="button" className="ic-btn" data-testid="open-projects" onClick={() => setShowProjectList(true)}>
          Projekte ({projects.length})
        </button>

        <button
          type="button"
          className="ic-btn"
          data-variant={unreadCount > 0 ? "decision" : undefined}
          data-testid="open-inbox"
          onClick={() => setShowInbox(true)}
        >
          Postfach ({unreadCount})
        </button>

        <button type="button" className="ic-btn" data-testid="open-org-chart" onClick={() => setShowOrgChart(true)}>
          Organigramm
        </button>

        <button type="button" className="ic-btn" data-testid="open-documents" onClick={openDocuments}>
          Dokumente
        </button>

        <button type="button" className="ic-btn" data-testid="open-secrets" onClick={openSecrets}>
          Zugangsdaten
        </button>

        <button type="button" className="ic-btn" data-testid="open-network" onClick={openNetwork}>
          Netzwerk
        </button>

        <button type="button" className="ic-btn" data-testid="open-meetings" onClick={openMeetings}>
          Meetings
        </button>

        <button type="button" className="ic-btn" data-testid="open-memory" onClick={openMemory}>
          Wissen
        </button>

        <button type="button" className="ic-btn" data-testid="open-channels" onClick={openChannels}>
          Kanäle
        </button>

        <button type="button" className="ic-btn" data-testid="open-mailboxes" onClick={openMailboxes}>
          E-Mail
        </button>

        <button type="button" className="ic-btn" data-testid="open-marketplaces" onClick={openMarketplaces}>
          Marktplätze
        </button>

        <button type="button" className="ic-btn" data-testid="open-messenger" onClick={openMessenger}>
          Messenger
        </button>

        <button type="button" className="ic-btn" data-testid="open-change-proposals" onClick={openChangeProposals}>
          Änderungen
        </button>

        <button type="button" className="ic-btn" data-testid="open-vessels" onClick={openVessels}>
          Vessels &amp; Talente
        </button>

        <button type="button" className="ic-btn" data-testid="open-tools" onClick={openTools}>
          Werkzeuge
        </button>

        <button type="button" className="ic-btn" data-testid="open-run-queue" onClick={openRunQueue}>
          Warteschlange
        </button>

        <div className="ic-metrics" role="group" aria-label="Systemkennzahlen">
          <Metric label="Läuft" value={dashboard?.tasks.running ?? 0} tone="accent" />
          <Metric label="Review" value={dashboard?.tasks.review ?? 0} />
          <Metric label="Freigaben" value={dashboard?.approvalsPending ?? 0} tone="decision" />
          <Metric
            label="Blockiert"
            value={dashboard?.tasks.blocked ?? 0}
            tone={dashboard?.tasks.blocked ? "critical" : undefined}
          />
          <Metric label="Agents aktiv" value={dashboard?.agents.working ?? 0} />
          <Metric
            label="Audit"
            value={dashboard?.auditChainValid === false ? "BRUCH" : "OK"}
            tone={dashboard?.auditChainValid === false ? "critical" : undefined}
          />
        </div>
      </header>

      <div className="ic-main">
        {/* ------------------------------------------------- agent rail */}
        <nav className="ic-rail" aria-label="Mannschaft">
          <h2 className="ic-section-title">Mannschaft</h2>
          <div className="ic-agent-list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="ic-agent"
                aria-pressed={selectedAgent?.id === agent.id}
                onClick={() => openAgentDetail(agent)}
              >
                <span
                  className="ic-status-dot"
                  data-status={agent.status}
                  data-testid={`agent-status-${agent.key}`}
                  aria-hidden="true"
                />
                <span>
                  <span className="ic-agent-name">{agent.displayName}</span>
                  <br />
                  <span className="ic-agent-role">{agent.professionalRole}</span>
                  {/* Status is announced in text, not only by colour. */}
                  <span className="ic-sr-only">Status: {AGENT_STATUS_LABEL[agent.status]}</span>
                </span>
                {agent.isExecutiveAssistant ? <span className="ic-agent-ea">EA</span> : <span />}
              </button>
            ))}
          </div>
        </nav>

        {/* ----------------------------------------------------- board */}
        <main className="ic-stage">
          <h2 className="ic-section-title">
            Aufgaben
            <button type="button" className="ic-btn" onClick={runNext} disabled={busy} data-testid="run-next">
              Nächste Aufgabe ausführen
            </button>
          </h2>

          {error && (
            <div className="ic-approval" role="alert" data-testid="error-banner">
              <div className="ic-approval-type">Fehler</div>
              <div className="ic-approval-summary">{error}</div>
            </div>
          )}

          <div className="ic-board" data-testid="kanban">
            {BOARD_COLUMNS.map(({ status, accent }) => {
              const items = byStatus.get(status) ?? [];
              return (
                <section
                  key={status}
                  className="ic-column"
                  data-accent={accent}
                  data-testid={`column-${status}`}
                  data-drag-over={dragOverColumn === status || undefined}
                  onDragOver={(e) => {
                    if (!draggedTaskId) return;
                    e.preventDefault();
                    setDragOverColumn(status);
                  }}
                  onDragLeave={() => setDragOverColumn((c) => (c === status ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverColumn(null);
                    const taskId = e.dataTransfer.getData("text/plain");
                    if (taskId) moveTask(taskId, status);
                  }}
                >
                  <h3 className="ic-column-head">
                    <span>{TASK_STATUS_LABEL[status]}</span>
                    <span className="ic-column-count">{items.length}</span>
                  </h3>
                  <div className="ic-column-body">
                    {items.length === 0 && <p className="ic-empty">—</p>}
                    {items.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="ic-card"
                        draggable
                        data-priority={task.priority}
                        data-risk={task.risk_level}
                        data-dragging={draggedTaskId === task.id || undefined}
                        onClick={() => openTaskDetail(task)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", task.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggedTaskId(task.id);
                        }}
                        onDragEnd={() => {
                          setDraggedTaskId(null);
                          setDragOverColumn(null);
                        }}
                      >
                        <span className="ic-card-title">{task.title}</span>
                        <span className="ic-card-meta">
                          <span>{agentById.get(task.assigned_agent_id ?? "")?.displayName ?? "—"}</span>
                          {task.sensitive === 1 && <span className="ic-redacted">sensibel</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </main>

        {/* ------------------------------------------- CEO chat + inbox */}
        <aside className="ic-side" aria-label="CEO-Kanal">
          {approvals.length > 0 && (
            <>
              <h2 className="ic-section-title">Entscheidungen</h2>
              {approvals.map((approval) => {
                const tally = approval.tally;
                // A quorum of one is the ordinary case and needs no words: an
                // owner deciding alone should see the same two buttons they
                // always saw, not a vote counter that reads "1 von 1".
                const quorum = tally && tally.required > 1 ? tally : null;
                const mine = myUserId ? (approval.reviews ?? []).find((r) => r.reviewer_id === myUserId) : undefined;
                return (
                  <div key={approval.id} className="ic-approval" data-testid={`approval-${approval.id}`}>
                    <div className="ic-approval-type">{approval.approval_type}</div>
                    <div className="ic-approval-summary">{approval.summary}</div>

                    {quorum && (
                      <div className="ic-approval-quorum" data-testid={`quorum-${approval.id}`}>
                        <strong>
                          {quorum.approvals} von {quorum.required} Zustimmungen
                        </strong>
                        {quorum.blocked ? (
                          // Said plainly, and never together with an
                          // "outstanding" count: a rejection is terminal, and
                          // "es fehlt noch 1" next to it would read as though
                          // one more yes could still save the change.
                          <span className="ic-approval-blocked"> — abgelehnt, das war’s</span>
                        ) : (
                          <span>
                            {" "}
                            — es fehlt noch {quorum.outstanding}{" "}
                            {quorum.outstanding === 1 ? "Zustimmung" : "Zustimmungen"}
                          </span>
                        )}
                        <ul className="ic-approval-reviews">
                          {(approval.reviews ?? []).map((review) => (
                            <li key={review.id} data-verdict={review.verdict}>
                              {review.verdict === "approved" ? "✓" : "✕"}{" "}
                              {review.reviewer_id === myUserId ? "du" : (review.reviewer_label ?? review.reviewer_id)}
                              {review.reason ? `: ${review.reason}` : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="ic-approval-actions">
                      {mine ? (
                        // The buttons are gone, not merely disabled: a second
                        // click is not a second reviewer, and a greyed-out
                        // button invites the click that produces the 409.
                        <span className="ic-approval-voted" data-testid={`voted-${approval.id}`}>
                          Deine Stimme ist abgegeben ({mine.verdict === "approved" ? "zugestimmt" : "abgelehnt"}).
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ic-btn"
                            data-variant="decision"
                            disabled={busy}
                            onClick={() => act(() => client.decide(approval.id, "approved"))}
                          >
                            {quorum ? "Zustimmen" : "Freigeben"}
                          </button>
                          <button
                            type="button"
                            className="ic-btn"
                            data-variant="danger"
                            disabled={busy}
                            onClick={() => act(() => client.decide(approval.id, "rejected"))}
                          >
                            Ablehnen
                          </button>
                        </>
                      )}
                      {!quorum && !mine && (
                        // Raising the bar is deliberately a per-approval act,
                        // not a setting: a company-wide two-person rule makes
                        // every routine approval wait for somebody with
                        // nothing to add, and gets switched off within a
                        // fortnight — including for the bank transfer.
                        <button
                          type="button"
                          className="ic-btn"
                          data-variant="ghost"
                          disabled={busy}
                          data-testid={`require-two-${approval.id}`}
                          onClick={() => act(() => client.setQuorum(approval.id, 2))}
                        >
                          Vier Augen verlangen
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {reviewable.length > 0 && (
            <>
              <h2 className="ic-section-title">Zur Abnahme</h2>
              {reviewable.map((task) => (
                <div key={task.id} className="ic-approval" data-testid={`review-${task.id}`}>
                  <div className="ic-approval-type">Review</div>
                  <div className="ic-approval-summary">{task.title}</div>
                  <div className="ic-approval-actions">
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      disabled={busy}
                      onClick={() => act(() => client.accept(task.id))}
                    >
                      Abnehmen
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      disabled={busy}
                      onClick={() => act(() => client.revise(task.id, "Bitte überarbeiten."))}
                    >
                      Revision
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          <h2 className="ic-section-title">CEO-Kanal</h2>
          <div className="ic-chat-log" ref={logRef} data-testid="chat-log">
            {messages.length === 0 && (
              <p className="ic-note">
                Ihr zentraler Ansprechpartner ist die Executive Assistant. Schreiben Sie, was zu tun ist — Triage,
                Planung und Delegation übernimmt sie.
              </p>
            )}
            {messages.map((msg) => {
              const triage = msg.triage_json
                ? (JSON.parse(msg.triage_json) as { category: string; confidence: number })
                : null;
              return (
                <div key={msg.id} className="ic-msg" data-role={msg.role}>
                  <div className="ic-msg-author">
                    {msg.role === "ceo" ? "CEO" : (agentById.get(msg.author_agent_id ?? "")?.displayName ?? "System")}
                    {" · "}
                    {formatTime(msg.created_at)}
                  </div>
                  <div className="ic-msg-body">{msg.body}</div>
                  {triage && msg.role === "ceo" && (
                    <div className="ic-triage">
                      Triage: {triage.category} · Konfidenz {(triage.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ic-composer">
            <label className="ic-sr-only" htmlFor="ic-composer-input">
              Nachricht an die Executive Assistant
            </label>
            <textarea
              id="ic-composer-input"
              data-testid="chat-input"
              value={draft}
              placeholder="Auftrag an die Executive Assistant …"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="chat-send"
              onClick={send}
              disabled={busy || draft.trim().length === 0}
            >
              Senden
            </button>
          </div>
        </aside>
      </div>

      {/* --------------------------------------------------- event drawer */}
      <section className="ic-drawer" aria-label="Ereignisverlauf">
        <div className="ic-drawer-head">
          <h2 className="ic-section-title" style={{ padding: 0 }}>
            Run-Ereignisse
          </h2>
        </div>
        <div className="ic-event-log" data-testid="event-log">
          {events.length === 0 && <p className="ic-empty">Noch keine Ereignisse.</p>}
          {events.slice(-60).map((ev) => (
            <div key={ev.eventId} className="ic-event" data-kind={eventKind(ev.type)}>
              <span className="ic-event-time">{formatTime(ev.timestamp)}</span>
              <span className="ic-event-type">{ev.type}</span>
              <span className="ic-event-body">
                {ev.redaction.redacted && <span className="ic-redacted">redigiert</span>}{" "}
                {JSON.stringify(ev.payload).slice(0, 160)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {currentTask && (
        <DetailDialog title={currentTask.title} onClose={() => setSelectedTask(null)}>
          <dl>
            <dt>Status</dt>
            <dd>{TASK_STATUS_LABEL[currentTask.status]}</dd>
            <dt>Priorität</dt>
            <dd>{currentTask.priority}</dd>
            <dt>Risiko</dt>
            <dd>{currentTask.risk_level}</dd>
            <dt>Verantwortlich</dt>
            <dd>{agentById.get(currentTask.assigned_agent_id ?? "")?.displayName ?? "nicht zugewiesen"}</dd>
            <dt>Correlation</dt>
            <dd>
              <code>{currentTask.correlation_id}</code>
            </dd>
          </dl>
          {currentTask.result_summary && <p className="ic-note">{currentTask.result_summary}</p>}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Blockiert durch
          </h3>
          {taskBlockers.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {taskBlockers.map((b) => (
              <li key={b.id}>
                <span className="ic-milestone-title">{b.title}</span>
                <span className="ic-tag" data-tone={b.status === "done" ? "policy" : "gate"}>
                  {TASK_STATUS_LABEL[b.status]}
                </span>
                <button
                  type="button"
                  className="ic-btn"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await client.removeDependency(currentTask.id, b.id);
                      await refreshTaskDependencies(currentTask.id);
                    })
                  }
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>
          <div className="ic-composer" style={{ padding: 0 }}>
            <label className="ic-sr-only" htmlFor="ic-add-blocker-select">
              Blocker für {currentTask.title} hinzufügen
            </label>
            <select
              id="ic-add-blocker-select"
              className="ic-select"
              value={addBlockerId}
              onChange={(e) => setAddBlockerId(e.target.value)}
            >
              <option value="">Blocker wählen…</option>
              {tasks
                .filter((t) => t.id !== currentTask.id && !taskBlockers.some((b) => b.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="ic-btn"
              disabled={!addBlockerId || busy}
              onClick={() =>
                act(async () => {
                  await client.addDependency(currentTask.id, addBlockerId);
                  setAddBlockerId("");
                  await refreshTaskDependencies(currentTask.id);
                })
              }
            >
              Hinzufügen
            </button>
          </div>

          {taskBlocking.length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                Blockiert
              </h3>
              <ul className="ic-milestone-list">
                {taskBlocking.map((b) => (
                  <li key={b.id}>
                    <span className="ic-milestone-title">{b.title}</span>
                    <span className="ic-tag">{TASK_STATUS_LABEL[b.status]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <AttachmentSection
            title="Anhänge"
            attachments={taskAttachments}
            busy={busy}
            onUpload={(file) =>
              uploadAttachment(file, { taskId: currentTask.id }, () => refreshTaskAttachments(currentTask.id))
            }
            onDelete={(id) => deleteAttachment(id, () => refreshTaskAttachments(currentTask.id))}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {currentAgent && (
        <DetailDialog title={currentAgent.displayName} onClose={() => setSelectedAgent(null)}>
          <dl>
            <dt>Rolle</dt>
            <dd>{currentAgent.professionalRole}</dd>
            <dt>Status</dt>
            <dd>{AGENT_STATUS_LABEL[currentAgent.status]}</dd>
            <dt>Runtime</dt>
            <dd>
              <label className="ic-sr-only" htmlFor="ic-agent-runtime-select">
                Runtime für {currentAgent.displayName}
              </label>
              <select
                id="ic-agent-runtime-select"
                className="ic-select"
                data-testid="agent-runtime-select"
                value={currentAgent.runtimeProvider}
                disabled={busy}
                onChange={(e) => act(() => client.setAgentRuntime(currentAgent.id, e.target.value))}
              >
                {/* An agent can be pointed at a provider this install no longer
                    has registered (e.g. after a config change) — surface that
                    honestly as its own option rather than silently showing a
                    different one selected. */}
                {!runtimes.some((r) => r.type === currentAgent.runtimeProvider) && (
                  <option value={currentAgent.runtimeProvider}>
                    {currentAgent.runtimeProvider} (nicht registriert)
                  </option>
                )}
                {runtimes.map((r) => (
                  <option key={r.type} value={r.type}>
                    {r.type} {r.health.healthy ? "● bereit" : "○ nicht verfügbar"}
                  </option>
                ))}
              </select>
              {" · "}
              {currentAgent.runtimeProfile}
              {currentRuntime && (
                <>
                  <br />
                  <span className="ic-note" data-testid="agent-runtime-detail">
                    {currentRuntime.auth.authenticated ? "Angemeldet" : "Nicht angemeldet"} ·{" "}
                    {currentRuntime.health.detail}
                  </span>
                </>
              )}
            </dd>
            <dt>Max. Risiko</dt>
            <dd>{currentAgent.policy.max_risk_level}</dd>
            <dt>Werkzeuge</dt>
            <dd>
              {currentAgent.policy.allowed_tools.map((t) => (
                <span key={t} className="ic-tag" data-tone="policy">
                  {t}
                </span>
              ))}
            </dd>
            <dt>Freigabepflichtig</dt>
            <dd>
              {currentAgent.policy.requires_approval_for.length === 0
                ? "—"
                : currentAgent.policy.requires_approval_for.map((t) => (
                    <span key={t} className="ic-tag" data-tone="gate">
                      {t}
                    </span>
                  ))}
            </dd>
            {/* What the gate actually answers for this post, and through which
                scope it answered — a grant on the talent reaches every agent
                in that role, so naming the scope is what makes the line
                readable rather than surprising. */}
            <dt>Freigegebene Werkzeuge</dt>
            <dd data-testid="agent-tools-line">
              {agentTools === null
                ? "wird geladen…"
                : agentTools.length === 0
                  ? "Kein Werkzeug freigegeben."
                  : agentTools.map((entry) => (
                      <span key={entry.tool.id} className="ic-tag" data-tone="policy">
                        {entry.tool.key} ({TOOL_VIA_LABEL[entry.via] ?? entry.via}
                        {entry.requiresApproval ? ", Freigabe pro Nutzung" : ""})
                      </span>
                    ))}
            </dd>
            <dt>Auftreten</dt>
            <dd>{currentAgent.persona.traits.join(", ") || "—"}</dd>
            <dt>Vessel</dt>
            <dd>
              <label className="ic-sr-only" htmlFor="ic-agent-vessel-select">
                Vessel für {currentAgent.displayName}
              </label>
              <select
                id="ic-agent-vessel-select"
                className="ic-select"
                data-testid="agent-vessel-select"
                value={effectiveVesselId}
                disabled={busy}
                onChange={(e) => setPairingVesselId(e.target.value)}
              >
                <option value="">— nicht zugeordnet —</option>
                {vessels.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label || v.key} · {v.runtime_provider}
                    {v.model === "" ? "" : ` · ${v.model}`}
                  </option>
                ))}
              </select>
            </dd>
            <dt>Talent</dt>
            <dd>
              <label className="ic-sr-only" htmlFor="ic-agent-talent-select">
                Talent für {currentAgent.displayName}
              </label>
              <select
                id="ic-agent-talent-select"
                className="ic-select"
                data-testid="agent-talent-select"
                value={effectiveTalentId}
                disabled={busy}
                onChange={(e) => setPairingTalentId(e.target.value)}
              >
                <option value="">— nicht zugeordnet —</option>
                {talents.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.professional_role}
                    {t.seniority === "" ? "" : ` · ${t.seniority}`}
                  </option>
                ))}
              </select>
            </dd>
          </dl>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="agent-pairing-save"
              disabled={busy || !pairingChanged}
              onClick={savePairing}
            >
              Zuordnung übernehmen
            </button>
          </div>
          <p className="ic-note" data-testid="agent-pairing-note">
            Ein Agent ist ein Vessel × Talent. Das Vessel bestimmt, worin gearbeitet wird — Runtime, Modell und die
            Grenzen für Dauer, Wiederholung und Parallelität. Das Talent bestimmt, was der Agent kann: Rolle,
            Seniorität, Policy, Auftreten, Skills. Berechtigungen kommen ausschliesslich aus dem Talent; ein Vessel kann
            keine erteilen und keine entziehen.
          </p>
          <p className="ic-note">
            Das Auftreten ist rein stilistisch. Es kann Berechtigungen, Werkzeuge oder Freigabepflichten nicht verändern
            — Policy hat immer Vorrang.
          </p>
        </DetailDialog>
      )}

      {showProjectList && !projectDetail && (
        <DetailDialog title="Projekte" onClose={() => setShowProjectList(false)}>
          {projects.length === 0 && <p className="ic-empty">Noch keine Projekte.</p>}
          <div className="ic-project-list">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ic-project"
                data-testid={`project-${p.key}`}
                onClick={() => void openProjectDetail(p.id)}
              >
                <span className="ic-project-title">{p.title}</span>
                <span className="ic-project-meta">
                  {p.key} · {PROJECT_STATUS_LABEL[p.status]}
                </span>
              </button>
            ))}
          </div>
        </DetailDialog>
      )}

      {projectDetail && (
        <DetailDialog title={projectDetail.project.title} onClose={closeProjectDetail}>
          <dl>
            <dt>Schlüssel</dt>
            <dd>
              <code>{projectDetail.project.key}</code>
            </dd>
            <dt>Status</dt>
            <dd>{PROJECT_STATUS_LABEL[projectDetail.project.status]}</dd>
            {projectGoalAncestry && projectGoalAncestry.length > 0 && (
              <>
                <dt>Ziel</dt>
                <dd data-testid="project-goal-ancestry">{projectGoalAncestry.map((g) => g.title).join(" -> ")}</dd>
              </>
            )}
            {projectDetail.project.summary && (
              <>
                <dt>Zusammenfassung</dt>
                <dd>{projectDetail.project.summary}</dd>
              </>
            )}
          </dl>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Meilensteine
          </h3>
          {projectDetail.milestones.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {projectDetail.milestones.map((m) => (
              <li key={m.id} className="ic-milestone" data-status={m.status}>
                <span className="ic-milestone-title">{m.title}</span>
                <span className="ic-tag" data-tone={m.status === "missed" ? "gate" : "policy"}>
                  {MILESTONE_STATUS_LABEL[m.status]}
                </span>
                {m.status === "pending" && (
                  <button
                    type="button"
                    className="ic-btn"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await client.setMilestoneStatus(m.id, "done");
                        await refreshProjectDetail();
                      })
                    }
                  >
                    Erledigt
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Aufgaben
          </h3>
          {projectDetail.tasks.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {projectDetail.tasks.map((t) => (
              <li key={t.id}>
                <span>{t.title}</span> <span className="ic-tag">{TASK_STATUS_LABEL[t.status]}</span>
              </li>
            ))}
          </ul>

          <AttachmentSection
            title="Anhänge"
            attachments={projectAttachments}
            busy={busy}
            onUpload={(file) =>
              uploadAttachment(file, { projectId: projectDetail.project.id }, () =>
                refreshProjectAttachments(projectDetail.project.id),
              )
            }
            onDelete={(id) => deleteAttachment(id, () => refreshProjectAttachments(projectDetail.project.id))}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {showInbox && (
        <DetailDialog title="Postfach" onClose={() => setShowInbox(false)}>
          <h3 className="ic-section-title" style={{ padding: 0 }}>
            Benachrichtigungen
          </h3>
          {notifications.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {notifications.map((n) => (
              <li key={n.id} data-testid={`notification-${n.id}`}>
                <span className="ic-milestone-title" style={n.read_at ? { opacity: 0.5 } : undefined}>
                  {n.title}
                </span>
                <span
                  className="ic-tag"
                  data-tone={n.severity === "critical" ? "gate" : n.severity === "warning" ? "gate" : "policy"}
                >
                  {NOTIFICATION_SEVERITY_LABEL[n.severity]}
                </span>
                {!n.read_at && (
                  <button type="button" className="ic-btn" disabled={busy} onClick={() => markNotificationRead(n.id)}>
                    Gelesen
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "10px 0 4px" }}>
            Entscheidungsprotokoll
          </h3>
          {decisions.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {decisions.map((d) => (
              <li key={d.id}>
                <span className="ic-milestone-title">{d.title}</span>
                <span className="ic-tag" data-tone={d.decision === "approved" ? "policy" : "gate"}>
                  {d.decision}
                </span>
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}

      {showOrgChart && (
        <DetailDialog title="Organigramm" onClose={() => setShowOrgChart(false)}>
          {departments.length === 0 && <p className="ic-empty">—</p>}
          {departments.map((dept) => {
            const deptAgents = agentsByDepartment.get(dept.id) ?? [];
            return (
              <div key={dept.id} data-testid={`org-department-${dept.key}`}>
                <h3 className="ic-section-title" style={{ padding: "6px 0 4px" }}>
                  {dept.name} ({deptAgents.length})
                </h3>
                {deptAgents.length === 0 && <p className="ic-empty">—</p>}
                <div className="ic-project-list">
                  {deptAgents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="ic-project"
                      data-testid={`org-agent-${a.key}`}
                      onClick={() => openAgentDetail(a)}
                    >
                      <span className="ic-project-title">
                        {a.displayName}
                        {a.isExecutiveAssistant ? " · EA" : ""}
                      </span>
                      <span className="ic-project-meta">
                        {a.professionalRole} · {AGENT_STATUS_LABEL[a.status]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {(agentsByDepartment.get("") ?? []).length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "6px 0 4px" }}>
                Ohne Abteilung
              </h3>
              <div className="ic-project-list">
                {(agentsByDepartment.get("") ?? []).map((a) => (
                  <button key={a.id} type="button" className="ic-project" onClick={() => openAgentDetail(a)}>
                    <span className="ic-project-title">{a.displayName}</span>
                    <span className="ic-project-meta">{a.professionalRole}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </DetailDialog>
      )}

      {showDocuments && (
        <DetailDialog title="Dokumente" onClose={() => setShowDocuments(false)}>
          <p className="ic-note">
            Allgemeiner, unternehmensweiter Dokumenten-Speicher — nicht an eine Aufgabe oder ein Projekt gebunden.
          </p>
          <AttachmentSection
            title="Dateien"
            attachments={generalAttachments}
            busy={busy}
            onUpload={(file) => uploadAttachment(file, {}, refreshGeneralAttachments)}
            onDelete={(id) => deleteAttachment(id, refreshGeneralAttachments)}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {showSecrets && (
        <DetailDialog title="Zugangsdaten" onClose={() => setShowSecrets(false)}>
          <p className="ic-note">
            Es wird nie ein Passwort gespeichert — nur ein Verweis (Anbieter + Eintrag), wo das Secret im
            Passwort-Manager liegt. Aufgelöst wird der Wert erst im Moment der Nutzung, im Arbeitsspeicher.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Anbieter
          </h3>
          <ul className="ic-milestone-list">
            {secretProviders.map((p) => (
              <li key={p.kind} data-testid={`secret-provider-${p.kind}`}>
                <span className="ic-milestone-title">{SECRET_PROVIDER_LABEL[p.kind]}</span>
                <span className="ic-tag" data-tone={p.registered && p.ok ? "policy" : "gate"}>
                  {p.registered ? (p.ok ? "verbunden" : "nicht erreichbar") : "nicht registriert"}
                </span>
                <span className="ic-note">{p.message}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Gespeicherte Verweise
          </h3>
          {secrets.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {secrets.map((s) => (
              <li key={s.id} data-testid={`secret-${s.id}`}>
                <span className="ic-milestone-title">{s.name}</span>
                <span className="ic-tag" data-tone="policy">
                  {SECRET_PROVIDER_LABEL[s.provider]}
                </span>
                <span className="ic-note">
                  {s.item_ref}
                  {s.field ? ` · ${s.field}` : ""}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testSecret(s.id)}>
                  Testen
                </button>
                {secretTestResults[s.id] && (
                  <span
                    className="ic-tag"
                    data-testid={`secret-test-${s.id}`}
                    data-tone={secretTestResults[s.id].ok ? "policy" : "gate"}
                  >
                    {secretTestResults[s.id].message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteSecret(s.id)}
                >
                  Löschen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neuer Verweis
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-secret-name">
              Name
            </label>
            <input
              id="ic-new-secret-name"
              data-testid="new-secret-name"
              placeholder="Name (z. B. github-pat)"
              value={newSecretName}
              onChange={(e) => setNewSecretName(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-secret-provider">
              Anbieter
            </label>
            <select
              id="ic-new-secret-provider"
              className="ic-select"
              data-testid="new-secret-provider"
              value={newSecretProvider}
              onChange={(e) => setNewSecretProvider(e.target.value as SecretProviderKind)}
            >
              <option value="vaultwarden">Vaultwarden</option>
              <option value="protonpass">Proton Pass</option>
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-secret-itemref">
              Eintrag
            </label>
            <input
              id="ic-new-secret-itemref"
              data-testid="new-secret-itemref"
              placeholder={newSecretProvider === "vaultwarden" ? "Item-Name in Vaultwarden" : "shareId:itemId"}
              value={newSecretItemRef}
              onChange={(e) => setNewSecretItemRef(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-secret-field">
              Feld (optional)
            </label>
            <input
              id="ic-new-secret-field"
              data-testid="new-secret-field"
              placeholder="Feld (optional, z. B. password)"
              value={newSecretField}
              onChange={(e) => setNewSecretField(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-secret-submit"
              disabled={busy || !newSecretName.trim() || !newSecretItemRef.trim()}
              onClick={createSecret}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showNetwork && (
        <DetailDialog title="Netzwerk" onClose={() => setShowNetwork(false)}>
          <p className="ic-note">
            Tailscale (oder ein selbstgehosteter, protokollkompatibler Kontrollserver wie Headscale) verbindet diesen
            Server mit entfernten Workern — Tier0-Umgebungen oder Kundennetzen — über SSH im Tailnet.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Dieser Knoten
          </h3>
          {tailscaleInfo && (
            <ul className="ic-milestone-list">
              <li data-testid="tailscale-self-status">
                <span className="ic-milestone-title">{tailscaleInfo.self?.hostName ?? "—"}</span>
                <span className="ic-tag" data-tone={tailscaleInfo.ok ? "policy" : "gate"}>
                  {tailscaleInfo.backendState}
                </span>
                <span className="ic-note">{tailscaleInfo.message}</span>
              </li>
            </ul>
          )}

          {tailscaleInfo && tailscaleInfo.peers.length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                Tailnet-Peers
              </h3>
              <ul className="ic-milestone-list">
                {tailscaleInfo.peers.map((p) => (
                  <li key={p.id}>
                    <span className="ic-milestone-title">{p.hostName}</span>
                    <span className="ic-tag" data-tone={p.online ? "policy" : "gate"}>
                      {p.online ? "online" : "offline"}
                    </span>
                    <span className="ic-note">{p.tailscaleIPs[0] ?? p.dnsName}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Remote Worker
          </h3>
          {remoteWorkers.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {remoteWorkers.map((w) => (
              <li key={w.id} data-testid={`remote-worker-${w.id}`}>
                <span className="ic-milestone-title">{w.label}</span>
                <span className="ic-tag">{w.environment || "—"}</span>
                <span className="ic-note">
                  {w.ssh_user}@{w.host}:{w.port}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testRemoteWorker(w.id)}>
                  Testen
                </button>
                {remoteWorkerTestResults[w.id] && (
                  <span
                    className="ic-tag"
                    data-testid={`remote-worker-test-${w.id}`}
                    data-tone={remoteWorkerTestResults[w.id].ok ? "policy" : "gate"}
                  >
                    {remoteWorkerTestResults[w.id].message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteRemoteWorker(w.id)}
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neuer Remote Worker
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-worker-label">
              Label
            </label>
            <input
              id="ic-new-worker-label"
              data-testid="new-worker-label"
              placeholder="Label (z. B. tier0-acme)"
              value={newWorkerLabel}
              onChange={(e) => setNewWorkerLabel(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-environment">
              Umgebung
            </label>
            <input
              id="ic-new-worker-environment"
              data-testid="new-worker-environment"
              placeholder="Umgebung (z. B. customer:acme)"
              value={newWorkerEnvironment}
              onChange={(e) => setNewWorkerEnvironment(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-host">
              Tailnet-Host
            </label>
            <input
              id="ic-new-worker-host"
              data-testid="new-worker-host"
              placeholder="Tailnet-IP oder Hostname"
              value={newWorkerHost}
              onChange={(e) => setNewWorkerHost(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-ssh-user">
              SSH-Benutzer
            </label>
            <input
              id="ic-new-worker-ssh-user"
              data-testid="new-worker-ssh-user"
              placeholder="SSH-Benutzer"
              value={newWorkerSshUser}
              onChange={(e) => setNewWorkerSshUser(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-key-path">
              Pfad zum privaten Schlüssel
            </label>
            <input
              id="ic-new-worker-key-path"
              data-testid="new-worker-key-path"
              placeholder="Pfad zum privaten SSH-Schlüssel"
              value={newWorkerPrivateKeyPath}
              onChange={(e) => setNewWorkerPrivateKeyPath(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-known-hosts">
              Known-Hosts-Richtlinie
            </label>
            <select
              id="ic-new-worker-known-hosts"
              className="ic-select"
              data-testid="new-worker-known-hosts"
              value={newWorkerKnownHosts}
              onChange={(e) => setNewWorkerKnownHosts(e.target.value as KnownHostsPolicy)}
            >
              <option value="strict">strict</option>
              <option value="accept">accept</option>
            </select>
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-worker-submit"
              disabled={
                busy ||
                !newWorkerLabel.trim() ||
                !newWorkerHost.trim() ||
                !newWorkerSshUser.trim() ||
                !newWorkerPrivateKeyPath.trim()
              }
              onClick={createRemoteWorker}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showMeetings && (
        <DetailDialog title="Meetings" onClose={() => setShowMeetings(false)}>
          <p className="ic-note">
            Eine Runde ist eine Wortmeldung — die Gesamtzahl der Runden ist durch die max. Rundenzahl begrenzt, nicht
            durch Teilnehmerzahl × Runden. Ein Meeting schließt sich selbst, sobald die Rundenzahl oder das Budget
            erreicht ist.
          </p>

          {meetings.length === 0 && <p className="ic-empty">Noch keine Meetings.</p>}
          <ul className="ic-milestone-list">
            {meetings.map((m) => (
              <li key={m.id} data-testid={`meeting-${m.id}`}>
                <span className="ic-milestone-title">{m.topic}</span>
                <span className="ic-tag" data-tone={m.status === "cancelled" ? "gate" : "policy"}>
                  {MEETING_STATUS_LABEL[m.status]}
                </span>
                <span className="ic-note">
                  Runde {m.current_round}/{m.max_rounds}
                </span>
                <button type="button" className="ic-btn" onClick={() => void openMeetingDetail(m.id)}>
                  Öffnen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neues Meeting
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-meeting-topic">
              Thema
            </label>
            <input
              id="ic-new-meeting-topic"
              data-testid="new-meeting-topic"
              placeholder="Thema"
              value={newMeetingTopic}
              onChange={(e) => setNewMeetingTopic(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-meeting-moderator">
              Moderator
            </label>
            <select
              id="ic-new-meeting-moderator"
              className="ic-select"
              data-testid="new-meeting-moderator"
              value={newMeetingModeratorId}
              onChange={(e) => setNewMeetingModeratorId(e.target.value)}
            >
              <option value="">Moderator wählen…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-meeting-max-rounds">
              Max. Rundenzahl
            </label>
            <input
              id="ic-new-meeting-max-rounds"
              type="number"
              min={1}
              max={50}
              data-testid="new-meeting-max-rounds"
              value={newMeetingMaxRounds}
              onChange={(e) => setNewMeetingMaxRounds(Number(e.target.value) || 1)}
            />
          </div>
          <fieldset className="ic-milestone-list" style={{ border: "none", margin: 0, padding: "4px 0" }}>
            <legend className="ic-note">Teilnehmer</legend>
            {agents.map((a) => (
              <label key={a.id} className="ic-note" style={{ display: "block" }}>
                <input
                  type="checkbox"
                  data-testid={`new-meeting-participant-${a.id}`}
                  checked={newMeetingParticipantIds.includes(a.id)}
                  onChange={() => toggleMeetingParticipant(a.id)}
                />{" "}
                {a.displayName}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="ic-btn"
            data-variant="primary"
            data-testid="new-meeting-submit"
            disabled={
              busy || !newMeetingTopic.trim() || !newMeetingModeratorId || newMeetingParticipantIds.length === 0
            }
            onClick={createMeeting}
          >
            Anlegen
          </button>
        </DetailDialog>
      )}

      {meetingDetail && (
        <DetailDialog title={meetingDetail.meeting.topic} onClose={closeMeetingDetail}>
          <dl>
            <dt>Status</dt>
            <dd data-testid="meeting-detail-status">{MEETING_STATUS_LABEL[meetingDetail.meeting.status]}</dd>
            <dt>Runde</dt>
            <dd>
              {meetingDetail.meeting.current_round}/{meetingDetail.meeting.max_rounds}
            </dd>
            {meetingDetail.meeting.budget_micros > 0 && (
              <>
                <dt>Budget</dt>
                <dd>
                  {(meetingDetail.meeting.spent_micros / 1_000_000).toFixed(2)} /{" "}
                  {(meetingDetail.meeting.budget_micros / 1_000_000).toFixed(2)} USD
                </dd>
              </>
            )}
          </dl>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Teilnehmer
          </h3>
          <ul className="ic-milestone-list">
            {meetingDetail.participants.map((p) => (
              <li key={p.agent_id}>
                <span className="ic-milestone-title">{p.display_name}</span>
                {p.agent_id === meetingDetail.meeting.moderator_agent_id && (
                  <span className="ic-tag" data-tone="policy">
                    Moderator
                  </span>
                )}
                <span className="ic-note">{p.professional_role}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Verlauf
          </h3>
          {meetingDetail.turns.length === 0 && <p className="ic-empty">Noch keine Wortmeldungen.</p>}
          <ul className="ic-milestone-list" data-testid="meeting-turns">
            {meetingDetail.turns.map((t) => (
              <li key={t.id}>
                <span className="ic-milestone-title">
                  {meetingDetail.participants.find((p) => p.agent_id === t.agent_id)?.display_name ?? t.agent_id}
                </span>
                <span className="ic-tag">Runde {t.round}</span>
                <span className="ic-note">{t.contribution}</span>
              </li>
            ))}
          </ul>

          {meetingDetail.meeting.status === "scheduled" && (
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="meeting-start"
              disabled={busy}
              onClick={() => startMeeting(meetingDetail.meeting.id)}
            >
              Starten
            </button>
          )}

          {meetingDetail.meeting.status === "in_progress" && (
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="meeting-next-turn"
              disabled={busy}
              onClick={() => nextMeetingTurn(meetingDetail.meeting.id)}
            >
              Nächste Wortmeldung
            </button>
          )}

          {(meetingDetail.meeting.status === "scheduled" || meetingDetail.meeting.status === "in_progress") && (
            <button
              type="button"
              className="ic-btn"
              data-variant="danger"
              data-testid="meeting-cancel"
              disabled={busy}
              onClick={() => cancelMeeting(meetingDetail.meeting.id)}
            >
              Abbrechen
            </button>
          )}

          {meetingDetail.meeting.status === "in_progress" && (
            <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
              <label className="ic-sr-only" htmlFor="ic-meeting-minutes">
                Protokoll
              </label>
              <input
                id="ic-meeting-minutes"
                data-testid="meeting-minutes"
                placeholder="Protokoll / Ergebnis"
                value={meetingMinutesDraft}
                onChange={(e) => setMeetingMinutesDraft(e.target.value)}
              />
              <button
                type="button"
                className="ic-btn"
                data-testid="meeting-end"
                disabled={busy}
                onClick={() => endMeeting(meetingDetail.meeting.id, meetingMinutesDraft)}
              >
                Beenden
              </button>
            </div>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Aktionspunkte
          </h3>
          {meetingDetail.actionItems.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {meetingDetail.actionItems.map((item) => (
              <li key={item.id} data-testid={`action-item-${item.id}`}>
                <span className="ic-milestone-title">{item.description}</span>
                {item.task_id ? (
                  <span className="ic-tag" data-tone="policy">
                    Aufgabe angelegt
                  </span>
                ) : (
                  <button type="button" className="ic-btn" disabled={busy} onClick={() => convertActionItem(item.id)}>
                    Als Aufgabe anlegen
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-action-item">
              Neuer Aktionspunkt
            </label>
            <input
              id="ic-new-action-item"
              data-testid="new-action-item-description"
              placeholder="Neuer Aktionspunkt"
              value={newActionItemDescription}
              onChange={(e) => setNewActionItemDescription(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-action-item-assignee">
              Zuständig
            </label>
            <select
              id="ic-new-action-item-assignee"
              className="ic-select"
              data-testid="new-action-item-assignee"
              value={newActionItemAssigneeId}
              onChange={(e) => setNewActionItemAssigneeId(e.target.value)}
            >
              <option value="">Niemand zugewiesen</option>
              {meetingDetail.participants.map((p) => (
                <option key={p.agent_id} value={p.agent_id}>
                  {p.display_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ic-btn"
              data-testid="new-action-item-submit"
              disabled={busy || !newActionItemDescription.trim()}
              onClick={() => addMeetingActionItem(meetingDetail.meeting.id)}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showMemory && (
        <DetailDialog title="Wissen" onClose={() => setShowMemory(false)}>
          <p className="ic-note">
            Ein Obsidian-Vault ist ein Ordner voller Markdown-Dateien — jede Notiz hier ist eine echte .md-Datei mit
            YAML-Frontmatter, direkt in Obsidian zu öffnen.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Anbieter
          </h3>
          {memoryProviders.length === 0 && <p className="ic-empty">Kein MemoryProvider registriert.</p>}
          <ul className="ic-milestone-list">
            {memoryProviders.map((p) => (
              <li key={p.kind} data-testid={`memory-provider-${p.kind}`}>
                <span className="ic-milestone-title">{p.kind}</span>
                <span className="ic-tag" data-tone={p.ok ? "policy" : "gate"}>
                  {p.ok ? "verbunden" : "nicht erreichbar"}
                </span>
                <span className="ic-note">{p.message}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Suche
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-memory-search">
              Suche
            </label>
            <input
              id="ic-memory-search"
              data-testid="memory-search-input"
              placeholder="Volltextsuche im Vault"
              value={memoryQuery}
              onChange={(e) => setMemoryQuery(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-testid="memory-search-submit"
              disabled={busy || !memoryQuery.trim() || memoryProviders.length === 0}
              onClick={searchMemory}
            >
              Suchen
            </button>
          </div>
          {memorySearchHits && (
            <ul className="ic-milestone-list" data-testid="memory-search-results">
              {memorySearchHits.length === 0 && <p className="ic-empty">Keine Treffer.</p>}
              {memorySearchHits.map((hit) => (
                <li key={hit.externalId}>
                  <span className="ic-milestone-title">{hit.title}</span>
                  <span className="ic-note">{hit.snippet}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Einträge
          </h3>
          {memories.length === 0 && <p className="ic-empty">Noch keine Einträge.</p>}
          <ul className="ic-milestone-list">
            {memories.map((m) => (
              <li key={m.id} data-testid={`memory-${m.id}`}>
                <span className="ic-milestone-title">{m.title}</span>
                <span className="ic-tag" data-tone="policy">
                  {MEMORY_KIND_LABEL[m.kind]}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => openMemoryDetail(m.id)}>
                  Öffnen
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteMemoryEntry(m.id)}
                >
                  Löschen
                </button>
              </li>
            ))}
          </ul>

          {memoryDetail && (
            <div data-testid="memory-detail">
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                {memoryDetail.memory.title}
              </h3>
              <pre className="ic-note" style={{ whiteSpace: "pre-wrap" }}>
                {memoryDetail.content}
              </pre>
              <button type="button" className="ic-btn" onClick={() => setMemoryDetail(null)}>
                Schließen
              </button>
            </div>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neue Notiz
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-memory-kind">
              Art
            </label>
            <select
              id="ic-new-memory-kind"
              className="ic-select"
              data-testid="new-memory-kind"
              value={newMemoryKind}
              onChange={(e) => setNewMemoryKind(e.target.value as MemoryKind)}
            >
              {(Object.keys(MEMORY_KIND_LABEL) as MemoryKind[]).map((k) => (
                <option key={k} value={k}>
                  {MEMORY_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-memory-title">
              Titel
            </label>
            <input
              id="ic-new-memory-title"
              data-testid="new-memory-title"
              placeholder="Titel"
              value={newMemoryTitle}
              onChange={(e) => setNewMemoryTitle(e.target.value)}
            />
          </div>
          <div className="ic-composer" style={{ padding: 0 }}>
            <label className="ic-sr-only" htmlFor="ic-new-memory-content">
              Inhalt
            </label>
            <textarea
              id="ic-new-memory-content"
              data-testid="new-memory-content"
              placeholder="Inhalt (Markdown)"
              rows={4}
              value={newMemoryContent}
              onChange={(e) => setNewMemoryContent(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-memory-submit"
              disabled={busy || !newMemoryTitle.trim() || !newMemoryContent.trim() || memoryProviders.length === 0}
              onClick={recordMemory}
            >
              Speichern
            </button>
          </div>
        </DetailDialog>
      )}

      {showChannels && (
        <DetailDialog title="Kanäle" onClose={() => setShowChannels(false)}>
          <p className="ic-note">
            Fan-out für den Entscheidungs-Posteingang (aktuell: Freigabeanfragen) an Discord, Telegram und E-Mail. Ein
            Kanal wird beim Serverstart aus Umgebungsvariablen registriert — hier lässt sich nur prüfen, ob er wirklich
            funktioniert.
          </p>
          {notificationChannels.length === 0 && <p className="ic-empty">Kein Kanal registriert.</p>}
          <ul className="ic-milestone-list">
            {notificationChannels.map((c) => (
              <li key={c.kind} data-testid={`channel-${c.kind}`}>
                <span className="ic-milestone-title">{NOTIFICATION_CHANNEL_LABEL[c.kind] ?? c.kind}</span>
                <span className="ic-tag" data-tone={c.ok ? "policy" : "gate"}>
                  {c.ok ? "verbunden" : "nicht erreichbar"}
                </span>
                <span className="ic-note">{c.message}</span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testChannel(c.kind)}>
                  Testen
                </button>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => sendTestNotification(c.kind)}>
                  Testnachricht senden
                </button>
                {channelTestResults[c.kind] && (
                  <span
                    className="ic-tag"
                    data-testid={`channel-test-${c.kind}`}
                    data-tone={channelTestResults[c.kind].ok ? "policy" : "gate"}
                  >
                    {channelTestResults[c.kind].message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}

      {showMailboxes && (
        <DetailDialog title="E-Mail-Postfächer" onClose={() => setShowMailboxes(false)}>
          <p className="ic-note">
            Jedes Postfach lässt sich mehreren Agents zuweisen, und ein Agent kann mehrere Postfächer bearbeiten.
            Zugangsdaten liegen verschlüsselt in der Datenbank und werden nie zurückgeliefert — auch hier nicht.
            Eingehende Mails werden als Fremdinhalt behandelt: die Triage legt sie im Eingang ab, sie landen nie direkt
            in der Arbeitswarteschlange.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Protokolle
          </h3>
          <ul className="ic-milestone-list">
            {mailProviders.map((p) => (
              <li key={p.kind} data-testid={`mail-provider-${p.kind}`}>
                <span className="ic-milestone-title">{MAILBOX_KIND_LABEL[p.kind]}</span>
                <span className="ic-tag" data-tone={p.registered ? "policy" : "gate"}>
                  {p.registered ? "verfügbar" : "nicht registriert"}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Postfächer
          </h3>
          {mailboxes.length === 0 && <p className="ic-empty">Kein Postfach angebunden.</p>}
          <ul className="ic-milestone-list">
            {mailboxes.map((m) => (
              <li key={m.id} data-testid={`mailbox-${m.id}`}>
                <span className="ic-milestone-title">{m.label}</span>
                <span className="ic-tag" data-tone="policy">
                  {MAILBOX_KIND_LABEL[m.kind]}
                </span>
                <span className="ic-note">{m.email_address}</span>
                {m.last_error !== "" && (
                  <span className="ic-tag" data-tone="gate" data-testid={`mailbox-error-${m.id}`}>
                    {m.last_error}
                  </span>
                )}

                <label className="ic-check">
                  <input
                    type="checkbox"
                    data-testid={`mailbox-poll-${m.id}`}
                    checked={m.poll_enabled === 1}
                    disabled={busy}
                    onChange={(e) =>
                      toggleMailboxSetting(m, {
                        pollEnabled: e.target.checked,
                        // Auto-triage without polling is refused by the schema,
                        // so switching polling off has to take it along.
                        ...(e.target.checked ? {} : { autoTriage: false }),
                      })
                    }
                  />
                  Abrufen
                </label>
                <label className="ic-check">
                  <input
                    type="checkbox"
                    data-testid={`mailbox-triage-${m.id}`}
                    checked={m.auto_triage === 1}
                    disabled={busy || m.poll_enabled !== 1}
                    onChange={(e) => toggleMailboxSetting(m, { autoTriage: e.target.checked })}
                  />
                  Auto-Triage
                </label>

                <button type="button" className="ic-btn" disabled={busy} onClick={() => testMailbox(m.id)}>
                  Testen
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`mailbox-poll-now-${m.id}`}
                  disabled={busy}
                  onClick={() => pollMailbox(m.id)}
                >
                  Jetzt abrufen
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`mailbox-messages-${m.id}`}
                  disabled={busy}
                  onClick={() => openMailboxInbox(m.id)}
                >
                  Nachrichten
                </button>
                {mailboxTestResults[m.id] && (
                  <span
                    className="ic-tag"
                    data-testid={`mailbox-test-${m.id}`}
                    data-tone={mailboxTestResults[m.id].ok ? "policy" : "gate"}
                  >
                    {mailboxTestResults[m.id].message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  data-testid={`mailbox-delete-${m.id}`}
                  disabled={busy}
                  onClick={() => deleteMailbox(m.id)}
                >
                  Löschen
                </button>

                <div className="ic-note" style={{ width: "100%" }}>
                  {(m.agents ?? []).length === 0 ? (
                    <span data-testid={`mailbox-agents-empty-${m.id}`}>Kein Agent freigeschaltet.</span>
                  ) : (
                    (m.agents ?? []).map((g) => (
                      <span key={g.agent_id} className="ic-tag" data-testid={`mailbox-agent-${m.id}-${g.agent_id}`}>
                        {g.display_name} · {MAILBOX_ACCESS_LABEL[g.access]}
                        <button
                          type="button"
                          className="ic-btn"
                          data-variant="danger"
                          disabled={busy}
                          onClick={() => revokeMailboxAgent(m.id, g.agent_id)}
                        >
                          Entziehen
                        </button>
                      </span>
                    ))
                  )}
                </div>

                <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap", width: "100%" }}>
                  <label className="ic-sr-only" htmlFor={`ic-grant-agent-${m.id}`}>
                    Agent
                  </label>
                  <select
                    id={`ic-grant-agent-${m.id}`}
                    className="ic-select"
                    data-testid={`mailbox-grant-agent-${m.id}`}
                    value={grantDraft[m.id]?.agentId ?? ""}
                    onChange={(e) =>
                      setGrantDraft((prev) => ({
                        ...prev,
                        [m.id]: { agentId: e.target.value, access: prev[m.id]?.access ?? "read" },
                      }))
                    }
                  >
                    <option value="">Agent wählen …</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                  <label className="ic-sr-only" htmlFor={`ic-grant-access-${m.id}`}>
                    Zugriff
                  </label>
                  <select
                    id={`ic-grant-access-${m.id}`}
                    className="ic-select"
                    data-testid={`mailbox-grant-access-${m.id}`}
                    value={grantDraft[m.id]?.access ?? "read"}
                    onChange={(e) =>
                      setGrantDraft((prev) => ({
                        ...prev,
                        [m.id]: { agentId: prev[m.id]?.agentId ?? "", access: e.target.value as MailboxAccess },
                      }))
                    }
                  >
                    <option value="read">{MAILBOX_ACCESS_LABEL.read}</option>
                    <option value="send">{MAILBOX_ACCESS_LABEL.send}</option>
                  </select>
                  <button
                    type="button"
                    className="ic-btn"
                    data-testid={`mailbox-grant-submit-${m.id}`}
                    disabled={busy || !grantDraft[m.id]?.agentId}
                    onClick={() => grantMailboxAgent(m.id)}
                  >
                    Zuweisen
                  </button>
                </div>

                {mailboxInbox?.mailboxId === m.id && (
                  <ul className="ic-milestone-list" data-testid={`mailbox-inbox-${m.id}`} style={{ width: "100%" }}>
                    {mailboxInbox.messages.length === 0 && <li className="ic-empty">Keine Nachrichten.</li>}
                    {mailboxInbox.messages.map((msg) => (
                      <li key={msg.externalId} data-testid={`mail-message-${msg.externalId}`}>
                        <span className="ic-milestone-title">{msg.subject || "(kein Betreff)"}</span>
                        {msg.unread && (
                          <span className="ic-tag" data-tone="policy">
                            ungelesen
                          </span>
                        )}
                        <span className="ic-note">
                          {msg.from}
                          {msg.snippet ? ` · ${msg.snippet}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neues Postfach
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-mailbox-label">
              Bezeichnung
            </label>
            <input
              id="ic-new-mailbox-label"
              data-testid="new-mailbox-label"
              placeholder="Bezeichnung (z. B. Support)"
              value={newMailboxLabel}
              onChange={(e) => setNewMailboxLabel(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-mailbox-kind">
              Protokoll
            </label>
            <select
              id="ic-new-mailbox-kind"
              className="ic-select"
              data-testid="new-mailbox-kind"
              value={newMailboxKind}
              onChange={(e) => setNewMailboxKind(e.target.value as MailboxKind)}
            >
              <option value="imap">{MAILBOX_KIND_LABEL.imap}</option>
              <option value="jmap">{MAILBOX_KIND_LABEL.jmap}</option>
              <option value="m365">{MAILBOX_KIND_LABEL.m365}</option>
              <option value="gmail">{MAILBOX_KIND_LABEL.gmail}</option>
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-mailbox-address">
              E-Mail-Adresse
            </label>
            <input
              id="ic-new-mailbox-address"
              data-testid="new-mailbox-address"
              placeholder="E-Mail-Adresse"
              value={newMailboxAddress}
              onChange={(e) => setNewMailboxAddress(e.target.value)}
            />

            {/* Only the fields the chosen protocol actually needs — the same
                rule the store enforces (mailbox-store.ts#assertConnectable). */}
            {newMailboxKind === "imap" && (
              <>
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-host">
                  IMAP-Host
                </label>
                <input
                  id="ic-new-mailbox-host"
                  data-testid="new-mailbox-host"
                  placeholder="IMAP-Host"
                  value={newMailboxHost}
                  onChange={(e) => setNewMailboxHost(e.target.value)}
                />
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-username">
                  Benutzername
                </label>
                <input
                  id="ic-new-mailbox-username"
                  data-testid="new-mailbox-username"
                  placeholder="Benutzername"
                  value={newMailboxUsername}
                  onChange={(e) => setNewMailboxUsername(e.target.value)}
                />
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-smtp">
                  SMTP-Host (zum Senden)
                </label>
                <input
                  id="ic-new-mailbox-smtp"
                  data-testid="new-mailbox-smtp"
                  placeholder="SMTP-Host (zum Senden)"
                  value={newMailboxSmtpHost}
                  onChange={(e) => setNewMailboxSmtpHost(e.target.value)}
                />
              </>
            )}
            {newMailboxKind === "jmap" && (
              <>
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-session">
                  JMAP-Session-URL
                </label>
                <input
                  id="ic-new-mailbox-session"
                  data-testid="new-mailbox-session-url"
                  placeholder="JMAP-Session-URL"
                  value={newMailboxSessionUrl}
                  onChange={(e) => setNewMailboxSessionUrl(e.target.value)}
                />
              </>
            )}
            {newMailboxKind === "m365" && (
              <>
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-tenant">
                  Tenant-ID
                </label>
                <input
                  id="ic-new-mailbox-tenant"
                  data-testid="new-mailbox-tenant-id"
                  placeholder="Tenant-ID"
                  value={newMailboxTenantId}
                  onChange={(e) => setNewMailboxTenantId(e.target.value)}
                />
              </>
            )}
            {(newMailboxKind === "m365" || newMailboxKind === "gmail") && (
              <>
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-client">
                  Client-ID
                </label>
                <input
                  id="ic-new-mailbox-client"
                  data-testid="new-mailbox-client-id"
                  placeholder="Client-ID"
                  value={newMailboxClientId}
                  onChange={(e) => setNewMailboxClientId(e.target.value)}
                />
                <label className="ic-sr-only" htmlFor="ic-new-mailbox-refresh">
                  Refresh-Token
                </label>
                <input
                  id="ic-new-mailbox-refresh"
                  type="password"
                  data-testid="new-mailbox-refresh-token"
                  placeholder="Refresh-Token"
                  value={newMailboxRefreshToken}
                  onChange={(e) => setNewMailboxRefreshToken(e.target.value)}
                />
              </>
            )}

            <label className="ic-sr-only" htmlFor="ic-new-mailbox-secret">
              {newMailboxKind === "jmap" ? "Bearer-Token" : newMailboxKind === "imap" ? "Passwort" : "Client-Secret"}
            </label>
            <input
              id="ic-new-mailbox-secret"
              type="password"
              data-testid="new-mailbox-secret"
              placeholder={
                newMailboxKind === "jmap" ? "Bearer-Token" : newMailboxKind === "imap" ? "Passwort" : "Client-Secret"
              }
              value={newMailboxSecret}
              onChange={(e) => setNewMailboxSecret(e.target.value)}
            />

            <label className="ic-check">
              <input
                type="checkbox"
                data-testid="new-mailbox-poll"
                checked={newMailboxPoll}
                onChange={(e) => {
                  setNewMailboxPoll(e.target.checked);
                  if (!e.target.checked) setNewMailboxAutoTriage(false);
                }}
              />
              Regelmäßig abrufen
            </label>
            <label className="ic-check">
              <input
                type="checkbox"
                data-testid="new-mailbox-triage"
                checked={newMailboxAutoTriage}
                disabled={!newMailboxPoll}
                onChange={(e) => setNewMailboxAutoTriage(e.target.checked)}
              />
              Eingang automatisch triagieren
            </label>

            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-mailbox-submit"
              disabled={busy || !newMailboxLabel.trim() || !newMailboxAddress.trim()}
              onClick={createMailbox}
            >
              Anbinden
            </button>
          </div>
        </DetailDialog>
      )}

      {showMarketplaces && (
        <DetailDialog title="Marktplätze" onClose={() => setShowMarketplaces(false)}>
          <p className="ic-note">
            Quellen für Skills und MCP-Server. Kataloge werden live gelesen und nie zwischengespeichert — gespeichert
            wird nur, was tatsächlich installiert wurde, samt Herkunft. Installiert wird über die Eintrags-ID: der
            Server holt den Eintrag erneut von der Quelle, statt einer mitgeschickten Beschreibung zu vertrauen. Ein
            Skill wird als Markdown abgelegt, es wird dabei nichts ausgeführt; ein MCP-Server startet erst, wenn Sie ihn
            in den MCP-Einstellungen verbinden.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Quellenarten
          </h3>
          <ul className="ic-milestone-list">
            {marketplaceKinds.map((k) => (
              <li key={k.kind} data-testid={`marketplace-kind-${k.kind}`}>
                <span className="ic-milestone-title">{MARKETPLACE_KIND_LABEL[k.kind]}</span>
                <span className="ic-tag" data-tone={k.registered ? "policy" : "gate"}>
                  {k.registered ? "verfügbar" : "nicht registriert"}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Quellen
          </h3>
          {marketplaces.length === 0 && <p className="ic-empty">Keine Quelle eingetragen.</p>}
          <ul className="ic-milestone-list">
            {marketplaces.map((m) => (
              <li key={m.id} data-testid={`marketplace-${m.id}`}>
                <span className="ic-milestone-title">{m.name}</span>
                <span className="ic-tag" data-tone="policy">
                  {MARKETPLACE_KIND_LABEL[m.kind]}
                </span>
                <span className="ic-note">{m.url}</span>
                {m.last_synced_at !== null && m.last_error === "" && (
                  <span className="ic-tag" data-testid={`marketplace-count-${m.id}`}>
                    {m.entry_count} Einträge
                  </span>
                )}
                {m.last_error !== "" && (
                  <span className="ic-tag" data-tone="gate" data-testid={`marketplace-error-${m.id}`}>
                    {m.last_error}
                  </span>
                )}

                <label className="ic-check">
                  <input
                    type="checkbox"
                    data-testid={`marketplace-enabled-${m.id}`}
                    checked={m.enabled === 1}
                    disabled={busy}
                    onChange={() => toggleMarketplace(m)}
                  />
                  Aktiv
                </label>
                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`marketplace-browse-${m.id}`}
                  disabled={busy}
                  onClick={() => browseMarketplace(m.id)}
                >
                  Durchsuchen
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  data-testid={`marketplace-delete-${m.id}`}
                  disabled={busy}
                  onClick={() => deleteMarketplace(m.id)}
                >
                  Entfernen
                </button>

                {marketplaceEntries?.id === m.id && (
                  <ul
                    className="ic-milestone-list"
                    data-testid={`marketplace-entries-${m.id}`}
                    style={{ width: "100%" }}
                  >
                    {marketplaceEntries.entries.length === 0 && <li className="ic-empty">Nichts im Angebot.</li>}
                    {marketplaceEntries.entries.map((entry) => (
                      <li key={entry.id} data-testid={`marketplace-entry-${entry.id}`}>
                        <span className="ic-milestone-title">{entry.title}</span>
                        <span className="ic-tag" data-tone="policy">
                          {MARKETPLACE_ENTRY_TYPE_LABEL[entry.type]}
                        </span>
                        {entry.version !== "" && <span className="ic-tag">{entry.version}</span>}
                        <span className="ic-note">{entry.description}</span>
                        {entry.mcp?.command && (
                          <span className="ic-tag" data-testid={`marketplace-entry-command-${entry.id}`}>
                            {[entry.mcp.command, ...(entry.mcp.args ?? [])].join(" ")}
                          </span>
                        )}
                        <button
                          type="button"
                          className="ic-btn"
                          data-variant="primary"
                          data-testid={`marketplace-install-${entry.id}`}
                          disabled={busy}
                          onClick={() => installEntry(m.id, entry)}
                        >
                          Installieren
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Installiert
          </h3>
          {marketplaceInstalls.length === 0 && <p className="ic-empty">Nichts installiert.</p>}
          <ul className="ic-milestone-list">
            {marketplaceInstalls.map((install) => (
              <li key={install.id} data-testid={`marketplace-install-row-${install.name}`}>
                <span className="ic-milestone-title">{install.name}</span>
                <span className="ic-tag" data-tone="policy">
                  {MARKETPLACE_ENTRY_TYPE_LABEL[install.entry_type]}
                </span>
                {install.version !== "" && <span className="ic-tag">{install.version}</span>}
                <span className="ic-note">
                  {install.source_url || "—"}
                  {install.marketplace_id === null ? " · Quelle entfernt" : ""}
                </span>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  data-testid={`marketplace-uninstall-${install.name}`}
                  disabled={busy}
                  onClick={() => uninstallEntry(install)}
                >
                  Deinstallieren
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neue Quelle
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-marketplace-name">
              Name
            </label>
            <input
              id="ic-new-marketplace-name"
              data-testid="new-marketplace-name"
              placeholder="Name (z. B. acme-katalog)"
              value={newMarketplaceName}
              onChange={(e) => setNewMarketplaceName(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-marketplace-kind">
              Art
            </label>
            <select
              id="ic-new-marketplace-kind"
              className="ic-select"
              data-testid="new-marketplace-kind"
              value={newMarketplaceKind}
              onChange={(e) => setNewMarketplaceKind(e.target.value as MarketplaceKind)}
            >
              <option value="catalog">{MARKETPLACE_KIND_LABEL.catalog}</option>
              <option value="mcp-registry">{MARKETPLACE_KIND_LABEL["mcp-registry"]}</option>
              <option value="claude-plugin">{MARKETPLACE_KIND_LABEL["claude-plugin"]}</option>
              <option value="git">{MARKETPLACE_KIND_LABEL.git}</option>
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-marketplace-url">
              URL
            </label>
            <input
              id="ic-new-marketplace-url"
              data-testid="new-marketplace-url"
              placeholder={MARKETPLACE_URL_HINT[newMarketplaceKind]}
              value={newMarketplaceUrl}
              onChange={(e) => setNewMarketplaceUrl(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-marketplace-submit"
              disabled={busy || !newMarketplaceName.trim() || !newMarketplaceUrl.trim()}
              onClick={createMarketplace}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showMessenger && (
        <DetailDialog title="Messenger" onClose={() => setShowMessenger(false)}>
          <p className="ic-note">
            Wer über Telegram oder Discord schreibt, erreicht die Assistenz erst nach Ihrer Freigabe. Vorher entsteht
            nur ein Eintrag mit Code — keine Aufgabe, keine Antwort. Danach entscheidet die Rolle über die Befugnis,
            nicht der Kanal.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Kanäle
          </h3>
          {messengerChannels.length === 0 && <p className="ic-empty">Kein Messenger-Kanal registriert.</p>}
          <ul className="ic-milestone-list">
            {messengerChannels.map((c) => (
              <li key={c.kind} data-testid={`messenger-channel-${c.kind}`}>
                <span className="ic-milestone-title">{MESSENGER_CHANNEL_LABEL[c.kind] ?? c.kind}</span>
                <span className="ic-tag" data-tone={c.registered ? "policy" : "gate"}>
                  {c.registered ? "verfügbar" : "nicht registriert"}
                </span>
                {c.message !== "" && (
                  <span
                    className="ic-tag"
                    data-tone={c.ok ? "policy" : "gate"}
                    data-testid={`messenger-channel-message-${c.kind}`}
                  >
                    {c.message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`messenger-poll-${c.kind}`}
                  disabled={busy || !c.registered}
                  onClick={() => pollMessengerChannel(c.kind)}
                >
                  Abrufen
                </button>
                {messengerPollResults[c.kind] && (
                  <span className="ic-tag" data-testid={`messenger-poll-result-${c.kind}`}>
                    {messengerPollResults[c.kind]}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Absender
          </h3>
          {pairings.length === 0 && <p className="ic-empty">Bisher hat niemand geschrieben.</p>}
          <ul className="ic-milestone-list">
            {pairings.map((p) => (
              <li key={p.id} data-testid={`pairing-${p.id}`} style={{ flexWrap: "wrap" }}>
                {/* `display_name` is chosen by whoever wrote in. Plain text
                    only — never markup, never a link target. */}
                <span className="ic-milestone-title">{p.display_name || p.sender_id}</span>
                <span className="ic-tag" data-tone="policy">
                  {MESSENGER_CHANNEL_LABEL[p.channel_kind] ?? p.channel_kind}
                </span>
                <span
                  className="ic-tag"
                  data-tone={p.status === "active" ? "policy" : "gate"}
                  data-testid={`pairing-status-${p.id}`}
                >
                  {PAIRING_STATUS_LABEL[p.status]}
                </span>
                {p.status === "active" && (
                  <span
                    className="ic-tag"
                    data-tone={p.role === "owner" ? "gate" : "policy"}
                    data-testid={`pairing-role-${p.id}`}
                  >
                    {PAIRING_ROLE_LABEL[p.role]}
                  </span>
                )}

                {p.status === "pending" && (
                  <>
                    {p.pairing_code !== "" && (
                      <span className="ic-code" data-testid={`pairing-code-${p.id}`}>
                        {p.pairing_code}
                      </span>
                    )}
                    <div className="ic-warn" style={{ width: "100%" }} data-testid={`pairing-role-hint-${p.id}`}>
                      Als Chef freigeben heißt: diese Person spricht über den Chat als Sie und kann sofort Aufträge
                      erteilen. Als Gast landet ihre Nachricht nur als Fremdinhalt im Eingang.
                    </div>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      data-testid={`pairing-accept-owner-${p.id}`}
                      disabled={busy}
                      onClick={() => acceptPairing(p.id, "owner")}
                    >
                      Als Chef freigeben
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-testid={`pairing-accept-guest-${p.id}`}
                      disabled={busy}
                      onClick={() => acceptPairing(p.id, "guest")}
                    >
                      Als Gast freigeben
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="danger"
                      data-testid={`pairing-block-${p.id}`}
                      disabled={busy}
                      onClick={() => blockPairing(p.id)}
                    >
                      Blockieren
                    </button>
                  </>
                )}

                {p.status === "active" && (
                  <>
                    <button
                      type="button"
                      className="ic-btn"
                      data-testid={`pairing-revoke-${p.id}`}
                      disabled={busy}
                      onClick={() => revokePairing(p.id)}
                    >
                      Freigabe entziehen
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="danger"
                      data-testid={`pairing-block-${p.id}`}
                      disabled={busy}
                      onClick={() => blockPairing(p.id)}
                    >
                      Blockieren
                    </button>
                  </>
                )}

                {p.status === "blocked" && (
                  <button
                    type="button"
                    className="ic-btn"
                    data-testid={`pairing-unblock-${p.id}`}
                    disabled={busy}
                    onClick={() => unblockPairing(p.id)}
                  >
                    Entsperren
                  </button>
                )}
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}

      {showChangeProposals && (
        <DetailDialog title="Änderungsfreigaben" onClose={() => setShowChangeProposals(false)}>
          <p className="ic-note">
            Ein Agent schlägt Dateiänderungen vor, geschrieben wird erst nach Ihrer Freigabe. Beim Anwenden gilt alles
            oder nichts: hat sich eine Datei seit dem Vorschlag geändert, wird gar nichts geschrieben und der Konflikt
            hier gemeldet.
          </p>

          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-proposal-status-filter">
              Status
            </label>
            <select
              id="ic-proposal-status-filter"
              className="ic-select"
              data-testid="proposal-status-filter"
              value={proposalStatusFilter}
              disabled={busy}
              onChange={(e) => filterChangeProposals(e.target.value as ChangeProposalStatus | "")}
            >
              <option value="">Alle</option>
              <option value="pending">{CHANGE_PROPOSAL_STATUS_LABEL.pending}</option>
              <option value="approved">{CHANGE_PROPOSAL_STATUS_LABEL.approved}</option>
              <option value="rejected">{CHANGE_PROPOSAL_STATUS_LABEL.rejected}</option>
              <option value="applied">{CHANGE_PROPOSAL_STATUS_LABEL.applied}</option>
              <option value="failed">{CHANGE_PROPOSAL_STATUS_LABEL.failed}</option>
              <option value="superseded">{CHANGE_PROPOSAL_STATUS_LABEL.superseded}</option>
            </select>
          </div>

          {sortedProposals.length === 0 && <p className="ic-empty">Kein Änderungsvorschlag.</p>}
          <ul className="ic-milestone-list">
            {sortedProposals.map((p) => (
              <li key={p.id} data-testid={`proposal-${p.id}`} style={{ flexWrap: "wrap" }}>
                <span className="ic-milestone-title">{p.title}</span>
                <span
                  className="ic-tag"
                  data-tone={p.status === "pending" ? "gate" : "policy"}
                  data-testid={`proposal-status-${p.id}`}
                >
                  {CHANGE_PROPOSAL_STATUS_LABEL[p.status]}
                </span>
                <span className="ic-tag">
                  {p.file_count} Datei{p.file_count === 1 ? "" : "en"}
                </span>
                <span className="ic-note">{p.workspace_path}</span>
                {p.summary !== "" && <span className="ic-note">{p.summary}</span>}

                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`proposal-open-${p.id}`}
                  disabled={busy}
                  onClick={() => openProposalDetail(p.id)}
                >
                  Dateien
                </button>

                {p.status === "pending" && (
                  <>
                    <label className="ic-sr-only" htmlFor={`ic-proposal-reason-${p.id}`}>
                      Grund der Ablehnung
                    </label>
                    <input
                      id={`ic-proposal-reason-${p.id}`}
                      data-testid={`proposal-reason-${p.id}`}
                      placeholder="Grund (bei Ablehnung)"
                      value={proposalReason[p.id] ?? ""}
                      onChange={(e) => setProposalReason((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      data-testid={`proposal-approve-${p.id}`}
                      disabled={busy}
                      onClick={() => decideProposal(p.id, "approved")}
                    >
                      Freigeben
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="danger"
                      data-testid={`proposal-reject-${p.id}`}
                      disabled={busy}
                      onClick={() => decideProposal(p.id, "rejected")}
                    >
                      Ablehnen
                    </button>
                  </>
                )}

                {/* Only an approved proposal can be written — a pending one has
                    no apply button at all, not a disabled one. */}
                {p.status === "approved" && (
                  <button
                    type="button"
                    className="ic-btn"
                    data-variant="primary"
                    data-testid={`proposal-apply-${p.id}`}
                    disabled={busy}
                    onClick={() => applyProposal(p.id)}
                  >
                    Anwenden
                  </button>
                )}

                {proposalApplyResults[p.id] && (
                  <div className="ic-note" style={{ width: "100%" }} data-testid={`proposal-apply-result-${p.id}`}>
                    {proposalApplyResults[p.id].conflicts.length === 0
                      ? `${proposalApplyResults[p.id].applied.length} Datei${
                          proposalApplyResults[p.id].applied.length === 1 ? "" : "en"
                        } geschrieben.`
                      : "Nichts geschrieben — der Arbeitsordner ist unverändert."}
                  </div>
                )}
                {(proposalApplyResults[p.id]?.conflicts.length ?? 0) > 0 && (
                  <div style={{ width: "100%" }} data-testid={`proposal-conflicts-${p.id}`}>
                    {proposalApplyResults[p.id].conflicts.map((conflict) => (
                      <div key={conflict.path} className="ic-conflict">
                        {conflict.path} — {conflict.reason}
                      </div>
                    ))}
                  </div>
                )}

                {proposalDetail?.proposal.id === p.id && (
                  <ul className="ic-milestone-list" data-testid={`proposal-files-${p.id}`} style={{ width: "100%" }}>
                    {proposalDetail.files.length === 0 && <li className="ic-empty">Keine Datei im Vorschlag.</li>}
                    {proposalDetail.files.map((file) => (
                      <li key={file.id} data-testid={`proposal-file-${file.id}`} style={{ flexWrap: "wrap" }}>
                        <span className="ic-milestone-title">{file.path}</span>
                        <span className="ic-tag" data-tone="policy">
                          {CHANGE_OPERATION_LABEL[file.operation]}
                        </span>
                        {file.operation !== "delete" && (
                          <pre className="ic-pre" data-testid={`proposal-file-content-${file.id}`}>
                            {file.content}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}

      {showVessels && (
        <DetailDialog title="Vessels & Talente" onClose={() => setShowVessels(false)}>
          <p className="ic-note">
            Ein Agent ist ein Vessel × Talent. Das Vessel ist der Ausführungsrahmen: welche Runtime, welches Modell und
            wie lange, wie oft und wie parallel ein Lauf sein darf. Das Talent ist das Können: Rolle, Seniorität,
            Policy, Auftreten, Skills. Genau deshalb kann dieselbe Rolle in einem anderen Vessel laufen — ein Vessel
            regelt nur, wie lange und wie oft gearbeitet wird, nie was dabei erlaubt ist. Berechtigungen stehen
            ausschliesslich im Talent.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Vessels
          </h3>
          {vessels.length === 0 && <p className="ic-empty">Kein Vessel angelegt.</p>}
          <ul className="ic-milestone-list">
            {vessels.map((v) => (
              <li key={v.id} data-testid={`vessel-${v.id}`} style={{ flexWrap: "wrap" }}>
                <span className="ic-milestone-title">{v.label || v.key}</span>
                <span className="ic-tag" data-testid={`vessel-key-${v.id}`}>
                  {v.key}
                </span>
                <span className="ic-tag" data-tone="policy" data-testid={`vessel-runtime-${v.id}`}>
                  {v.runtime_provider}
                </span>
                {v.model !== "" && (
                  <span className="ic-tag" data-testid={`vessel-model-${v.id}`}>
                    {v.model}
                  </span>
                )}
                {/* The three limits are shown as what they mean for a run, not
                    as the columns they are stored in. */}
                <span className="ic-tag" data-testid={`vessel-timeout-${v.id}`}>
                  Zeitlimit {formatDurationMs(v.timeout_ms)}
                </span>
                <span className="ic-tag" data-testid={`vessel-retries-${v.id}`}>
                  {v.max_retries} Versuch{v.max_retries === 1 ? "" : "e"}
                </span>
                <span className="ic-tag" data-testid={`vessel-concurrency-${v.id}`}>
                  max. {v.max_concurrency} gleichzeitig
                </span>
                <span className="ic-note" style={{ width: "100%" }} data-testid={`vessel-agents-${v.id}`}>
                  {v.agents.length === 0
                    ? "Von keinem Agent genutzt."
                    : `Genutzt von: ${v.agents.map((a) => a.display_name).join(", ")}`}
                </span>

                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`vessel-edit-${v.id}`}
                  disabled={busy}
                  onClick={() => startEditVessel(v)}
                >
                  Bearbeiten
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  data-testid={`vessel-delete-${v.id}`}
                  disabled={busy}
                  onClick={() => deleteVessel(v.id)}
                >
                  Entfernen
                </button>

                {/* The server's own words: a 409 names the agents that still
                    run in this vessel, and no generic wording could. */}
                {vesselErrors[v.id] && (
                  <div className="ic-conflict" style={{ width: "100%" }} data-testid={`vessel-error-${v.id}`}>
                    {vesselErrors[v.id]}
                  </div>
                )}

                {editVesselId === v.id && (
                  <div className="ic-form-row" data-testid={`vessel-form-${v.id}`}>
                    <label className="ic-sr-only" htmlFor={`ic-vessel-label-${v.id}`}>
                      Bezeichnung
                    </label>
                    <input
                      id={`ic-vessel-label-${v.id}`}
                      data-testid={`vessel-edit-label-${v.id}`}
                      placeholder="Bezeichnung"
                      value={vesselDraft.label}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, label: e.target.value }))}
                    />
                    <label className="ic-sr-only" htmlFor={`ic-vessel-runtime-${v.id}`}>
                      Runtime
                    </label>
                    <select
                      id={`ic-vessel-runtime-${v.id}`}
                      className="ic-select"
                      data-testid={`vessel-edit-runtime-${v.id}`}
                      value={vesselDraft.runtimeProvider}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, runtimeProvider: e.target.value }))}
                    >
                      {/* A vessel can point at a provider this install no longer
                          registers; say so instead of silently selecting another. */}
                      {!runtimes.some((r) => r.type === vesselDraft.runtimeProvider) && (
                        <option value={vesselDraft.runtimeProvider}>
                          {vesselDraft.runtimeProvider} (nicht registriert)
                        </option>
                      )}
                      {runtimes.map((r) => (
                        <option key={r.type} value={r.type}>
                          {r.type}
                        </option>
                      ))}
                    </select>
                    <label className="ic-sr-only" htmlFor={`ic-vessel-model-${v.id}`}>
                      Modell
                    </label>
                    <input
                      id={`ic-vessel-model-${v.id}`}
                      data-testid={`vessel-edit-model-${v.id}`}
                      placeholder="Modell"
                      value={vesselDraft.model}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, model: e.target.value }))}
                    />
                    <label htmlFor={`ic-vessel-timeout-${v.id}`}>Zeitlimit (Min.)</label>
                    <input
                      id={`ic-vessel-timeout-${v.id}`}
                      type="number"
                      min={1}
                      data-testid={`vessel-edit-timeout-${v.id}`}
                      value={vesselDraft.timeoutMin}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, timeoutMin: e.target.value }))}
                    />
                    <label htmlFor={`ic-vessel-retries-${v.id}`}>Versuche</label>
                    <input
                      id={`ic-vessel-retries-${v.id}`}
                      type="number"
                      min={0}
                      data-testid={`vessel-edit-retries-${v.id}`}
                      value={vesselDraft.maxRetries}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, maxRetries: e.target.value }))}
                    />
                    <label htmlFor={`ic-vessel-concurrency-${v.id}`}>Gleichzeitig</label>
                    <input
                      id={`ic-vessel-concurrency-${v.id}`}
                      type="number"
                      min={1}
                      data-testid={`vessel-edit-concurrency-${v.id}`}
                      value={vesselDraft.maxConcurrency}
                      onChange={(e) => setVesselDraft((prev) => ({ ...prev, maxConcurrency: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="primary"
                      data-testid={`vessel-save-${v.id}`}
                      disabled={busy}
                      onClick={() => saveVessel(v.id)}
                    >
                      Speichern
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-testid={`vessel-cancel-edit-${v.id}`}
                      disabled={busy}
                      onClick={() => setEditVesselId(null)}
                    >
                      Abbrechen
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neues Vessel
          </h3>
          <div className="ic-form-row">
            <label className="ic-sr-only" htmlFor="ic-new-vessel-key">
              Schlüssel
            </label>
            <input
              id="ic-new-vessel-key"
              data-testid="new-vessel-key"
              placeholder="Schlüssel (z. B. claude-fast)"
              value={newVesselKey}
              onChange={(e) => setNewVesselKey(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-vessel-label">
              Bezeichnung
            </label>
            <input
              id="ic-new-vessel-label"
              data-testid="new-vessel-label"
              placeholder="Bezeichnung"
              value={newVesselLabel}
              onChange={(e) => setNewVesselLabel(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-vessel-runtime">
              Runtime
            </label>
            <select
              id="ic-new-vessel-runtime"
              className="ic-select"
              data-testid="new-vessel-runtime"
              value={newVesselRuntime}
              onChange={(e) => setNewVesselRuntime(e.target.value)}
            >
              <option value="">Runtime wählen…</option>
              {runtimes.map((r) => (
                <option key={r.type} value={r.type}>
                  {r.type} {r.health.healthy ? "● bereit" : "○ nicht verfügbar"}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-vessel-model">
              Modell
            </label>
            <input
              id="ic-new-vessel-model"
              data-testid="new-vessel-model"
              placeholder="Modell (optional)"
              value={newVesselModel}
              onChange={(e) => setNewVesselModel(e.target.value)}
            />
            <label htmlFor="ic-new-vessel-timeout">Zeitlimit (Min.)</label>
            <input
              id="ic-new-vessel-timeout"
              type="number"
              min={1}
              data-testid="new-vessel-timeout"
              value={newVesselTimeoutMin}
              onChange={(e) => setNewVesselTimeoutMin(e.target.value)}
            />
            <label htmlFor="ic-new-vessel-retries">Versuche</label>
            <input
              id="ic-new-vessel-retries"
              type="number"
              min={0}
              data-testid="new-vessel-retries"
              value={newVesselRetries}
              onChange={(e) => setNewVesselRetries(e.target.value)}
            />
            <label htmlFor="ic-new-vessel-concurrency">Gleichzeitig</label>
            <input
              id="ic-new-vessel-concurrency"
              type="number"
              min={1}
              data-testid="new-vessel-concurrency"
              value={newVesselConcurrency}
              onChange={(e) => setNewVesselConcurrency(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-vessel-submit"
              disabled={busy || !newVesselKey.trim() || !newVesselRuntime}
              onClick={createVessel}
            >
              Anlegen
            </button>
          </div>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Talente
          </h3>
          {talents.length === 0 && <p className="ic-empty">Kein Talent angelegt.</p>}
          <ul className="ic-milestone-list">
            {talents.map((t) => (
              <li key={t.id} data-testid={`talent-${t.id}`} style={{ flexWrap: "wrap" }}>
                <span className="ic-milestone-title">{t.professional_role}</span>
                <span className="ic-tag" data-testid={`talent-key-${t.id}`}>
                  {t.key}
                </span>
                {t.seniority !== "" && (
                  <span className="ic-tag" data-tone="policy" data-testid={`talent-seniority-${t.id}`}>
                    {t.seniority}
                  </span>
                )}
                {talentSkills(t.skills_json).map((skill) => (
                  <span key={skill} className="ic-tag">
                    {skill}
                  </span>
                ))}
                {t.role_summary !== "" && (
                  <span className="ic-note" style={{ width: "100%" }}>
                    {t.role_summary}
                  </span>
                )}
                <span className="ic-note" style={{ width: "100%" }} data-testid={`talent-agents-${t.id}`}>
                  {t.agents.length === 0
                    ? "Von keinem Agent genutzt."
                    : `Genutzt von: ${t.agents.map((a) => a.display_name).join(", ")}`}
                </span>

                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`talent-edit-${t.id}`}
                  disabled={busy}
                  onClick={() => startEditTalent(t)}
                >
                  Bearbeiten
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  data-testid={`talent-delete-${t.id}`}
                  disabled={busy}
                  onClick={() => deleteTalent(t.id)}
                >
                  Entfernen
                </button>

                {talentErrors[t.id] && (
                  <div className="ic-conflict" style={{ width: "100%" }} data-testid={`talent-error-${t.id}`}>
                    {talentErrors[t.id]}
                  </div>
                )}

                {editTalentId === t.id && (
                  <div className="ic-form-row" data-testid={`talent-form-${t.id}`}>
                    <label className="ic-sr-only" htmlFor={`ic-talent-role-${t.id}`}>
                      Berufsrolle
                    </label>
                    <input
                      id={`ic-talent-role-${t.id}`}
                      data-testid={`talent-edit-role-${t.id}`}
                      placeholder="Berufsrolle"
                      value={talentDraft.professionalRole}
                      onChange={(e) => setTalentDraft((prev) => ({ ...prev, professionalRole: e.target.value }))}
                    />
                    <label className="ic-sr-only" htmlFor={`ic-talent-summary-${t.id}`}>
                      Kurzbeschreibung
                    </label>
                    <input
                      id={`ic-talent-summary-${t.id}`}
                      data-testid={`talent-edit-summary-${t.id}`}
                      placeholder="Kurzbeschreibung"
                      value={talentDraft.roleSummary}
                      onChange={(e) => setTalentDraft((prev) => ({ ...prev, roleSummary: e.target.value }))}
                    />
                    <label className="ic-sr-only" htmlFor={`ic-talent-seniority-${t.id}`}>
                      Seniorität
                    </label>
                    <select
                      id={`ic-talent-seniority-${t.id}`}
                      className="ic-select"
                      data-testid={`talent-edit-seniority-${t.id}`}
                      value={talentDraft.seniority}
                      onChange={(e) => setTalentDraft((prev) => ({ ...prev, seniority: e.target.value }))}
                    >
                      {/* The vocabulary comes from the server; a value it no
                          longer offers is still shown rather than swapped. */}
                      {!seniorities.includes(talentDraft.seniority) && (
                        <option value={talentDraft.seniority}>{talentDraft.seniority || "—"}</option>
                      )}
                      {seniorities.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="primary"
                      data-testid={`talent-save-${t.id}`}
                      disabled={busy}
                      onClick={() => saveTalent(t.id)}
                    >
                      Speichern
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-testid={`talent-cancel-edit-${t.id}`}
                      disabled={busy}
                      onClick={() => setEditTalentId(null)}
                    >
                      Abbrechen
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neues Talent
          </h3>
          <div className="ic-form-row">
            <label className="ic-sr-only" htmlFor="ic-new-talent-key">
              Schlüssel
            </label>
            <input
              id="ic-new-talent-key"
              data-testid="new-talent-key"
              placeholder="Schlüssel (z. B. cto)"
              value={newTalentKey}
              onChange={(e) => setNewTalentKey(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-talent-role">
              Berufsrolle
            </label>
            <input
              id="ic-new-talent-role"
              data-testid="new-talent-role"
              placeholder="Berufsrolle (z. B. chief_technology_officer)"
              value={newTalentRole}
              onChange={(e) => setNewTalentRole(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-talent-summary">
              Kurzbeschreibung
            </label>
            <input
              id="ic-new-talent-summary"
              data-testid="new-talent-summary"
              placeholder="Kurzbeschreibung (optional)"
              value={newTalentSummary}
              onChange={(e) => setNewTalentSummary(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-talent-seniority">
              Seniorität
            </label>
            <select
              id="ic-new-talent-seniority"
              className="ic-select"
              data-testid="new-talent-seniority"
              value={newTalentSeniority}
              onChange={(e) => setNewTalentSeniority(e.target.value)}
            >
              <option value="">Seniorität wählen…</option>
              {seniorities.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-talent-submit"
              disabled={busy || !newTalentKey.trim() || !newTalentRole.trim()}
              onClick={createTalent}
            >
              Anlegen
            </button>
          </div>
        </DetailDialog>
      )}

      {showTools && (
        <DetailDialog title="Werkzeuge" onClose={() => setShowTools(false)}>
          <p className="ic-note">
            Zwei Tabellen, zwei Aussagen: das Register sagt, was dieser Server ausführen <em>kann</em>, die Freigaben
            sagen, wer es benutzen <em>darf</em>. Registrieren erteilt nichts. Eine Freigabe nennt genau einen
            Geltungsbereich — einen Agenten (diesen Posten), ein Projekt (diesen Kontext) oder ein Talent (die Rolle
            allgemein). Überschneiden sie sich, gewinnt das Spezifischere: Agent vor Projekt vor Talent.
          </p>
          <p className="ic-warn" data-testid="tool-disabled-note">
            Ein abgeschaltetes Werkzeug wird für alle verweigert — unabhängig von jeder Freigabe.
          </p>

          {tools.length === 0 && <p className="ic-empty">Kein Werkzeug registriert.</p>}
          <ul className="ic-milestone-list">
            {tools.map((tool) => {
              const kind = grantScopeKind[tool.id] ?? "agent";
              const scopeId = grantScopeId[tool.id] ?? "";
              const approval = grantApproval[tool.id] ?? "default";
              return (
                <li
                  key={tool.id}
                  className="ic-tool-row"
                  data-tool-enabled={tool.enabled === 0 ? "false" : "true"}
                  data-testid={`tool-${tool.id}`}
                  style={{ flexWrap: "wrap" }}
                >
                  <span className="ic-milestone-title">{tool.label || tool.key}</span>
                  <span className="ic-tag" data-testid={`tool-key-${tool.id}`}>
                    {tool.key}
                  </span>
                  {/* The class named by what it does to the world. "external"
                      is a column value; "wirkt nach außen" is the thing the
                      operator has to weigh. */}
                  <span
                    className="ic-tag"
                    data-tone={tool.risk_class === "external" ? "gate" : "policy"}
                    data-testid={`tool-risk-${tool.id}`}
                  >
                    {TOOL_RISK_CLASS_LABEL[tool.risk_class]}
                  </span>
                  <span className="ic-tag" data-testid={`tool-origin-${tool.id}`}>
                    {TOOL_ORIGIN_LABEL[tool.origin] ?? tool.origin}
                  </span>
                  {tool.enabled === 0 && (
                    <span className="ic-tag" data-tone="off" data-testid={`tool-off-${tool.id}`}>
                      abgeschaltet
                    </span>
                  )}
                  <button
                    type="button"
                    className="ic-btn"
                    data-testid={`tool-toggle-${tool.id}`}
                    disabled={busy}
                    onClick={() => setToolEnabled(tool.id, tool.enabled === 0)}
                  >
                    {tool.enabled === 0 ? "Einschalten" : "Abschalten"}
                  </button>
                  {tool.description !== "" && (
                    <span className="ic-note" style={{ width: "100%" }} data-testid={`tool-description-${tool.id}`}>
                      {tool.description}
                    </span>
                  )}

                  {tool.grants.length === 0 ? (
                    <span className="ic-note" style={{ width: "100%" }} data-testid={`tool-grants-empty-${tool.id}`}>
                      Niemand darf dieses Werkzeug benutzen.
                    </span>
                  ) : (
                    <ul className="ic-milestone-list" style={{ width: "100%" }}>
                      {tool.grants.map((grant) => (
                        <li key={grant.id} data-testid={`tool-grant-${grant.id}`} style={{ flexWrap: "wrap" }}>
                          <span className="ic-milestone-title" data-testid={`tool-grant-holder-${grant.id}`}>
                            {grantHolder(grant)}
                          </span>
                          <span
                            className="ic-tag"
                            data-tone={grantRequiresApproval(tool, grant) ? "gate" : undefined}
                            data-testid={`tool-grant-approval-${grant.id}`}
                          >
                            {grantRequiresApproval(tool, grant) ? "Freigabe pro Nutzung" : "keine Freigabe nötig"}
                          </span>
                          <button
                            type="button"
                            className="ic-btn"
                            data-variant="danger"
                            data-testid={`tool-grant-revoke-${grant.id}`}
                            disabled={busy}
                            onClick={() => revokeToolGrant(grant.id)}
                          >
                            Entziehen
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="ic-form-row" data-testid={`tool-grant-form-${tool.id}`}>
                    <label className="ic-sr-only" htmlFor={`ic-grant-kind-${tool.id}`}>
                      Geltungsbereich für {tool.key}
                    </label>
                    <select
                      id={`ic-grant-kind-${tool.id}`}
                      className="ic-select"
                      data-testid={`tool-grant-kind-${tool.id}`}
                      value={kind}
                      onChange={(e) => {
                        const next = e.target.value as ToolGrantScope;
                        setGrantScopeKind((prev) => ({ ...prev, [tool.id]: next }));
                        // The previous pick belonged to the previous kind; an
                        // agent id in the project slot would be a grant for
                        // something that does not exist.
                        setGrantScopeId((prev) => ({ ...prev, [tool.id]: "" }));
                        setWaiverToolId(null);
                      }}
                    >
                      {(["agent", "project", "talent"] as const).map((value) => (
                        <option key={value} value={value}>
                          {TOOL_GRANT_SCOPE_LABEL[value]}
                        </option>
                      ))}
                    </select>

                    <label className="ic-sr-only" htmlFor={`ic-grant-target-${tool.id}`}>
                      {TOOL_GRANT_SCOPE_LABEL[kind]} wählen
                    </label>
                    <select
                      id={`ic-grant-target-${tool.id}`}
                      className="ic-select"
                      data-testid={`tool-grant-target-${tool.id}`}
                      value={scopeId}
                      onChange={(e) => setGrantScopeId((prev) => ({ ...prev, [tool.id]: e.target.value }))}
                    >
                      <option value="">— {TOOL_GRANT_SCOPE_LABEL[kind]} wählen —</option>
                      {kind === "agent" &&
                        agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName}
                          </option>
                        ))}
                      {kind === "project" &&
                        projects.map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.title}
                          </option>
                        ))}
                      {kind === "talent" &&
                        talents.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.professional_role}
                          </option>
                        ))}
                    </select>

                    <label className="ic-sr-only" htmlFor={`ic-grant-approval-${tool.id}`}>
                      Freigabepflicht für {tool.key}
                    </label>
                    <select
                      id={`ic-grant-approval-${tool.id}`}
                      className="ic-select"
                      data-testid={`tool-grant-approval-select-${tool.id}`}
                      value={approval}
                      onChange={(e) => {
                        setGrantApproval((prev) => ({
                          ...prev,
                          [tool.id]: e.target.value as "default" | "required" | "none",
                        }));
                        setWaiverToolId(null);
                      }}
                    >
                      {/* "Standard" leaves the column NULL — that is what keeps
                          an external tool gated by omission rather than by
                          someone remembering to say so. */}
                      <option value="default">Freigabe: wie die Risikoklasse</option>
                      <option value="required">Freigabe pro Nutzung</option>
                      <option value="none">keine Freigabe nötig</option>
                    </select>

                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="primary"
                      data-testid={`tool-grant-submit-${tool.id}`}
                      disabled={busy || scopeId === ""}
                      onClick={() => submitGrant(tool)}
                    >
                      Freigeben
                    </button>
                  </div>

                  {/* The one control here that takes a gate away, so it asks
                      first and only the confirmed click sends the flag. */}
                  {waiverToolId === tool.id && (
                    <div className="ic-warn" style={{ width: "100%" }} data-testid={`tool-waiver-${tool.id}`}>
                      <p style={{ margin: "0 0 6px" }}>
                        {tool.key} wirkt nach außen: Was damit geschieht, behandelt jemand draußen als echt. Ohne
                        Freigabepflicht handelt dieser Geltungsbereich künftig ohne Rückfrage — auch dann, wenn dabei
                        Geld ausgegeben oder etwas in deinem Namen abgeschickt wird.
                      </p>
                      <button
                        type="button"
                        className="ic-btn"
                        data-variant="danger"
                        data-testid={`tool-waiver-confirm-${tool.id}`}
                        disabled={busy}
                        onClick={() => submitGrant(tool, true)}
                      >
                        Freigabepflicht bewusst abschalten
                      </button>
                      <button
                        type="button"
                        className="ic-btn"
                        data-testid={`tool-waiver-cancel-${tool.id}`}
                        disabled={busy}
                        onClick={() => setWaiverToolId(null)}
                      >
                        Abbrechen
                      </button>
                    </div>
                  )}

                  {/* A 409 explains why the waiver was refused; no wording of
                      ours would say it better. */}
                  {toolErrors[tool.id] && (
                    <div className="ic-conflict" style={{ width: "100%" }} data-testid={`tool-error-${tool.id}`}>
                      {toolErrors[tool.id]}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Suche
          </h3>
          <p className="ic-note">
            Die Websuche gehört zum selben Register und geht durch dasselbe Gate: Ohne Freigabe für{" "}
            {WEB_SEARCH_TOOL_KEY} sucht hier niemand. Treffer sind Text, den ein Fremder geschrieben hat — sie werden
            als Text angezeigt, nie als Markup ausgeführt.
          </p>
          {searchProviders.length === 0 && <p className="ic-empty">Kein Suchanbieter konfiguriert.</p>}
          <ul className="ic-milestone-list">
            {searchProviders.map((provider) => (
              <li key={provider.kind} data-testid={`search-provider-${provider.kind}`} style={{ flexWrap: "wrap" }}>
                <span className="ic-milestone-title">{provider.kind}</span>
                <span className="ic-tag" data-tone={provider.ok ? "policy" : "gate"}>
                  {provider.ok ? "erreichbar" : "nicht erreichbar"}
                </span>
                {provider.message !== "" && (
                  <span className="ic-note" style={{ width: "100%" }}>
                    {provider.message}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="ic-form-row">
            <label className="ic-sr-only" htmlFor="ic-search-agent">
              Agent für die Probesuche
            </label>
            <select
              id="ic-search-agent"
              className="ic-select"
              data-testid="search-agent"
              value={searchAgentId}
              onChange={(e) => setSearchAgentId(e.target.value)}
            >
              <option value="">— Agent wählen —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-search-query">
              Suchbegriff
            </label>
            <input
              id="ic-search-query"
              data-testid="search-query"
              placeholder="Suchbegriff"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="search-submit"
              disabled={busy || searchAgentId === "" || searchQuery.trim() === ""}
              onClick={runSearch}
            >
              Probesuche
            </button>
          </div>

          {/* 403: the gate said no. Naming the tool is the point — the agent is
              not broken, it simply has no grant for this one. */}
          {searchDenied !== null && (
            <div className="ic-conflict" data-testid="search-denied">
              Dieser Agent darf das nicht: {WEB_SEARCH_TOOL_KEY} ist für ihn nicht freigegeben. {searchDenied}
            </div>
          )}
          {/* 202: nothing was searched. The approval id is what the operator
              looks for in the Freigaben list. */}
          {searchApprovalId !== null && (
            <div className="ic-warn" data-testid="search-approval">
              Wartet auf deine Freigabe — Freigabe-ID {searchApprovalId}. Es wurde noch nichts gesucht.
            </div>
          )}
          {/* 502: the request was fine, the provider on the other end was not. */}
          {searchUnreachable !== null && (
            <div className="ic-conflict" data-testid="search-unreachable">
              Suchanbieter nicht erreichbar: {searchUnreachable}
            </div>
          )}
          {searchFailure !== null && (
            <div className="ic-conflict" data-testid="search-failure">
              {searchFailure}
            </div>
          )}

          {searchHits !== null && (
            <>
              <p className="ic-note" data-testid="search-provider-used">
                Anbieter: {searchHits.provider}
              </p>
              {searchHits.results.length === 0 && <p className="ic-empty">Keine Treffer.</p>}
              <ul className="ic-milestone-list">
                {searchHits.results.map((hit) => (
                  <li
                    key={`${hit.rank}-${hit.url}`}
                    data-testid={`search-result-${hit.rank}`}
                    style={{ flexWrap: "wrap" }}
                  >
                    {/* Title, snippet and URL are attacker-controlled: rendered
                        as children, never through dangerouslySetInnerHTML, and
                        the link gets rel="noopener noreferrer" so the opened
                        page cannot reach back into this window. */}
                    <a
                      className="ic-milestone-title"
                      href={hit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`search-result-title-${hit.rank}`}
                    >
                      {hit.title}
                    </a>
                    <span
                      className="ic-note"
                      style={{ width: "100%" }}
                      data-testid={`search-result-snippet-${hit.rank}`}
                    >
                      {hit.snippet}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </DetailDialog>
      )}

      {showRunQueue && (
        <DetailDialog title="Warteschlange" onClose={() => setShowRunQueue(false)}>
          <p className="ic-note">
            Die Warteschlange hält den Auftrag, eine Aufgabe auszuführen — dauerhaft, auch wenn niemand zusieht und auch
            über einen Neustart hinweg. Ein Hintergrund-Scheduler arbeitet sie ab; „Jetzt abarbeiten“ macht denselben
            Durchlauf von Hand.
          </p>

          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-run-queue-status-filter">
              Status
            </label>
            <select
              id="ic-run-queue-status-filter"
              className="ic-select"
              data-testid="run-queue-status-filter"
              value={runQueueStatusFilter}
              disabled={busy}
              onChange={(e) => filterRunQueue(e.target.value as RunRequestStatus | "")}
            >
              <option value="">Alle</option>
              <option value="queued">{RUN_REQUEST_STATUS_LABEL.queued}</option>
              <option value="running">{RUN_REQUEST_STATUS_LABEL.running}</option>
              <option value="done">{RUN_REQUEST_STATUS_LABEL.done}</option>
              <option value="failed">{RUN_REQUEST_STATUS_LABEL.failed}</option>
              <option value="dead">{RUN_REQUEST_STATUS_LABEL.dead}</option>
              <option value="cancelled">{RUN_REQUEST_STATUS_LABEL.cancelled}</option>
            </select>
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="run-queue-drain"
              disabled={busy}
              onClick={drainRunQueue}
            >
              Jetzt abarbeiten
            </button>
            {drainResult !== null && (
              <span className="ic-tag" data-testid="run-queue-drain-result">
                {drainResult}
              </span>
            )}
          </div>

          {runQueue.length === 0 && <p className="ic-empty">Nichts in der Warteschlange.</p>}
          <ul className="ic-milestone-list">
            {runQueue.map((r) => (
              <li
                key={r.id}
                className="ic-queue-row"
                data-queue-state={r.status}
                data-testid={`run-request-${r.id}`}
                style={{ flexWrap: "wrap" }}
              >
                <span className="ic-milestone-title">{r.task_title || r.task_id}</span>
                <span
                  className="ic-tag"
                  data-tone={r.status === "dead" || r.status === "failed" ? "gate" : "policy"}
                  data-testid={`run-request-status-${r.id}`}
                >
                  {RUN_REQUEST_STATUS_LABEL[r.status]}
                </span>
                <span className="ic-tag" data-testid={`run-request-attempts-${r.id}`}>
                  {r.attempts}/{r.max_attempts} Versuche
                </span>
                <span className="ic-tag">{r.requested_by}</span>

                {/* Cancelling is only meaningful while something can still
                    happen — a finished or dead request has nothing to stop. */}
                {(r.status === "queued" || r.status === "running") && (
                  <button
                    type="button"
                    className="ic-btn"
                    data-variant="danger"
                    data-testid={`run-request-cancel-${r.id}`}
                    disabled={busy}
                    onClick={() => cancelRunRequest(r.id)}
                  >
                    Abbrechen
                  </button>
                )}

                {r.status === "dead" && (
                  <div className="ic-warn" style={{ width: "100%" }} data-testid={`run-request-dead-hint-${r.id}`}>
                    Aufgegeben: alle Versuche sind verbraucht. Diese Anfrage läuft von selbst nicht wieder an — hier
                    muss ein Mensch entscheiden.
                  </div>
                )}
                {(r.status === "failed" || r.status === "dead") && r.last_error !== "" && (
                  <div className="ic-conflict" style={{ width: "100%" }} data-testid={`run-request-error-${r.id}`}>
                    {r.last_error}
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Scheduler
          </h3>
          {scheduler !== null && !scheduler.enabled && (
            <div className="ic-warn" data-testid="scheduler-disabled">
              Hintergrundarbeit ist ausgeschaltet — nichts in dieser Warteschlange wird von selbst abgearbeitet. Setzen
              Sie die Umgebungsvariable IRONCREW_SCHEDULER und starten Sie den Server neu, oder arbeiten Sie hier von
              Hand ab.
            </div>
          )}
          {scheduler !== null && scheduler.jobs.length === 0 && <p className="ic-empty">Kein Job registriert.</p>}
          <ul className="ic-milestone-list">
            {(scheduler?.jobs ?? []).map((job) => (
              <li key={job.name} data-testid={`scheduler-job-${job.name}`} style={{ flexWrap: "wrap" }}>
                <span className="ic-milestone-title">{job.name}</span>
                <span className="ic-tag" data-testid={`scheduler-job-interval-${job.name}`}>
                  alle {formatDurationMs(job.intervalMs)}
                </span>
                <span className="ic-tag" data-testid={`scheduler-job-last-${job.name}`}>
                  {job.lastFinishedAt === null ? "noch nie gelaufen" : `zuletzt ${formatTime(job.lastFinishedAt)}`}
                </span>
                <span
                  className="ic-tag"
                  data-tone={job.failures > 0 ? "gate" : undefined}
                  data-testid={`scheduler-job-failures-${job.name}`}
                >
                  {job.failures} Fehlschläge / {job.runs} Läufe
                </span>
                {job.running && (
                  <span className="ic-tag" data-tone="policy">
                    läuft gerade
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-testid={`scheduler-run-${job.name}`}
                  disabled={busy || job.running}
                  onClick={() => runSchedulerJob(job.name)}
                >
                  Jetzt ausführen
                </button>
                {job.lastError !== "" && (
                  <div
                    className="ic-conflict"
                    style={{ width: "100%" }}
                    data-testid={`scheduler-job-error-${job.name}`}
                  >
                    {job.lastError}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}
    </div>
  );
}

function AttachmentSection({
  title,
  attachments,
  busy,
  onUpload,
  onDelete,
  downloadUrl,
}: {
  title: string;
  attachments: Attachment[];
  busy: boolean;
  onUpload: (file: File) => void;
  onDelete: (id: string) => void;
  downloadUrl: (id: string) => string;
}): React.JSX.Element {
  return (
    <>
      <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
        {title}
      </h3>
      {attachments.length === 0 && <p className="ic-empty">—</p>}
      <ul className="ic-milestone-list">
        {attachments.map((a) => (
          <li key={a.id} data-testid={`attachment-${a.id}`}>
            <a className="ic-milestone-title" href={downloadUrl(a.id)} target="_blank" rel="noreferrer">
              {a.filename}
            </a>
            <span className="ic-tag">{formatBytes(a.size_bytes)}</span>
            <button
              type="button"
              className="ic-btn"
              data-variant="danger"
              disabled={busy}
              onClick={() => onDelete(a.id)}
            >
              Entfernen
            </button>
          </li>
        ))}
      </ul>
      <div className="ic-composer" style={{ padding: 0 }}>
        <label className="ic-sr-only" htmlFor={`ic-upload-${title}`}>
          Datei hochladen für {title}
        </label>
        <input
          id={`ic-upload-${title}`}
          type="file"
          data-testid="attachment-upload-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "accent" | "decision" | "critical";
}): React.JSX.Element {
  return (
    <div className="ic-metric" data-tone={tone}>
      <span className="ic-metric-label">{label}</span>
      <span className="ic-metric-value">{value}</span>
    </div>
  );
}

function DetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ic-detail-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ic-detail">
        <h2>{title}</h2>
        {children}
        <button type="button" className="ic-btn" onClick={onClose}>
          Schliessen
        </button>
      </div>
    </div>
  );
}

export default CommandCenterView;
