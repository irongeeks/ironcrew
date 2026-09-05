import type { SandboxAccessData, SandboxAccessInput } from "./SandboxAccessPanel.tsx";
/**
 * Typed client for the IronCrew REST surface.
 *
 * Built on the shared `src/api/core.ts` transport rather than raw fetch, so it
 * inherits session bootstrap, the `x-csrf-token` header on mutating requests,
 * and the re-auth retry. A hand-rolled fetch here would be silently rejected
 * by the CSRF middleware on every POST — which is exactly what happened before
 * the E2E test caught it.
 */

import { isApiRequestError, request } from "../api/core";
import type {
  Agent,
  CharacterAppearance,
  CharacterAsset,
  AgentTool,
  Approval,
  ApprovalTally,
  AuditShipResult,
  AuditShippingStatus,
  AuditSinkProbe,
  AuthStatus,
  BusinessPackSummary,
  CrewSession,
  CrewUser,
  PackDetail,
  PackKeptObject,
  Attachment,
  ChangeApplyConflict,
  ChangeProposal,
  ChangeProposalFile,
  ChangeProposalStatus,
  Dashboard,
  Decision,
  Department,
  Goal,
  GoalStatus,
  KnownHostsPolicy,
  Mailbox,
  MailboxAccess,
  MailboxAgent,
  MailboxKind,
  MailboxMessageRef,
  MailMessage,
  MailProviderStatus,
  Marketplace,
  MarketplaceEntry,
  MarketplaceEntryType,
  MarketplaceInstall,
  MarketplaceKind,
  MarketplaceKindStatus,
  Meeting,
  MeetingActionItem,
  MeetingParticipant,
  MeetingStatus,
  MeetingTurn,
  MemoryKind,
  MemoryProviderStatus,
  MemoryRef,
  MemorySearchHit,
  Message,
  MessengerChannelStatus,
  MessengerPairing,
  MessengerPollResult,
  Milestone,
  Notification,
  NotificationChannelStatus,
  PairingRole,
  Project,
  ProjectStatus,
  RemoteWorker,
  Run,
  RunEvent,
  RunQueueDrainResult,
  RunRequest,
  RunRequestStatus,
  RuntimeInfo,
  SchedulerJob,
  SchedulerStatus,
  SearchOutcome,
  SearchProviderStatus,
  Secret,
  SecretProviderKind,
  SecretProviderStatus,
  TailscaleInfo,
  Talent,
  Task,
  Tool,
  ToolGrant,
  ToolWithGrants,
  Vessel,
} from "./types.ts";

const BASE = "/api/crew";

function get<T>(path: string): Promise<T> {
  return request<T>(`${BASE}${path}`);
}

function send<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return request<T>(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The human-readable half of an `{ error, message }` failure body.
 *
 * The transport raises an ApiRequestError whose `.message` is the machine
 * code (`vessel_in_use`) — right for logs, useless on screen. A refusal such
 * as a 409 on a vessel delete carries the only text that names *which* agents
 * still use it, so prefer the body's `message` and fall back to the code.
 */
export function serverMessage(err: unknown): string {
  if (isApiRequestError(err)) {
    const details = err.details as { message?: unknown } | null | undefined;
    if (details && typeof details.message === "string" && details.message.trim() !== "") return details.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The machine half of the same failure body.
 *
 * A search can fail in three ways that look identical to a human — the agent
 * may not (403), the provider is unreachable (502), or something else broke —
 * and only the code tells them apart. The message is what gets shown; this is
 * what decides *where*.
 */
export function serverErrorCode(err: unknown): string | null {
  return isApiRequestError(err) ? err.code : null;
}

export const api = {
  sandboxAccess: () => get<SandboxAccessData>("/sandbox-access"),
  requestSandboxAccess: (input: SandboxAccessInput) => send<unknown>("/sandbox-access/request", "POST", input),
  revokeSandboxAccess: (id: string, reason: string) =>
    send<unknown>(`/sandbox-access/${encodeURIComponent(id)}/revoke`, "POST", { reason }),
  characterSkins: () => get<{ skins: Array<{ id: string; name: string; description: string }> }>("/character-skins"),
  setAgentAppearance: (id: string, appearance: CharacterAppearance) =>
    send<{ appearance: CharacterAppearance }>(`/agents/${encodeURIComponent(id)}/appearance`, "PATCH", appearance),
  uploadCharacterAsset: (input: {
    kind: "portrait" | "full_body" | "animation" | "model_3d";
    contentType: string;
    dataBase64: string;
  }) => send<{ asset: CharacterAsset }>("/character-assets", "POST", input),
  characterAssets: () => get<{ assets: CharacterAsset[] }>("/character-assets"),
  deleteCharacterAsset: (id: string, detach = false) =>
    send<{ deleted: boolean; pending: boolean; detachedAgentIds: string[] }>(
      `/character-assets/${encodeURIComponent(id)}`,
      "DELETE",
      { detach },
    ),
  // --- identity ---
  //
  // `authStatus` is the only call the UI may make before anyone is signed in.
  // It answers whether accounts exist at all, so the gate can tell "create the
  // first owner" apart from "log in" — without revealing who those accounts
  // belong to.
  authStatus: () => get<AuthStatus>("/auth/status"),
  login: (email: string, password: string) =>
    send<{ ok: boolean; user: CrewUser }>("/auth/login", "POST", { email, password }),
  logout: () => send<{ ok: boolean }>("/auth/logout", "POST"),
  ownSessions: () => get<{ sessions: CrewSession[] }>("/auth/sessions"),
  revokeOwnSession: (id: string) => send<{ ok: boolean }>(`/auth/sessions/${id}`, "DELETE"),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    send<{ ok: boolean; revokedSessions: number }>("/auth/password", "POST", { currentPassword, newPassword }),

  users: () => get<{ users: CrewUser[] }>("/users"),
  createUser: (input: { email: string; password: string; displayName?: string; role?: CrewUser["role"] }) =>
    send<{ ok: boolean; user: CrewUser }>("/users", "POST", input),
  updateUser: (id: string, patch: { displayName?: string; role?: CrewUser["role"]; status?: CrewUser["status"] }) =>
    send<{ ok: boolean; user: CrewUser }>(`/users/${id}`, "PATCH", patch),
  setUserPassword: (id: string, newPassword: string) =>
    send<{ ok: boolean }>(`/users/${id}/password`, "POST", { newPassword }),
  deleteUser: (id: string) => send<{ ok: boolean }>(`/users/${id}`, "DELETE"),

  // --- business packs ---
  packs: () => get<{ packs: BusinessPackSummary[] }>("/packs"),
  pack: (key: string) => get<PackDetail>(`/packs/${key}`),
  installPack: (key: string) =>
    send<{ ok: boolean; created: Record<string, number>; reused: Record<string, number> }>(
      `/packs/${key}/install`,
      "POST",
    ),
  uninstallPack: (key: string) =>
    send<{ ok: boolean; removed: Record<string, number>; disabledTools: number; kept: PackKeptObject[] }>(
      `/packs/${key}/uninstall`,
      "POST",
    ),
  testPackIntegration: (packKey: string, integrationKey: string) =>
    send<{ ok: boolean; message: string; version?: string }>(
      `/packs/${packKey}/integrations/${integrationKey}/test`,
      "POST",
    ),

  company: () => get<{ company: { name: string }; departments: Department[] }>("/company"),
  agents: () => get<{ agents: Agent[] }>("/agents"),
  chat: () => get<{ conversationId: string; messages: Message[] }>("/chat"),
  sendMessage: (body: string, projectId?: string) =>
    send<{ reply: string; task: Task | null; assignedAgent: Agent | null }>("/chat", "POST", {
      body,
      ...(projectId ? { projectId } : {}),
    }),
  tasks: () => get<{ tasks: Task[] }>("/tasks"),
  task: (id: string) =>
    get<{ task: Task; runs: Run[]; audit: unknown[]; blockers: Task[]; blocking: Task[] }>(`/tasks/${id}`),
  executeNext: () => send<{ executed: boolean; task?: Task; runId?: string }>("/tasks/execute-next", "POST"),
  accept: (id: string, note?: string) => send<{ task: Task }>(`/tasks/${id}/accept`, "POST", { note }),
  revise: (id: string, reason: string) => send<{ task: Task }>(`/tasks/${id}/revise`, "POST", { reason }),
  setTaskStatus: (id: string, status: Task["status"], reason?: string) =>
    send<{ task: Task }>(`/tasks/${id}/status`, "POST", { status, reason }),
  addDependency: (taskId: string, dependsOnId: string) =>
    send<{ blockers: Task[] }>(`/tasks/${taskId}/dependencies`, "POST", { dependsOnId }),
  removeDependency: (taskId: string, dependsOnId: string) =>
    send<{ blockers: Task[] }>(`/tasks/${taskId}/dependencies/${dependsOnId}`, "DELETE"),
  approvals: () => get<{ approvals: Approval[] }>("/approvals"),
  // The server answers 202 when the vote was recorded but the quorum is not
  // yet met, and 200 when it settled the approval. `send` treats both as
  // success, so the caller reads `approval.status` (or the tally) to know
  // which happened rather than the status code.
  decide: (id: string, decision: "approved" | "rejected", reason?: string) =>
    send<{ approval: Approval; tally: ApprovalTally }>(`/approvals/${id}/decide`, "POST", { decision, reason }),
  setQuorum: (id: string, required: number) =>
    send<{ tally: ApprovalTally }>(`/approvals/${id}/quorum`, "POST", { required }),
  dashboard: () => get<Dashboard>("/dashboard"),
  runEvents: (runId: string) => get<{ events: RunEvent[] }>(`/runs/${runId}/events`),
  runtimes: () => get<{ runtimes: RuntimeInfo[] }>("/runtimes"),
  setAgentRuntime: (agentId: string, runtimeProvider: string) =>
    send<{ agent: Agent }>(`/agents/${agentId}/runtime`, "PATCH", { runtimeProvider }),

  goals: () => get<{ goals: Goal[] }>("/goals"),
  goal: (id: string) => get<{ goal: Goal; ancestry: Goal[]; children: Goal[] }>(`/goals/${id}`),
  createGoal: (input: { title: string; description?: string; parentId?: string | null }) =>
    send<{ goal: Goal }>("/goals", "POST", input),
  setGoalStatus: (id: string, status: GoalStatus) => send<{ goal: Goal }>(`/goals/${id}/status`, "POST", { status }),

  projects: () => get<{ projects: Project[] }>("/projects"),
  project: (id: string) => get<{ project: Project; milestones: Milestone[]; tasks: Task[] }>(`/projects/${id}`),
  createProject: (input: { title: string; key?: string; summary?: string; goalId?: string | null }) =>
    send<{ project: Project }>("/projects", "POST", input),
  setProjectStatus: (id: string, status: ProjectStatus) =>
    send<{ project: Project }>(`/projects/${id}/status`, "POST", { status }),
  addMilestone: (projectId: string, input: { title: string; description?: string; dueAt?: number | null }) =>
    send<{ milestone: Milestone }>(`/projects/${projectId}/milestones`, "POST", input),
  setMilestoneStatus: (id: string, status: Milestone["status"]) =>
    send<{ milestone: Milestone }>(`/milestones/${id}/status`, "POST", { status }),

  notifications: (unreadOnly = false) =>
    get<{ notifications: Notification[]; unreadCount: number }>(`/notifications${unreadOnly ? "?unread=true" : ""}`),
  markNotificationRead: (id: string) => send<{ notification: Notification }>(`/notifications/${id}/read`, "POST"),
  decisions: () => get<{ decisions: Decision[] }>("/decisions"),

  secretProviders: () => get<{ providers: SecretProviderStatus[] }>("/secret-providers"),
  secrets: () => get<{ secrets: Secret[] }>("/secrets"),
  createSecret: (input: {
    name: string;
    provider: SecretProviderKind;
    itemRef: string;
    field?: string;
    description?: string;
  }) => send<{ secret: Secret }>("/secrets", "POST", input),
  deleteSecret: (id: string) => send<{ ok: boolean }>(`/secrets/${id}`, "DELETE"),
  testSecret: (id: string) => send<{ ok: boolean; length?: number; message?: string }>(`/secrets/${id}/test`, "POST"),

  attachmentsForTask: (taskId: string) => get<{ attachments: Attachment[] }>(`/attachments?taskId=${taskId}`),
  attachmentsForProject: (projectId: string) =>
    get<{ attachments: Attachment[] }>(`/attachments?projectId=${projectId}`),
  attachmentsGeneral: () => get<{ attachments: Attachment[] }>("/attachments"),
  uploadAttachment: (input: {
    filename: string;
    contentType?: string;
    dataBase64: string;
    taskId?: string;
    projectId?: string;
  }) => send<{ attachment: Attachment }>("/attachments", "POST", input),
  deleteAttachment: (id: string) => send<{ ok: boolean }>(`/attachments/${id}`, "DELETE"),
  attachmentDownloadUrl: (id: string) => `${BASE}/attachments/${id}/download`,

  tailscale: () => get<TailscaleInfo>("/tailscale"),
  remoteWorkers: () => get<{ remoteWorkers: RemoteWorker[] }>("/remote-workers"),
  createRemoteWorker: (input: {
    label: string;
    environment?: string;
    host: string;
    port?: number;
    sshUser: string;
    privateKeyPath: string;
    knownHostsPolicy?: KnownHostsPolicy;
    notes?: string;
  }) => send<{ remoteWorker: RemoteWorker }>("/remote-workers", "POST", input),
  deleteRemoteWorker: (id: string) => send<{ ok: boolean }>(`/remote-workers/${id}`, "DELETE"),
  testRemoteWorker: (id: string) => send<{ ok: boolean; message: string }>(`/remote-workers/${id}/test`, "POST"),

  meetings: (status?: MeetingStatus) => get<{ meetings: Meeting[] }>(`/meetings${status ? `?status=${status}` : ""}`),
  meeting: (id: string) =>
    get<{
      meeting: Meeting;
      participants: MeetingParticipant[];
      turns: MeetingTurn[];
      actionItems: MeetingActionItem[];
    }>(`/meetings/${id}`),
  createMeeting: (input: {
    topic: string;
    moderatorAgentId: string;
    participantAgentIds: string[];
    projectId?: string | null;
    maxRounds?: number;
    budgetMicros?: number;
  }) => send<{ meeting: Meeting }>("/meetings", "POST", input),
  startMeeting: (id: string) => send<{ meeting: Meeting }>(`/meetings/${id}/start`, "POST"),
  nextMeetingTurn: (id: string, agentId?: string) =>
    send<{ meeting: Meeting; turn: MeetingTurn | null }>(`/meetings/${id}/next-turn`, "POST", { agentId }),
  endMeeting: (id: string, minutes?: string) => send<{ meeting: Meeting }>(`/meetings/${id}/end`, "POST", { minutes }),
  cancelMeeting: (id: string) => send<{ meeting: Meeting }>(`/meetings/${id}/cancel`, "POST"),
  addMeetingActionItem: (id: string, input: { description: string; assignedAgentId?: string | null }) =>
    send<{ actionItem: MeetingActionItem }>(`/meetings/${id}/action-items`, "POST", input),
  convertActionItemToTask: (actionItemId: string) =>
    send<{ task: Task }>(`/meetings/action-items/${actionItemId}/convert`, "POST"),

  memoryProviders: () => get<{ providers: MemoryProviderStatus[] }>("/memory-providers"),
  memories: () => get<{ memories: MemoryRef[] }>("/memory"),
  recordMemory: (input: {
    provider: string;
    kind: MemoryKind;
    title: string;
    content: string;
    tags?: string[];
    taskId?: string | null;
    projectId?: string | null;
    agentId?: string | null;
    source?: string;
    confidence?: number;
    sensitivity?: string;
  }) => send<{ memory: MemoryRef }>("/memory", "POST", input),
  memoryContent: (id: string) => get<{ memory: MemoryRef; content: string }>(`/memory/${id}`),
  deleteMemory: (id: string) => send<{ ok: boolean }>(`/memory/${id}`, "DELETE"),
  syncMemory: () => send<{ ok: boolean }>("/memory/sync", "POST"),
  searchMemory: (provider: string, query: string, semantic = false) =>
    get<{ hits: MemorySearchHit[] }>(
      `/memory/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}${semantic ? "&semantic=1" : ""}`,
    ),

  mailProviders: () => get<{ providers: MailProviderStatus[] }>("/mail-providers"),
  mailboxes: () => get<{ mailboxes: Mailbox[] }>("/mailboxes"),
  mailbox: (id: string) =>
    get<{ mailbox: Mailbox; agents: MailboxAgent[]; messages: MailboxMessageRef[] }>(`/mailboxes/${id}`),
  createMailbox: (input: {
    label: string;
    kind: MailboxKind;
    emailAddress: string;
    host?: string;
    port?: number;
    useTls?: boolean;
    username?: string;
    smtpHost?: string;
    smtpPort?: number;
    sessionUrl?: string;
    tenantId?: string;
    clientId?: string;
    credentials?: { password?: string; bearerToken?: string; clientSecret?: string; refreshToken?: string };
    pollEnabled?: boolean;
    pollIntervalSeconds?: number;
    autoTriage?: boolean;
  }) => send<{ mailbox: Mailbox }>("/mailboxes", "POST", input),
  updateMailbox: (
    id: string,
    patch: {
      label?: string;
      pollEnabled?: boolean;
      pollIntervalSeconds?: number;
      autoTriage?: boolean;
      credentials?: { password?: string; bearerToken?: string; clientSecret?: string; refreshToken?: string };
    },
  ) => send<{ mailbox: Mailbox }>(`/mailboxes/${id}`, "PATCH", patch),
  deleteMailbox: (id: string) => send<{ ok: boolean }>(`/mailboxes/${id}`, "DELETE"),
  testMailbox: (id: string) => send<{ ok: boolean; message: string }>(`/mailboxes/${id}/test`, "POST"),
  grantMailboxAgent: (id: string, agentId: string, access: MailboxAccess) =>
    send<{ agents: MailboxAgent[] }>(`/mailboxes/${id}/agents`, "POST", { agentId, access }),
  revokeMailboxAgent: (id: string, agentId: string) =>
    send<{ agents: MailboxAgent[] }>(`/mailboxes/${id}/agents/${agentId}`, "DELETE"),
  mailboxMessages: (id: string) => get<{ messages: MailMessage[] }>(`/mailboxes/${id}/messages`),
  pollMailbox: (id: string) =>
    send<{ mailbox: Mailbox; seen: number; newMessages: number; tasksCreated: number }>(
      `/mailboxes/${id}/poll`,
      "POST",
    ),

  notificationChannels: () => get<{ channels: NotificationChannelStatus[] }>("/notification-channels"),
  testNotificationChannel: (kind: string) =>
    send<{ ok: boolean; message: string }>(`/notification-channels/${kind}/test`, "POST"),
  sendTestNotification: (kind: string) =>
    send<{ ok: boolean; message: string }>(`/notification-channels/${kind}/send-test`, "POST"),

  marketplaceKinds: () => get<{ kinds: MarketplaceKindStatus[] }>("/marketplace-kinds"),
  marketplaces: () => get<{ marketplaces: Marketplace[]; installs: MarketplaceInstall[] }>("/marketplaces"),
  createMarketplace: (input: { name: string; kind: MarketplaceKind; url: string; enabled?: boolean }) =>
    send<{ marketplace: Marketplace }>("/marketplaces", "POST", input),
  updateMarketplace: (id: string, patch: { name?: string; url?: string; enabled?: boolean }) =>
    send<{ marketplace: Marketplace }>(`/marketplaces/${id}`, "PATCH", patch),
  deleteMarketplace: (id: string) => send<{ ok: true }>(`/marketplaces/${id}`, "DELETE"),
  marketplaceEntries: (id: string) =>
    get<{ entries: MarketplaceEntry[]; marketplace: Marketplace }>(`/marketplaces/${id}/entries`),
  installFromMarketplace: (
    id: string,
    input: { entryId: string; env?: Record<string, string>; headers?: Record<string, string>; name?: string },
  ) =>
    send<{ install: MarketplaceInstall; result: { entryType: string; name: string; location: string } }>(
      `/marketplaces/${id}/install`,
      "POST",
      input,
    ),
  uninstallFromMarketplace: (entryType: MarketplaceEntryType, name: string) =>
    send<{ ok: true }>(`/marketplace-installs/${entryType}/${encodeURIComponent(name)}`, "DELETE"),

  messengerChannels: () => get<{ channels: MessengerChannelStatus[] }>("/messenger-channels"),
  // A poll consumes the channel cursor, so it is an explicit action and never
  // something the dialog does on open.
  pollMessengerChannel: (kind: string) =>
    send<MessengerPollResult>(`/messenger-channels/${encodeURIComponent(kind)}/poll`, "POST"),
  messengerPairings: () => get<{ pairings: MessengerPairing[] }>("/messenger-pairings"),
  acceptMessengerPairing: (id: string, role: PairingRole) =>
    send<{ pairing: MessengerPairing }>(`/messenger-pairings/${id}/accept`, "POST", { role }),
  blockMessengerPairing: (id: string) => send<{ pairing: MessengerPairing }>(`/messenger-pairings/${id}/block`, "POST"),
  revokeMessengerPairing: (id: string) =>
    send<{ pairing: MessengerPairing }>(`/messenger-pairings/${id}/revoke`, "POST"),
  unblockMessengerPairing: (id: string) =>
    send<{ pairing: MessengerPairing }>(`/messenger-pairings/${id}/unblock`, "POST"),

  changeProposals: (status?: ChangeProposalStatus) =>
    get<{ proposals: ChangeProposal[] }>(`/change-proposals${status ? `?status=${status}` : ""}`),
  changeProposal: (id: string) =>
    get<{ proposal: ChangeProposal; files: ChangeProposalFile[] }>(`/change-proposals/${id}`),
  decideChangeProposal: (id: string, decision: "approved" | "rejected", reason?: string) =>
    send<{ proposal: ChangeProposal }>(`/change-proposals/${id}/decision`, "POST", { decision, reason }),
  // Nothing reaches the disk until this call, and it is all-or-nothing: a
  // single conflict leaves the workspace exactly as it was.
  applyChangeProposal: (id: string) =>
    send<{ proposal: ChangeProposal; applied: string[]; conflicts: ChangeApplyConflict[] }>(
      `/change-proposals/${id}/apply`,
      "POST",
    ),

  // --- vessels & talents ---------------------------------------------------
  // A vessel is the execution container (runtime, model, run limits); a talent
  // is the capability package (role, seniority, policy, persona, skills). They
  // are separate resources on purpose, so the same talent can run elsewhere.
  vessels: () => get<{ vessels: Vessel[] }>("/vessels"),
  createVessel: (input: {
    key: string;
    label?: string;
    runtimeProvider: string;
    model?: string;
    timeoutMs?: number;
    maxRetries?: number;
    maxConcurrency?: number;
  }) => send<{ vessel: Vessel }>("/vessels", "POST", input),
  updateVessel: (
    id: string,
    patch: {
      label?: string;
      runtimeProvider?: string;
      model?: string;
      timeoutMs?: number;
      maxRetries?: number;
      maxConcurrency?: number;
    },
  ) => send<{ vessel: Vessel }>(`/vessels/${id}`, "PATCH", patch),
  // Refused with 409 while agents still use it — the body's `message` names
  // them, which is why callers unwrap it with serverMessage().
  deleteVessel: (id: string) => send<{ ok: true }>(`/vessels/${id}`, "DELETE"),

  talents: () => get<{ talents: Talent[] }>("/talents"),
  // The server owns the vocabulary of seniorities, so the dropdown asks for it
  // rather than hardcoding a list that would drift.
  talentSeniorities: () => get<{ seniorities: string[] }>("/talents/seniorities"),
  createTalent: (input: {
    key: string;
    professionalRole: string;
    roleSummary?: string;
    seniority?: string;
    policy?: unknown;
    persona?: unknown;
    skills?: unknown;
  }) => send<{ talent: Talent }>("/talents", "POST", input),
  updateTalent: (id: string, patch: { professionalRole?: string; roleSummary?: string; seniority?: string }) =>
    send<{ talent: Talent }>(`/talents/${id}`, "PATCH", patch),
  deleteTalent: (id: string) => send<{ ok: true }>(`/talents/${id}`, "DELETE"),

  // Omitting a field leaves that half of the pairing untouched, so an owner
  // can swap the vessel without restating the talent.
  setAgentPairing: (agentId: string, body: { vesselId?: string; talentId?: string }) =>
    send<{ agent: Agent }>(`/agents/${agentId}/pairing`, "POST", body),

  // --- tools: the register, and who may use what ---------------------------
  // Listing a tool is not granting it. `/tools` is the register of what this
  // server can perform; the grants hanging off each row are the only thing
  // that lets an agent reach for it.
  tools: () => get<{ tools: ToolWithGrants[] }>("/tools"),
  // Asked per project because a project grant is contextual: the same agent
  // holds the customer's MCP tools inside the customer's project and nowhere
  // else.
  agentTools: (agentId: string, projectId?: string) =>
    get<{ tools: AgentTool[] }>(
      `/agents/${agentId}/tools${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  // `allowUnapprovedExternal` is the deliberate second sentence: waiving the
  // approval on an external tool is refused with 409 without it, and the
  // refusal's message is the one worth reading.
  grantTool: (
    toolId: string,
    body: {
      agentId?: string;
      talentId?: string;
      projectId?: string;
      requiresApproval?: boolean | null;
      allowUnapprovedExternal?: boolean;
    },
  ) => send<{ grant: ToolGrant }>(`/tools/${toolId}/grants`, "POST", body),
  revokeToolGrant: (id: string) => send<{ ok: true }>(`/tool-grants/${id}`, "DELETE"),
  setToolEnabled: (id: string, enabled: boolean) => send<{ tool: Tool }>(`/tools/${id}/enabled`, "POST", { enabled }),

  searchProviders: () => get<{ providers: SearchProviderStatus[] }>("/search-providers"),
  // Takes an agent id and goes through the same gate as any other tool use —
  // the API is not a way around a grant that was never given. A 202 is a
  // success on the wire and a refusal in effect: an approval is now waiting.
  search: (input: {
    agentId: string;
    query: string;
    limit?: number;
    language?: string;
    safeSearch?: "off" | "moderate" | "strict";
    kind?: string;
    projectId?: string;
    taskId?: string;
  }) => send<SearchOutcome>("/search", "POST", input),

  // --- run queue & scheduler -----------------------------------------------
  runQueue: (status?: RunRequestStatus) =>
    get<{ requests: RunRequest[] }>(`/run-queue${status ? `?status=${status}` : ""}`),
  cancelRunRequest: (id: string) => send<{ request: RunRequest }>(`/run-queue/${id}/cancel`, "POST"),
  // Draining by hand is the same work the background scheduler does, which is
  // why it is worth having when the scheduler is switched off.
  drainRunQueue: (limit?: number) => send<RunQueueDrainResult>("/run-queue/drain", "POST", { limit }),
  scheduler: () => get<SchedulerStatus>("/scheduler"),
  runSchedulerJob: (name: string) => send<{ job: SchedulerJob }>(`/scheduler/${encodeURIComponent(name)}/run`, "POST"),

  // --- audit shipping: the copy that leaves the machine ---------------------
  //
  // The status is readable by anyone signed in — how far behind the archive is
  // is not a secret — while the probe and the drain are owner-only and answer
  // 403 to everyone else. `testAuditShipping` resolves with `ok: false` when
  // the collector is unreachable: that is a status, not a failed request, and
  // only a 409 (no sink configured) or a 403 rejects here.
  auditShipping: () => get<AuditShippingStatus>("/audit/shipping"),
  testAuditShipping: () => send<AuditSinkProbe>("/audit/shipping/test", "POST"),
  runAuditShipping: () => send<AuditShipResult>("/audit/shipping/run", "POST"),
};
