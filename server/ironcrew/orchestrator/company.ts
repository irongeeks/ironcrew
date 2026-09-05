import { CompanyConfigurationStore, CompanyConfigurationError } from "../policy/company-configuration-store.ts";
import { CareerReviewStore } from "../domain/career-review-store.ts";
import { CareerWorkflow } from "./career-workflow.ts";
import { RoutingStore, RoutingError } from "../domain/routing-store.ts";
import { selectProfileRoute, type RouteSelection } from "../runtime/profile-router.ts";
/**
 * IronCrew — company orchestrator.
 *
 * The vertical slice lives here:
 *
 *   CEO -> EA triage -> task -> delegation -> run -> review -> CEO summary
 *
 * Everything is persisted as it happens, so a restart mid-flow loses nothing;
 * the reconstruction path is exercised by the "survives a restart" test.
 */

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { newCorrelationId, newId } from "../domain/ids.ts";
import type { IntegrationStatus, PackIntegrationAdapter } from "../packs/pack-integration.ts";
import { PackInstaller } from "../packs/pack-installer.ts";
import { TaskStore, type TaskRow } from "../domain/task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { appendAuditEvent, type ActorType } from "../domain/audit.ts";
import { canTransition, deriveAgentStatus, type TaskStatus } from "../domain/task-state.ts";
import { CompanyPolicyStore } from "../policy/company-policy-store.ts";
import { evaluateRuntimeModel } from "../policy/vendor-policy.ts";
import type { CompanyPolicyRestrictions } from "../../../src/shared/company-policy.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import type { AuditShipper } from "../audit/audit-shipper.ts";
import {
  ApprovalReviewStore,
  type ApprovalReviewRow,
  type ApprovalTally,
  type ReviewVerdict,
} from "../domain/approval-review-store.ts";
import { BudgetEngine } from "../policy/budget-engine.ts";
import { SandboxGrantStore } from "../domain/sandbox-grant-store.ts";
import { GoalStore } from "../domain/goal-store.ts";
import { ProjectPlanStore } from "../domain/project-plan-store.ts";
import { projectPlanningInstructions } from "../../../src/shared/project-planning.ts";
import { CoachingStore } from "../domain/coaching-store.ts";
import { SandboxAccessService } from "../domain/sandbox-access-service.ts";
import { ProjectStore } from "../domain/project-store.ts";
import { NotificationStore } from "../domain/notification-store.ts";
import { DecisionStore } from "../domain/decision-store.ts";
import { SecretStore } from "../domain/secret-store.ts";
import { AttachmentStore, type AttachmentRow } from "../domain/attachment-store.ts";
import { AttachmentStorage } from "../domain/attachment-storage.ts";
import type { ApprovalRow } from "../policy/approval-policy.ts";
import { SecretResolutionError, type SecretProvider } from "../secrets/secret-provider.ts";
import type { SecretProviderKind } from "../secrets/secret-ref.ts";
import { RemoteWorkerStore } from "../domain/remote-worker-store.ts";
import {
  TailscaleProvider,
  type TailscaleConnectionStatus,
  type TailscaleStatus,
} from "../network/tailscale-provider.ts";
import { createSshConnector, type SshConnectorInterface } from "../../modules/workflow/ssh/ssh-connector.ts";
import type { SshConfig } from "../../modules/workflow/ssh/types.ts";
import { MeetingStore, MeetingMutationError, type MeetingRow, type MeetingTurnRow } from "../domain/meeting-store.ts";
import { MemoryStore, MemoryMutationError, type MemoryRefRow } from "../domain/memory-store.ts";
import type { MemoryKind, MemoryProvider, MemorySearchHit } from "../memory/memory-provider.ts";
import { HybridMemoryProvider } from "../memory/hybrid-provider.ts";
import { readCurrentProvenance, mayRetrieveMemory } from "../memory/current-provenance.ts";
import { createCompanyToolExecutor, COMPANY_RUNTIME_TOOLS } from "../runtime/company-tool-executor.ts";
import {
  canonicalToolArguments,
  isToolApprovalBinding,
  toolApprovalBinding,
} from "../runtime/tool-approval-binding.ts";
import { redactText } from "../security/redaction.ts";
import type { ChannelSeverity, NotificationChannel } from "../notify/notification-channel.ts";
import {
  MailboxStore,
  MailboxAccessError,
  MailboxMutationError,
  type MailboxAccess,
  type MailboxKind,
  type MailboxRow,
} from "../domain/mailbox-store.ts";
import type {
  MailboxContext,
  MailMessageBody,
  MailMessageSummary,
  MailProvider,
  OutgoingMail,
} from "../mail/mail-provider.ts";
import { sanitiseLine, wrapUntrusted } from "../policy/untrusted-content.ts";
import { RESOLVED_AGENT_SELECT, type ResolvedAgentRow } from "../domain/agent-resolution.ts";
import { AgentLockStore } from "../domain/agent-lock-store.ts";
import { ExternalEventStore } from "../domain/external-event-store.ts";
import { MessengerPairingStore, type PairingRole } from "../domain/messenger-pairing-store.ts";
import { VesselStore, VesselMutationError } from "../domain/vessel-store.ts";
import { TalentStore, TalentMutationError } from "../domain/talent-store.ts";
import { RunRequestStore, type RunRequestRow } from "../domain/run-request-store.ts";
import { ToolStore, type ToolDecision } from "../domain/tool-store.ts";
import { RoutineStore, type RoutineRow } from "../domain/routine-store.ts";
import {
  wrapSearchResults,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from "../search/search-provider.ts";
import type { InboundMessage, MessengerChannel } from "../notify/messenger-channel.ts";
import {
  ChangeProposalStore,
  ChangeProposalError,
  type ApplyResult,
  type ChangeProposalRow,
  type ProposedFile,
} from "../domain/change-proposal-store.ts";
import {
  MarketplaceStore,
  MarketplaceMutationError,
  type MarketplaceInstallRow,
  type MarketplaceRow,
} from "../domain/marketplace-store.ts";
import {
  MarketplaceSourceError,
  type MarketplaceEntry,
  type MarketplaceKind,
  type MarketplaceSource,
} from "../marketplace/marketplace-source.ts";
import type { MarketplaceInstaller, InstallOptions, InstallResult } from "../marketplace/marketplace-installer.ts";
import { resolvePermissionMode } from "../policy/runtime-permissions.ts";
import { mayDelegateAutonomously, normaliseGerman, triage, type TriageResult } from "./triage.ts";
import {
  buildAgentGuidance,
  loadCrewConfig,
  loadDepartmentConfig,
  type CrewConfig,
  type DepartmentConfig,
  type SeedAgent,
} from "../domain/crew-config.ts";
import type { AgentRuntime, RunEvent, RunInput, RunContext } from "../runtime/run-events.ts";

/**
 * An agent as every consumer here needs it: the row plus its talent and vessel
 * followed (see domain/agent-resolution.ts). The name and the field meanings
 * are unchanged from before the Vessel × Talent split — only the storage moved.
 */
export type AgentRow = ResolvedAgentRow;

/**
 * How long a run may go unheard from before it stops counting against its
 * vessel's concurrency.
 *
 * A run row says `running` until something writes otherwise, and a process
 * killed mid-run writes nothing. Without this, one crash would permanently
 * consume a slot on a vessel whose whole purpose is to cap how many runs
 * happen at once — the concurrency limit would ratchet down to zero over
 * time and no error would ever say why.
 *
 * Every persisted event calls `runs.heartbeat()`, so a live run refreshes
 * this constantly; five minutes of total silence is well past anything a
 * working run produces.
 */
const VESSEL_RUN_STALE_MS = 5 * 60_000;

/** Fallback when a vessel is missing, so a run is never unbounded in time. */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** What a caller may say about how a run is executed. */
export interface ExecuteOptions {
  runtimeType?: string;
  workspacePath?: string;
  onEvent?: (e: RunEvent) => void;
}

export interface CeoMessageResult {
  conversationId: string;
  messageId: string;
  triage: TriageResult;
  /** Task created for this message, when one was warranted. */
  task: TaskRow | null;
  /** Agent the task was delegated to, when delegation happened. */
  assignedAgent: AgentRow | null;
  /** The EA's reply to the CEO. */
  reply: string;
  correlationId: string;
}

/**
 * Which human asked for this.
 *
 * Every API-reachable action takes one, and it is optional with a documented
 * default rather than required: an installation with no user accounts has no
 * name to give (docs/IDENTITY.md), and the scheduler, the messenger owner
 * path and the routines call these same methods with no person behind them.
 * "ceo" is the honest answer in exactly those cases — a single fictional
 * actor, but one that only appears where there genuinely is nobody.
 */
export interface HumanActor {
  /** A `usr_…` id from a resolved session, when one exists. */
  actorId?: string;
}

/**
 * What came of one human's verdict: the vote itself, where the tally now
 * stands, the approval as it looks afterwards, and whether that verdict was
 * the one that settled it.
 *
 * `decided: false` with a non-null approval is the normal "one of two, one
 * still needed" case — not an error, and the caller must say so rather than
 * reporting a failure.
 */
/**
 * What came of a verdict on a file-change proposal.
 *
 * `decided: false` means the vote was recorded and the quorum is not yet met:
 * the proposal is still pending and nothing has been written. A caller that
 * reported that as success would tell an owner a deploy script is approved
 * while it waits for a second human.
 */
export interface ChangeProposalDecision {
  proposal: ChangeProposalRow;
  /** Null when the proposal carries no approval — nothing to count. */
  tally: ApprovalTally | null;
  decided: boolean;
}

export interface ApprovalReviewOutcome {
  review: ApprovalReviewRow;
  tally: ApprovalTally;
  approval: ApprovalRow;
  decided: boolean;
}

export function humanActor(opts: HumanActor): string {
  return opts.actorId ?? "ceo";
}

export class CompanyOrchestrator {
  readonly tasks: TaskStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalEngine;
  readonly approvalReviews: ApprovalReviewStore;
  readonly budgets: BudgetEngine;
  readonly sandboxGrants: SandboxGrantStore;
  readonly goals: GoalStore;
  readonly projects: ProjectStore;
  readonly projectPlans: ProjectPlanStore;
  readonly coaching: CoachingStore;
  readonly routing: RoutingStore;
  readonly career: CareerReviewStore;
  private readonly careerWorkflow: CareerWorkflow;
  readonly sandboxAccess: SandboxAccessService;
  private readonly activeRuns = new Map<
    string,
    { companyId: string; taskId: string; abort: AbortController; runtime: AgentRuntime }
  >();
  readonly notifications: NotificationStore;
  readonly decisions: DecisionStore;
  readonly secrets: SecretStore;
  readonly attachments: AttachmentStore;
  readonly remoteWorkers: RemoteWorkerStore;
  readonly meetings: MeetingStore;
  readonly memories: MemoryStore;
  readonly mailboxes: MailboxStore;
  readonly marketplaces: MarketplaceStore;
  readonly agentLocks: AgentLockStore;
  readonly externalEvents: ExternalEventStore;
  readonly changeProposals: ChangeProposalStore;
  readonly messengerPairings: MessengerPairingStore;
  readonly vessels: VesselStore;
  readonly talents: TalentStore;
  readonly runRequests: RunRequestStore;
  readonly tools: ToolStore;
  readonly routines: RoutineStore;
  readonly companyPolicies: CompanyPolicyStore;
  readonly configuration: CompanyConfigurationStore;
  private readonly messengerChannels = new Map<string, MessengerChannel>();
  private readonly searchProviders = new Map<string, SearchProvider>();
  /** Business-pack integrations, keyed by the pack definition's integration key. */
  private readonly packIntegrations = new Map<string, PackIntegrationAdapter>();
  private packInstaller?: PackInstaller;
  /**
   * Where the audit chain is copied to, when an operator configured one.
   *
   * Optional in exactly the way the pack integrations are optional: absent
   * means "nobody configured a sink", and the API reports that rather than
   * showing a switch with nothing behind it. Registered by the composition
   * root, never constructed here — this class must not decide where a
   * company's audit log is allowed to go.
   */
  private auditShipperInstance: AuditShipper | null = null;
  private readonly secretProviders = new Map<SecretProviderKind, SecretProvider>();
  private readonly memoryProviders = new Map<string, MemoryProvider>();
  private readonly notificationChannels = new Map<string, NotificationChannel>();
  private readonly mailProviders = new Map<MailboxKind, MailProvider>();
  private readonly marketplaceSources = new Map<MarketplaceKind, MarketplaceSource>();
  private marketplaceInstallerInstance: MarketplaceInstaller | null = null;
  private attachmentStorageInstance: AttachmentStorage | null = null;
  private tailscaleProviderInstance: TailscaleProvider | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtimes: Map<string, AgentRuntime> = new Map(),
    // Not opened until first actually used (see the `attachmentStorage`
    // getter) — so every existing orchestrator test that never touches
    // attachments never creates this directory, and each attachment test
    // that does can still override it with an isolated temp dir.
    private readonly attachmentStorageRoot: string = path.resolve(process.cwd(), "data", "crew-attachments"),
    // Injectable so tests never spawn a real `ssh` process — see
    // testRemoteWorker() below.
    private readonly sshConnectorFactory: (config: SshConfig) => SshConnectorInterface = createSshConnector,
  ) {
    this.configuration = new CompanyConfigurationStore(db);
    this.tasks = new TaskStore(db);
    this.runs = new RunStore(db);
    this.approvals = new ApprovalEngine(db);
    this.approvalReviews = new ApprovalReviewStore(db);
    this.sandboxGrants = new SandboxGrantStore(db);
    this.budgets = new BudgetEngine(db);
    this.goals = new GoalStore(db);
    this.projects = new ProjectStore(db);
    this.projectPlans = new ProjectPlanStore(db);
    this.coaching = new CoachingStore(db);
    this.companyPolicies = new CompanyPolicyStore(db);
    this.routing = new RoutingStore(db, undefined, (companyId) => this.companyPolicies.effective(companyId));
    this.career = new CareerReviewStore(db);
    this.careerWorkflow = new CareerWorkflow(db, this.career, this.tasks, this.runs, (companyId, taskId, actorId) => {
      this.enqueueRun(companyId, taskId, { requestedBy: actorId, maxAttempts: 1 });
    });
    this.sandboxAccess = new SandboxAccessService(db);
    this.notifications = new NotificationStore(db);
    this.decisions = new DecisionStore(db);
    this.secrets = new SecretStore(db);
    this.attachments = new AttachmentStore(db);
    this.remoteWorkers = new RemoteWorkerStore(db);
    this.meetings = new MeetingStore(db);
    this.memories = new MemoryStore(db);
    this.mailboxes = new MailboxStore(db);
    this.marketplaces = new MarketplaceStore(db);
    this.agentLocks = new AgentLockStore(db);
    this.externalEvents = new ExternalEventStore(db);
    this.changeProposals = new ChangeProposalStore(db);
    this.messengerPairings = new MessengerPairingStore(db);
    this.vessels = new VesselStore(db);
    this.talents = new TalentStore(db);
    this.runRequests = new RunRequestStore(db);
    this.tools = new ToolStore(db);
    this.routines = new RoutineStore(db);
  }

  private get attachmentStorage(): AttachmentStorage {
    if (!this.attachmentStorageInstance) {
      this.attachmentStorageInstance = new AttachmentStorage(this.attachmentStorageRoot);
    }
    return this.attachmentStorageInstance;
  }

  /** Mirrors registerSecretProvider(): unregistered defaults to a real TailscaleProvider only once actually used. */
  registerTailscaleProvider(provider: TailscaleProvider): void {
    this.tailscaleProviderInstance = provider;
  }

  private get tailscaleProvider(): TailscaleProvider {
    if (!this.tailscaleProviderInstance) this.tailscaleProviderInstance = new TailscaleProvider();
    return this.tailscaleProviderInstance;
  }

  tailscaleStatus(): Promise<TailscaleStatus> {
    return this.tailscaleProvider.status();
  }

  testTailscale(): Promise<TailscaleConnectionStatus> {
    return this.tailscaleProvider.testConnection();
  }

  /**
   * SSH-over-tailnet reachability check for a registered remote worker.
   * Builds the same SshConfig shape server/modules/workflow/ssh/ssh-connector.ts
   * already expects, so a remote worker is exactly as safe (argv-array SSH,
   * ControlMaster reuse, allowlisted exec) as any other SSH target this
   * codebase talks to — nothing new was invented for this feature.
   */
  async testRemoteWorker(companyId: string, workerId: string): Promise<{ ok: boolean; message: string }> {
    const worker = this.remoteWorkers.get(workerId);
    if (!worker || worker.company_id !== companyId) {
      return { ok: false, message: `Remote worker "${workerId}" existiert nicht.` };
    }
    const config: SshConfig = {
      host: worker.host,
      port: worker.port,
      user: worker.ssh_user,
      private_key_path: worker.private_key_path,
      known_hosts_policy: worker.known_hosts_policy,
    };
    const reachable = await this.sshConnectorFactory(config).testConnection();
    return {
      ok: reachable,
      message: reachable
        ? `Erreichbar über ${worker.host}:${worker.port}`
        : `Nicht erreichbar über ${worker.host}:${worker.port}`,
    };
  }

  /**
   * How many of a meeting's most recent turns go into the next speaker's
   * prompt. Deliberately NOT the whole growing transcript — together with
   * MeetingStore's one-round-one-turn shape, this is what keeps a meeting's
   * total token cost O(max_rounds) rather than the upstream god-object's
   * O(participants x rounds) (docs/UPSTREAM_ANALYSIS.md).
   */
  private static readonly MEETING_TURN_CONTEXT_WINDOW = 6;

  /**
   * Runs exactly one meeting turn: picks the next speaker (moderator-chosen
   * via `opts.agentId`, or round-robin), gives them a bounded recent-turns
   * window as context, dispatches through the same registered AgentRuntime
   * task execution uses, and records the result. Self-closes the meeting
   * the moment max_rounds or its own budget cap is reached — a caller never
   * has to separately poll for that.
   */
  async runMeetingTurn(
    companyId: string,
    meetingId: string,
    opts: { agentId?: string; workspacePath?: string } = {},
  ): Promise<{ meeting: MeetingRow; turn: MeetingTurnRow } | null> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.company_id !== companyId) {
      throw new MeetingMutationError(`Meeting "${meetingId}" does not exist.`);
    }
    if (meeting.status === "completed" || meeting.status === "cancelled") {
      // The meeting is already over — a caller that keeps polling after the
      // bound was hit gets a quiet no-op, not an error.
      return null;
    }
    if (meeting.status !== "in_progress") {
      throw new MeetingMutationError(`Meeting "${meetingId}" is not in progress.`);
    }

    if (meeting.current_round >= meeting.max_rounds) {
      this.meetings.end(meetingId, meeting.minutes || "Maximale Rundenzahl erreicht.", {
        actorType: "system",
        actorId: "meeting-moderator",
      });
      return null;
    }
    if (meeting.budget_micros > 0 && meeting.spent_micros >= meeting.budget_micros) {
      this.meetings.end(meetingId, meeting.minutes || "Budget für dieses Meeting ausgeschöpft.", {
        actorType: "system",
        actorId: "meeting-moderator",
      });
      return null;
    }

    const participants = this.meetings.participants(meetingId);
    if (participants.length === 0) {
      throw new MeetingMutationError("A meeting with no participants cannot run a turn.");
    }

    let speakerAgentId = opts.agentId;
    if (speakerAgentId) {
      if (!participants.some((p) => p.agent_id === speakerAgentId)) {
        throw new MeetingMutationError(`Agent "${speakerAgentId}" is not a participant in this meeting.`);
      }
    } else {
      speakerAgentId = participants[meeting.current_round % participants.length].agent_id;
    }

    const agent = this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(speakerAgentId) as
      | AgentRow
      | undefined;
    if (!agent) throw new MeetingMutationError(`Agent "${speakerAgentId}" does not exist.`);

    if (agent.company_id !== companyId) throw new MeetingMutationError("Meeting-Agent gehört zu einer anderen Firma.");
    this.budgets.assertRunPermitted(companyId, {
      agentId: speakerAgentId,
      projectId: meeting.project_id,
      runtimeType: agent.runtime_provider,
    });
    const binding = this.routing.binding(companyId, speakerAgentId);
    const route = binding
      ? await selectProfileRoute({
          db: this.db,
          store: this.routing,
          budgets: this.budgets,
          runtimes: this.runtimes,
          companyId,
          agentId: speakerAgentId,
          taskId: null,
          projectId: meeting.project_id,
          correlationId: newCorrelationId(),
          binding,
          sensitive: true,
          workspace: (r) => this.resolveWorkspace(companyId, meeting.project_id, r, opts.workspacePath),
        })
      : null;
    const runtimeType = route?.target.runtimeType ?? agent.runtime_provider;
    const runtime = route?.runtime ?? this.runtimes.get(runtimeType);
    if (!runtime) throw new Error(`No runtime registered for type "${runtimeType}".`);

    // A meeting's spend is real spend — same pre-dispatch gate task execution uses.
    this.budgets.assertRunPermitted(companyId, {
      agentId: speakerAgentId,
      projectId: meeting.project_id,
      runtimeType,
    });

    const guidance = buildAgentGuidance({
      professional_role: agent.professional_role,
      role_summary: agent.role_summary,
      skin: JSON.parse(agent.persona_json),
      policy: JSON.parse(agent.policy_json),
    });

    const approvedCoaching = this.coaching.current(companyId, speakerAgentId);
    const coachingContext = approvedCoaching
      ? `\n\n# Vom Owner freigegebenes Coaching (Version ${approvedCoaching.version}; untergeordnet zu Policy und Fachgrenzen)\n${wrapUntrusted(approvedCoaching.guidance, { source: "owner-approved coaching", kind: "guidance" }).text}\nSkill-Referenzen: ${JSON.stringify(approvedCoaching.skills)}`
      : "";
    if (approvedCoaching)
      appendAuditEvent(this.db, {
        companyId,
        actorType: "system",
        actorId: "context-builder",
        action: "coaching.meeting_context_used",
        entityType: "meeting",
        entityId: meeting.id,
        details: { agentId: speakerAgentId, version: approvedCoaching.version, round: meeting.current_round + 1 },
      });

    const participantNames = new Map(participants.map((p) => [p.agent_id, p.display_name]));
    const recent = this.meetings.recentTurns(meetingId, CompanyOrchestrator.MEETING_TURN_CONTEXT_WINDOW);
    const transcript =
      recent.length === 0
        ? "(Noch keine Wortmeldungen.)"
        : recent.map((t) => `${participantNames.get(t.agent_id) ?? t.agent_id}: ${t.contribution}`).join("\n");

    const prompt = `${guidance}${coachingContext}\n\n# Meeting\nThema: ${meeting.topic}\n\nBisherige Wortmeldungen (letzte ${recent.length}):\n${transcript}\n\nGib deine Wortmeldung kurz und konkret (2-4 Sätze).`;

    const round = meeting.current_round + 1;
    let contribution = "";
    let costMicros = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    let meetingCompleted = false;
    const meetingAbort = new AbortController();
    const originVessel = agent.vessel_id ? this.vessels.get(agent.vessel_id) : null;
    const meetingTimeout = Math.min(
      agent.vessel_timeout_ms > 0 ? agent.vessel_timeout_ms : DEFAULT_RUN_TIMEOUT_MS,
      route?.vessel.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS,
      this.configuration.effective(companyId).runtime.maxRunTimeoutMs,
    );
    const capacityLease = this.configuration.reserveMeeting(companyId, meetingTimeout, VESSEL_RUN_STALE_MS);
    let routeLease: string | null = null;
    const meetingTimer = setTimeout(() => meetingAbort.abort(new Error("Meeting-Timeout")), meetingTimeout);
    meetingTimer.unref?.();
    try {
      if (route) routeLease = this.routing.reserveMeeting(companyId, meetingId, route.vessel, originVessel);
      else if (originVessel) routeLease = this.routing.reserveMeeting(companyId, meetingId, originVessel, null);
      if (route) {
        const latest = this.routing.binding(companyId, speakerAgentId);
        if (latest?.revision !== route.revision || latest.profile.key !== route.profileKey)
          throw new RoutingError("route_changed", "Routing wurde während der Meeting-Vorbereitung geändert.");
        this.routing.target(companyId, route.target);
        const currentWorkspace = await this.resolveWorkspace(
          companyId,
          meeting.project_id,
          runtime,
          opts.workspacePath,
        );
        if (currentWorkspace !== route.workspacePath)
          throw new RoutingError("route_changed", "Meeting-Workspace wurde während der Vorbereitung geändert.");
        this.budgets.assertRunPermitted(companyId, {
          agentId: speakerAgentId,
          projectId: meeting.project_id,
          runtimeType,
          provider: runtimeType,
          originRuntimeType: agent.runtime_provider,
          modelVendor: route.target.vendorModel.split("/")[0],
        });
      }
      const meetingModel = route?.target.model ?? (agent.vessel_model.trim() || undefined);
      const meetingWorkspace =
        route?.workspacePath ??
        (await this.resolveWorkspace(companyId, meeting.project_id, runtime, opts.workspacePath));
      const vendorRestrictions = this.admittedVendorRestrictions(companyId, runtimeType, meetingModel);
      for await (const ev of runtime.startRun(
        { prompt, model: meetingModel, ...(route ? { modelProfile: route.profileKey } : {}) },
        {
          companyId,
          projectId: meeting.project_id,
          // No real crew_tasks row backs a meeting turn (see the migration's
          // comment on crew_meeting_turns) — RunContext.taskId is only ever
          // used by a runtime to tag its own emitted events, never persisted
          // through RunStore here, so the meeting id is a safe stand-in.
          taskId: meetingId,
          runId: newId("run"),
          agentId: speakerAgentId,
          correlationId: newCorrelationId(),
          workspacePath: meetingWorkspace,
          vendorRestrictions,
          sensitive: true,
          permissionMode: "restricted",
          signal: meetingAbort.signal,
        },
      )) {
        if (ev.type === "usage.updated") {
          const p = ev.payload as { inputTokens?: number; outputTokens?: number; costMicros?: number };
          inputTokens += p.inputTokens ?? 0;
          outputTokens += p.outputTokens ?? 0;
          costMicros += p.costMicros ?? 0;
          if (route) {
            this.budgets.recordCost({
              companyId,
              taskId: null,
              projectId: meeting.project_id,
              agentId: speakerAgentId,
              runtimeType,
              provider: runtimeType,
              originRuntimeType: agent.runtime_provider,
              modelVendor: route.target.vendorModel.split("/")[0],
              kind: (p.costMicros ?? 0) > 0 ? "usage" : "quota",
              inputTokens: p.inputTokens ?? 0,
              outputTokens: p.outputTokens ?? 0,
              costMicros: p.costMicros ?? 0,
            });
            this.budgets.assertRunPermitted(companyId, {
              agentId: speakerAgentId,
              projectId: meeting.project_id,
              runtimeType,
              provider: runtimeType,
              originRuntimeType: agent.runtime_provider,
              modelVendor: route.target.vendorModel.split("/")[0],
            });
            if (meeting.budget_micros > 0 && meeting.spent_micros + costMicros >= meeting.budget_micros)
              throw new RoutingError("meeting_budget", "Meeting-Budget ausgeschöpft.", 402);
          }
        }
        if (
          meetingAbort.signal.aborted ||
          ["run.failed", "run.cancelled", "run.waiting", "rate_limit.detected"].includes(ev.type)
        )
          throw new RoutingError(
            "meeting_run_stopped",
            "Meeting-Run wurde abgebrochen oder wartet; kein automatischer Fallback.",
          );
        if (ev.type === "run.completed") meetingCompleted = true;
        if (ev.type === "message.completed") contribution = String((ev.payload as { text?: string }).text ?? "");
      }
      if (meetingAbort.signal.aborted || (route && !meetingCompleted))
        throw new RoutingError("meeting_incomplete", "Meeting-Run wurde ohne bestätigten Abschluss beendet.");
    } catch (err) {
      meetingAbort.abort(err);
      contribution = `[Fehler: ${err instanceof Error ? err.message : String(err)}]`;
    } finally {
      if (meetingTimer) clearTimeout(meetingTimer);
      if (routeLease) this.routing.releaseMeeting(routeLease);
      this.configuration.releaseMeeting(capacityLease);
    }

    if (!route && (costMicros > 0 || inputTokens > 0 || outputTokens > 0)) {
      this.budgets.recordCost({
        companyId,
        taskId: null,
        projectId: meeting.project_id,
        agentId: speakerAgentId,
        runtimeType,
        kind: costMicros > 0 ? "usage" : "quota",
        inputTokens,
        outputTokens,
        costMicros,
      });
    }

    const turn = this.meetings.recordTurn({ meetingId, round, agentId: speakerAgentId, contribution, costMicros });

    const updated = this.meetings.get(meetingId)!;
    if (
      updated.current_round >= updated.max_rounds ||
      (updated.budget_micros > 0 && updated.spent_micros >= updated.budget_micros)
    ) {
      this.meetings.end(meetingId, updated.minutes || "Automatisch beendet (Rundenlimit oder Budget erreicht).", {
        actorType: "system",
        actorId: "meeting-moderator",
      });
    }

    return { meeting: this.meetings.get(meetingId)!, turn };
  }

  /**
   * Turns one action item into a real task — idempotent: converting an
   * already-linked item again just returns the existing task rather than
   * creating a duplicate.
   */
  convertActionItemToTask(
    companyId: string,
    actionItemId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): TaskRow | null {
    const item = this.meetings.getActionItem(actionItemId);
    if (!item) return null;
    const meeting = this.meetings.get(item.meeting_id);
    if (!meeting || meeting.company_id !== companyId) return null;

    if (item.task_id) return this.tasks.get(item.task_id);

    const task = this.tasks.create({
      companyId,
      title: item.description.length > 200 ? `${item.description.slice(0, 197)}...` : item.description,
      description: `Aus Meeting "${meeting.topic}": ${item.description}`,
      projectId: meeting.project_id,
      assignedAgentId: item.assigned_agent_id,
      createdBy: humanActor(opts),
    });

    this.meetings.linkActionItemToTask(actionItemId, task.id, opts);
    return task;
  }

  /**
   * The one place an approval turns into an inbox item. Both call sites that
   * create an approval (the sensitive-request path and a runtime's
   * approval.required event) go through this, so a notification can never
   * exist for an approval this didn't also mint the approval for.
   */
  private notifyApprovalRequested(companyId: string, approval: ApprovalRow): void {
    const notification = this.notifications.create({
      companyId,
      kind: "approval_required",
      severity: approval.risk_level === "critical" || approval.risk_level === "high" ? "critical" : "warning",
      title: approval.summary,
      body: approval.proposed_action,
      taskId: approval.task_id,
      approvalId: approval.id,
    });
    this.fanOutNotification(companyId, {
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
    });
  }

  /** Mirrors registerSecretProvider()/registerMemoryProvider(). */
  registerNotificationChannel(channel: NotificationChannel): void {
    this.notificationChannels.set(channel.kind, channel);
  }

  listNotificationChannelKinds(): string[] {
    return [...this.notificationChannels.keys()];
  }

  async testNotificationChannel(kind: string): Promise<{ ok: boolean; message: string }> {
    const channel = this.notificationChannels.get(kind);
    if (!channel) return { ok: false, message: `No "${kind}" channel is registered on this server.` };
    return channel.testConnection();
  }

  /** Unlike testNotificationChannel(), this actually sends a real message — proof the whole path works, not just reachability. */
  async sendTestNotification(kind: string): Promise<{ ok: boolean; message: string }> {
    const channel = this.notificationChannels.get(kind);
    if (!channel) return { ok: false, message: `No "${kind}" channel is registered on this server.` };
    try {
      await channel.send({
        title: "IronCrew Testbenachrichtigung",
        body: "Dies ist eine Testbenachrichtigung von IronCrew.",
        severity: "info",
      });
      return { ok: true, message: "Testbenachrichtigung gesendet." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- mailboxes (IMAP, JMAP, Microsoft 365, Gmail) ------------------------
  //
  // Two rules govern everything below.
  //
  // 1. A grant is checked on every agent-initiated call, not once at
  //    registration: `opts.agentId` present means an agent is acting and
  //    must hold a row in crew_mailbox_agents; absent means the owner is
  //    acting directly through the Command Center.
  // 2. Incoming mail is untrusted input from outside the company. It is
  //    never routed through handleCeoMessage() — that path treats its text
  //    as the owner speaking and can delegate work immediately, so feeding
  //    it a stranger's email would let any sender act as the CEO. Mail
  //    becomes an `inbox` task instead: visible, attributed, quoted as
  //    data, and still requiring a human or the EA to move it forward.

  /** Mirrors registerSecretProvider()/registerMemoryProvider(). */
  registerMailProvider(provider: MailProvider): void {
    this.mailProviders.set(provider.kind, provider);
  }

  listMailProviderKinds(): MailboxKind[] {
    return [...this.mailProviders.keys()];
  }

  private mailProviderFor(kind: MailboxKind): MailProvider {
    const provider = this.mailProviders.get(kind);
    if (!provider) throw new MailboxMutationError(`No "${kind}" mail provider is registered on this server.`);
    return provider;
  }

  /**
   * Builds the provider's view of a mailbox: the row, its decrypted
   * credentials, and a way to persist rotated OAuth tokens. Credentials are
   * read here and nowhere else in this class, so the decrypted values never
   * outlive the call that needed them.
   */
  private mailContext(mailbox: MailboxRow): MailboxContext {
    return {
      mailbox,
      credentials: this.mailboxes.readCredentials(mailbox.id),
      saveCredentials: (credentials) => this.mailboxes.writeCredentials(mailbox.id, credentials),
    };
  }

  private mailboxOf(companyId: string, mailboxId: string): MailboxRow {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.company_id !== companyId) {
      throw new MailboxMutationError(`Mailbox "${mailboxId}" does not exist.`);
    }
    return mailbox;
  }

  /** Deny by default: no grant row, no access. 'send' additionally requires the send level. */
  private assertMailboxAccess(mailbox: MailboxRow, opts: { agentId?: string }, need: MailboxAccess): void {
    if (!opts.agentId) return;
    const granted = this.mailboxes.access(mailbox.id, opts.agentId);
    if (!granted || (need === "send" && granted !== "send")) {
      throw new MailboxAccessError(`Agent "${opts.agentId}" has no ${need} access to mailbox "${mailbox.label}".`);
    }
  }

  async testMailbox(companyId: string, mailboxId: string): Promise<{ ok: boolean; message: string }> {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox || mailbox.company_id !== companyId) {
      return { ok: false, message: `Postfach "${mailboxId}" existiert nicht.` };
    }
    const provider = this.mailProviders.get(mailbox.kind);
    if (!provider) return { ok: false, message: `Kein "${mailbox.kind}"-Provider registriert.` };
    return provider.testConnection(this.mailContext(mailbox));
  }

  async listMailboxMessages(
    companyId: string,
    mailboxId: string,
    opts: { limit?: number; since?: number; agentId?: string } = {},
  ): Promise<MailMessageSummary[]> {
    const mailbox = this.mailboxOf(companyId, mailboxId);
    this.assertMailboxAccess(mailbox, opts, "read");
    return this.mailProviderFor(mailbox.kind).listMessages(this.mailContext(mailbox), {
      limit: opts.limit,
      since: opts.since,
    });
  }

  async readMailboxMessage(
    companyId: string,
    mailboxId: string,
    externalId: string,
    opts: { agentId?: string } = {},
  ): Promise<MailMessageBody | null> {
    const mailbox = this.mailboxOf(companyId, mailboxId);
    this.assertMailboxAccess(mailbox, opts, "read");
    return this.mailProviderFor(mailbox.kind).getMessage(this.mailContext(mailbox), externalId);
  }

  /**
   * Sends from a mailbox. Auditied because it is an outward-facing action
   * taken in the company's name — the audit records who sent what to whom,
   * never the message body.
   */
  async sendFromMailbox(
    companyId: string,
    mailboxId: string,
    mail: OutgoingMail,
    opts: { agentId?: string; actorType?: ActorType; actorId?: string } = {},
  ): Promise<void> {
    const mailbox = this.mailboxOf(companyId, mailboxId);
    this.assertMailboxAccess(mailbox, opts, "send");

    await this.mailProviderFor(mailbox.kind).send(this.mailContext(mailbox), mail);

    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? (opts.agentId ? "agent" : "owner"),
      actorId: opts.actorId ?? opts.agentId ?? "ceo",
      action: "mailbox.sent",
      entityType: "mailbox",
      entityId: mailbox.id,
      details: { to: mail.to, subject: mail.subject, from: mailbox.email_address },
    });
  }

  /**
   * Polls one mailbox: fetches recent mail, records what it has not seen
   * before, and — only when the mailbox has auto-triage switched on — turns
   * each genuinely new message into an `inbox` task.
   *
   * Returns counts rather than the messages themselves, so a caller can
   * report "3 new, 2 tasks" without the bodies passing through it.
   */
  async pollMailbox(
    companyId: string,
    mailboxId: string,
  ): Promise<{ mailbox: MailboxRow; seen: number; newMessages: number; tasksCreated: TaskRow[] }> {
    const mailbox = this.mailboxOf(companyId, mailboxId);
    const provider = this.mailProviderFor(mailbox.kind);

    let summaries: MailMessageSummary[];
    try {
      summaries = await provider.listMessages(this.mailContext(mailbox), {
        // Only ever ask for mail newer than the last successful poll; the
        // seen-index is the backstop, this just keeps the request small.
        since: mailbox.last_polled_at ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failing mailbox records why and stays visible in the UI rather
      // than silently going quiet.
      this.mailboxes.recordPollResult(mailbox.id, { error: message });
      throw err;
    }

    const tasksCreated: TaskRow[] = [];
    let newMessages = 0;
    for (const summary of summaries) {
      const { row, isNew } = this.mailboxes.recordSeenMessage({
        mailboxId: mailbox.id,
        externalId: summary.externalId,
        messageId: summary.messageId,
        subject: summary.subject,
        fromAddress: summary.from,
        receivedAt: summary.receivedAt,
      });
      if (!isNew) continue;
      newMessages += 1;

      if (mailbox.auto_triage === 1) {
        const task = this.taskFromIncomingMail(companyId, mailbox, summary);
        this.mailboxes.linkMessageToTask(row.id, task.id);
        tasksCreated.push(task);
      }
    }

    this.mailboxes.recordPollResult(mailbox.id, {});
    if (tasksCreated.length > 0) this.notifyMailTriaged(companyId, mailbox, tasksCreated.length);

    return { mailbox: this.mailboxes.get(mailbox.id)!, seen: summaries.length, newMessages, tasksCreated };
  }

  /** Polls every mailbox whose own interval has elapsed. One failure does not stop the rest. */
  async pollDueMailboxes(
    companyId: string,
    now = Date.now(),
  ): Promise<Array<{ mailboxId: string; newMessages: number; tasksCreated: number; error?: string }>> {
    const results: Array<{ mailboxId: string; newMessages: number; tasksCreated: number; error?: string }> = [];
    for (const mailbox of this.mailboxes.listPollable(companyId, now)) {
      try {
        const result = await this.pollMailbox(companyId, mailbox.id);
        results.push({
          mailboxId: mailbox.id,
          newMessages: result.newMessages,
          tasksCreated: result.tasksCreated.length,
        });
      } catch (err) {
        results.push({
          mailboxId: mailbox.id,
          newMessages: 0,
          tasksCreated: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Turns one incoming message into a task — the security-critical half of
   * auto-triage.
   *
   * `triage()` is a pure classifier over text, so running it on a stranger's
   * subject line is safe and gives useful routing. What is deliberately NOT
   * done: delegating the task for execution, marking it ready, or treating
   * any instruction inside the mail as authority. The task lands in `inbox`.
   *
   * A task description is not inert: it becomes the `# Aufgabe` section of an
   * agent's prompt when the task is eventually run. So every attacker-reachable
   * field is put through `untrusted-content.ts` on the way in — the body is
   * fenced, the subject and sender are flattened to a single sanitised line so
   * neither can introduce header lines of its own into the block it sits in,
   * and chat-template turn markers are stripped from all three.
   */
  private taskFromIncomingMail(companyId: string, mailbox: MailboxRow, summary: MailMessageSummary): TaskRow {
    const classification = triage(`${summary.subject}\n\n${summary.snippet}`);
    const agent = this.pickAgent(companyId, classification);

    const subject = sanitiseLine(summary.subject);
    const sender = sanitiseLine(summary.from) || "unbekannt";
    const body = wrapUntrusted(summary.snippet, { source: sender, kind: "E-Mail" });

    const description = [
      `Eingegangen im Postfach "${mailbox.label}" (${mailbox.email_address}).`,
      `Absender: ${sender}`,
      summary.receivedAt ? `Empfangen: ${new Date(summary.receivedAt).toISOString()}` : "",
      // Worth saying in the task itself, not only in the audit log: an
      // operator reading this should know the mail carried something that had
      // to be removed before it was safe to quote.
      body.removed > 0
        ? `Hinweis: ${body.removed} Steuerzeichen/Rollenmarker aus dem Inhalt entfernt (mögliche Prompt-Injection).`
        : "",
      "",
      body.text,
    ]
      .filter(Boolean)
      .join("\n");

    if (body.removed > 0) {
      appendAuditEvent(this.db, {
        companyId,
        actorType: "system",
        actorId: `mailbox:${mailbox.id}`,
        action: "mail.sanitized",
        entityType: "mailbox",
        entityId: mailbox.id,
        // Metadata only — never the offending text, which would put the
        // payload straight into the audit log it is meant to be kept out of.
        details: { from: sender, subject, removed: body.removed, truncated: body.truncated },
      });
    }

    return this.tasks.create({
      companyId,
      title: `E-Mail: ${subject || "(kein Betreff)"}`,
      description,
      // `inbox`, never `ready`: an email may not put work into the
      // claimable queue on its own.
      status: "inbox",
      riskLevel: classification.riskLevel,
      sensitive: classification.sensitive,
      assignedAgentId: agent?.id ?? null,
      createdBy: `mailbox:${mailbox.id}`,
      correlationId: newCorrelationId(),
    });
  }

  /** New mail worth a look reaches the owner through the decision inbox and every registered channel. */
  private notifyMailTriaged(companyId: string, mailbox: MailboxRow, count: number): void {
    const notification = this.notifications.create({
      companyId,
      kind: "mail_triaged",
      severity: "info",
      title: `${count} neue E-Mail${count === 1 ? "" : "s"} in "${mailbox.label}"`,
      body: `Als Aufgabe${count === 1 ? "" : "n"} im Eingang abgelegt.`,
    });
    this.fanOutNotification(companyId, {
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
    });
  }

  // --- marketplaces: skills and MCP servers from outside this machine ------
  //
  // Reading a source and installing from it are deliberately separate. A
  // source is third-party JSON that can change between two page loads, so
  // entries are fetched live and never cached as installable commands; only
  // what an admin actually installed is recorded, with its provenance.
  //
  // The installer is where the trust boundary sits (see
  // marketplace-installer.ts): the allowlist, the schema, and the rule that
  // installing a skill writes Markdown and never executes anything.

  /** Mirrors registerMailProvider(): one adapter per marketplace kind. */
  registerMarketplaceSource(source: MarketplaceSource): void {
    this.marketplaceSources.set(source.kind, source);
  }

  listMarketplaceKinds(): MarketplaceKind[] {
    return [...this.marketplaceSources.keys()];
  }

  /**
   * Supplies the installer. Set at boot with the real MCP manager and skills
   * directory; tests register one writing into a temp dir. Mirrors
   * registerTailscaleProvider() — no orchestrator constructor argument grows
   * for something most callers never touch.
   */
  registerMarketplaceInstaller(installer: MarketplaceInstaller): void {
    this.marketplaceInstallerInstance = installer;
  }

  private get installer(): MarketplaceInstaller {
    if (!this.marketplaceInstallerInstance) {
      throw new MarketplaceMutationError("No marketplace installer is configured on this server.");
    }
    return this.marketplaceInstallerInstance;
  }

  private marketplaceOf(companyId: string, marketplaceId: string): MarketplaceRow {
    const source = this.marketplaces.get(marketplaceId);
    if (!source || source.company_id !== companyId) {
      throw new MarketplaceMutationError(`Marketplace "${marketplaceId}" does not exist.`);
    }
    return source;
  }

  private sourceFor(kind: MarketplaceKind): MarketplaceSource {
    const source = this.marketplaceSources.get(kind);
    if (!source) throw new MarketplaceMutationError(`No "${kind}" marketplace adapter is registered on this server.`);
    return source;
  }

  /**
   * Reads a source and returns what it offers. The outcome is recorded on the
   * row either way — a source that has been broken for a week should say so
   * in the UI without anyone having to click it again.
   */
  async browseMarketplace(companyId: string, marketplaceId: string): Promise<MarketplaceEntry[]> {
    const source = this.marketplaceOf(companyId, marketplaceId);
    const adapter = this.sourceFor(source.kind);
    try {
      const entries = await adapter.fetchEntries({
        id: source.id,
        kind: source.kind,
        name: source.name,
        url: source.url,
      });
      this.marketplaces.recordSync(source.id, { entryCount: entries.length });
      return entries;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.marketplaces.recordSync(source.id, { error: message });
      throw err instanceof MarketplaceSourceError ? err : new MarketplaceSourceError(message, source.kind);
    }
  }

  /** Browses every enabled source, reporting per-source failures rather than throwing. */
  async browseAllMarketplaces(
    companyId: string,
  ): Promise<Array<{ marketplace: MarketplaceRow; entries: MarketplaceEntry[]; error: string }>> {
    const results: Array<{ marketplace: MarketplaceRow; entries: MarketplaceEntry[]; error: string }> = [];
    for (const source of this.marketplaces.list(companyId)) {
      if (source.enabled !== 1) continue;
      try {
        const entries = await this.browseMarketplace(companyId, source.id);
        results.push({ marketplace: this.marketplaces.get(source.id) ?? source, entries, error: "" });
      } catch (err) {
        results.push({
          marketplace: this.marketplaces.get(source.id) ?? source,
          entries: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Installs one entry from a source. The entry is re-fetched from the source
   * by id rather than taken from the request: what the admin approved in the
   * UI must be what the source actually offers now, not a payload a caller
   * composed.
   */
  async installFromMarketplace(
    companyId: string,
    marketplaceId: string,
    entryId: string,
    options: InstallOptions = {},
    actor: { actorType?: "owner" | "agent" | "system"; actorId?: string } = {},
  ): Promise<{ install: MarketplaceInstallRow; result: InstallResult }> {
    const source = this.marketplaceOf(companyId, marketplaceId);
    const entries = await this.browseMarketplace(companyId, marketplaceId);
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new MarketplaceMutationError(`"${entryId}" is not offered by "${source.name}" (any more).`);
    }

    const result =
      entry.type === "mcp"
        ? await this.installer.installMcp(entry, options)
        : await this.installer.installSkill(entry, options);

    const install = this.marketplaces.recordInstall({
      companyId,
      marketplaceId: source.id,
      entryId: entry.id,
      entryType: entry.type,
      name: result.name,
      version: entry.version,
      sourceUrl: entry.sourceUrl,
      manifest: entry,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });

    return { install, result };
  }

  /**
   * Removes an installed artefact and its provenance row. The artefact is
   * removed first: a record saying "installed" next to nothing on disk is a
   * lie, while an orphaned server with no record is merely untidy and
   * visible in the MCP settings.
   */
  async uninstallFromMarketplace(
    companyId: string,
    entryType: "mcp" | "skill",
    name: string,
    actor: { actorType?: "owner" | "agent" | "system"; actorId?: string } = {},
  ): Promise<boolean> {
    // Nothing recorded and no installer to ask: there is genuinely nothing
    // here to remove, which is a plain "not found" — not a configuration
    // complaint about a server that was never asked to install anything.
    const recorded = this.marketplaces.findInstall(companyId, entryType, name) !== null;
    if (!recorded && !this.marketplaceInstallerInstance) return false;

    const removed = entryType === "mcp" ? await this.installer.uninstallMcp(name) : this.installer.uninstallSkill(name);
    const hadRecord = this.marketplaces.removeInstall(companyId, entryType, name, actor);
    return removed || hadRecord;
  }

  // --- inbound messaging: the EA's other direction -------------------------
  //
  // Until now IronCrew could tell you about an approval but you could not
  // answer it. This closes the loop — and because it is a new ingress, the
  // first question about every message is not what it says but who sent it.
  //
  // Three outcomes, decided by MessengerPairingStore and nothing else:
  //
  //   unknown/pending/blocked  a pairing prompt, and nothing else happens
  //   guest                    routed exactly like incoming mail: an `inbox`
  //                            task, quoted as third-party content (T-10)
  //   owner                    reaches handleCeoMessage(), i.e. speaks with
  //                            the owner's authority
  //
  // The last one is the feature, and also the risk: handleCeoMessage() can
  // delegate work immediately. It is reachable only through a pairing the
  // owner accepted as `owner` in the Command Center, having seen who asked.

  registerMessengerChannel(channel: MessengerChannel): void {
    this.messengerChannels.set(channel.kind, channel);
  }

  listMessengerChannelKinds(): string[] {
    return [...this.messengerChannels.keys()];
  }

  /**
   * Reachability of one inbound channel.
   *
   * Deliberately never polls to answer: a poll consumes the cursor, so a
   * "does this work" click would swallow messages nobody has seen yet.
   */
  async testMessengerChannel(kind: string): Promise<{ ok: boolean; message: string }> {
    const channel = this.messengerChannels.get(kind);
    if (!channel) return { ok: false, message: `No "${kind}" messenger channel is registered on this server.` };
    return channel.testConnection();
  }

  /**
   * Polls one channel and acts on whatever is allowed to act.
   *
   * Every message is recorded in the external event log first, so a redelivery
   * — which both Telegram and Discord can produce — is recognised rather than
   * answered twice.
   */
  async pollMessengerChannel(
    companyId: string,
    kind: string,
  ): Promise<{ received: number; handled: number; pairingPrompts: number; taskIds: string[] }> {
    const channel = this.messengerChannels.get(kind);
    if (!channel) throw new Error(`No "${kind}" messenger channel is registered on this server.`);

    const messages = await channel.poll();
    let handled = 0;
    let pairingPrompts = 0;
    const taskIds: string[] = [];

    for (const message of messages) {
      const seen = this.externalEvents.record({
        companyId,
        sourceKind: `messenger:${kind}`,
        sourceId: message.chatId,
        externalId: message.externalId,
        eventType: "message",
        payload: { text: message.text, senderId: message.senderId, senderName: message.senderName },
        occurredAt: message.receivedAt,
      });
      // A repeat was already answered once; answering again would double every
      // task the first delivery produced.
      if (!seen.isNew) continue;

      const outcome = await this.handleInboundMessage(companyId, kind, channel, message);
      if (outcome.result === "handled") handled++;
      if (outcome.result === "pairing") pairingPrompts++;
      if (outcome.taskId) taskIds.push(outcome.taskId);
      // The task id is what makes a replay useful later: an operator looking
      // at a replayed event can see what the first delivery already produced.
      this.externalEvents.markHandled(seen.event.id, `messenger:${kind}`, { taskId: outcome.taskId });
    }

    return { received: messages.length, handled, pairingPrompts, taskIds };
  }

  private async handleInboundMessage(
    companyId: string,
    kind: string,
    channel: MessengerChannel,
    message: InboundMessage,
  ): Promise<{ result: "handled" | "pairing" | "ignored"; taskId: string | null }> {
    const decision = this.messengerPairings.resolve({
      companyId,
      channelKind: kind,
      chatId: message.chatId,
      senderId: message.senderId,
      displayName: message.senderName,
    });

    if (decision.allow === "none") {
      // A blocked sender gets nothing at all — not even the courtesy of
      // knowing they are blocked, which would only tell them to try from
      // another account.
      if (decision.reason === "blocked") return { result: "ignored", taskId: null };

      await channel.reply(
        message.chatId,
        `IronCrew: Dieser Zugang ist noch nicht freigegeben. Code für die Freigabe: ${decision.pairing?.pairing_code ?? "—"}`,
      );
      return { result: "pairing", taskId: null };
    }

    if (decision.allow === "ceo") {
      const result = this.handleCeoMessage(companyId, message.text);
      await channel.reply(message.chatId, result.reply);
      return { result: "handled", taskId: result.task?.id ?? null };
    }

    // A guest is a stranger with a name. Same treatment as incoming mail:
    // an `inbox` task, never the CEO path.
    const wrapped = wrapUntrusted(message.text, {
      source: `${kind}:${sanitiseLine(message.senderName) || message.senderId}`,
      kind: "Chat-Nachricht",
    });
    const classification = triage(message.text);
    const agent = this.pickAgent(companyId, classification);

    const task = this.tasks.create({
      companyId,
      title: `Chat: ${sanitiseLine(message.text, 80) || "(ohne Text)"}`,
      description: [
        `Eingegangen über ${kind} von ${sanitiseLine(message.senderName) || message.senderId}.`,
        "",
        wrapped.text,
      ].join("\n"),
      status: "inbox",
      riskLevel: classification.riskLevel,
      sensitive: classification.sensitive,
      assignedAgentId: agent?.id ?? null,
      createdBy: `messenger:${kind}:${message.senderId}`,
      correlationId: newCorrelationId(),
    });

    await channel.reply(message.chatId, "IronCrew: Deine Nachricht liegt im Eingang und wird gesichtet.");
    return { result: "handled", taskId: task.id };
  }

  /** The owner accepts a pending pairing, choosing what authority it carries. */
  acceptMessengerPairing(companyId: string, pairingId: string, role: PairingRole, opts: HumanActor = {}) {
    const pairing = this.messengerPairings.get(pairingId);
    if (!pairing || pairing.company_id !== companyId) return null;
    return this.messengerPairings.accept(pairingId, role, { actorType: "owner", actorId: humanActor(opts) });
  }

  // --- change proposals: file edits an owner sees before they happen -------
  //
  // A proposal and its approval are created together and decided together.
  // They are two halves of one thing: a proposal without an approval is a
  // change nobody gated, and an approval without a proposal is a decision
  // about nothing. Keeping them in step here is what stops either half
  // drifting out of the other's reach.

  /**
   * An agent proposes file changes. Nothing is written; an approval request
   * is raised and the owner decides.
   */
  proposeChanges(
    companyId: string,
    input: {
      title: string;
      workspacePath: string;
      files: ProposedFile[];
      summary?: string;
      taskId?: string | null;
      runId?: string | null;
      agentId?: string | null;
    },
  ): { proposal: ChangeProposalRow; approvalId: string } {
    const approval = this.approvals.request(
      companyId,
      {
        approvalType: "file_change",
        requestedBy: input.agentId ?? "agent",
        summary: input.title,
        riskLevel: "high",
        impact: `${input.files.length} Datei(en) in ${input.workspacePath}`,
        rollbackPlan: "Die Freigabe verweigern; ohne Freigabe wird nichts geschrieben.",
        // Paths, never contents: an approval summary an owner skims should
        // say what would be touched, and the contents are one click away.
        proposedAction: input.files.map((f) => `${f.operation}: ${f.path}`).join("\n"),
      },
      { taskId: input.taskId ?? null, runId: input.runId ?? null },
    );

    const proposal = this.changeProposals.create({
      companyId,
      title: input.title,
      workspacePath: input.workspacePath,
      files: input.files,
      summary: input.summary,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      approvalId: approval.id,
    });

    this.notifyDecisionNeeded(companyId, approval.id, input.title, input.files.length);
    return { proposal, approvalId: approval.id };
  }

  /**
   * The owner decides. The approval and the proposal move together, so the
   * two can never disagree about whether a change was authorised.
   */
  decideChangeProposal(
    companyId: string,
    proposalId: string,
    decision: "approved" | "rejected",
    opts: { reason?: string } & HumanActor = {},
  ): ChangeProposalDecision | null {
    const proposal = this.changeProposals.get(proposalId);
    if (!proposal || proposal.company_id !== companyId) return null;

    const actorId = humanActor(opts);

    // Through the vote, not around it.
    //
    // A file-change proposal raises an ordinary `crew_approvals` row, so it
    // appears in the approvals list and an owner can demand four eyes on it —
    // a deploy script touching a customer's Tier 0 is exactly the case T-21
    // names. This method used to call `approvals.decide()` directly, which
    // meant the panel could show "0 von 2" while a single owner approved the
    // proposal and wrote the files. A gate with a bypass is not a gate
    // (T-15), and the bypass was justified in a comment claiming "the
    // proposal's own gate has already run" — circular, because this approval
    // *is* the proposal's gate.
    if (proposal.approval_id) {
      const outcome = this.reviewApproval(companyId, proposal.approval_id, decision, opts.reason ?? "", opts);
      // Null means the approval is no longer pending — decided, expired or
      // cancelled by another path. The proposal is not moved on the strength
      // of a vote that was not recorded.
      if (!outcome) return null;
      if (!outcome.decided) {
        // Recorded, and not yet enough. The proposal stays pending, nothing
        // is written, and the caller is told how many voices are missing so
        // it can say so rather than reporting a decision.
        return { proposal, tally: outcome.tally, decided: false };
      }
    }

    const decided = this.changeProposals.decide(proposalId, decision, { ...opts, actorType: "owner", actorId });
    return decided
      ? {
          proposal: decided,
          tally: proposal.approval_id ? this.approvalReviews.tally(proposal.approval_id) : null,
          decided: true,
        }
      : null;
  }

  /**
   * Writes an approved proposal.
   *
   * The approval is re-read here rather than trusted from the proposal row:
   * a decision that was reversed, expired or cancelled after the proposal was
   * marked approved must stop the write, and the approval is where that
   * lives.
   */
  applyChangeProposal(companyId: string, proposalId: string, opts: HumanActor = {}): ApplyResult {
    const proposal = this.changeProposals.get(proposalId);
    if (!proposal || proposal.company_id !== companyId) {
      throw new ChangeProposalError(`Proposal "${proposalId}" does not exist.`);
    }

    if (proposal.approval_id) {
      const approval = this.approvals.get(proposal.approval_id);
      if (!approval || approval.status !== "approved") {
        throw new ChangeProposalError(
          `The approval for "${proposalId}" is ${approval?.status ?? "missing"}, so nothing may be written.`,
        );
      }
    }

    return this.changeProposals.apply(proposalId, { actorType: "owner", actorId: humanActor(opts) });
  }

  /** A file change waiting on the owner reaches the decision inbox and every channel. */
  private notifyDecisionNeeded(companyId: string, approvalId: string, title: string, fileCount: number): void {
    const notification = this.notifications.create({
      companyId,
      kind: "approval_required",
      severity: "warning",
      title: `Dateiänderung wartet auf Freigabe: ${title}`,
      body: `${fileCount} Datei(en). Ohne Freigabe wird nichts geschrieben.`,
    });
    this.fanOutNotification(companyId, {
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
    });
    void approvalId;
  }

  /** What is installed right now, with where each thing came from. */
  marketplaceInstalls(companyId: string): MarketplaceInstallRow[] {
    return this.marketplaces.installs(companyId);
  }

  /**
   * Best-effort fan-out to every registered channel (Discord, Telegram,
   * email, …) — fire-and-forget, deliberately not awaited: a broken webhook
   * or SMTP server must never delay or fail the approval/notification flow
   * that triggered it. Each channel's outcome is still audited, the same
   * "never silent" discipline resolveSecret() applies to a failed
   * resolution — an operator can see exactly which channel failed and why,
   * without send() being able to throw back into the caller.
   */
  private fanOutNotification(
    companyId: string,
    message: { title: string; body: string; severity: ChannelSeverity },
  ): void {
    for (const channel of this.notificationChannels.values()) {
      channel
        .send(message)
        .then(() => {
          appendAuditEvent(this.db, {
            companyId,
            actorType: "system",
            actorId: "notification-fanout",
            action: "notification.sent",
            entityType: "notification_channel",
            entityId: channel.kind,
            outcome: "ok",
            details: { channel: channel.kind, title: message.title },
          });
        })
        .catch((err: unknown) => {
          appendAuditEvent(this.db, {
            companyId,
            actorType: "system",
            actorId: "notification-fanout",
            action: "notification.sent",
            entityType: "notification_channel",
            entityId: channel.kind,
            outcome: "failed",
            details: {
              channel: channel.kind,
              title: message.title,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        });
    }
  }

  /**
   * One human's verdict on a pending approval, and — if that verdict settles
   * it — the decision itself.
   *
   * WHY THE VOTE AND THE DECISION ARE THE SAME CALL
   *
   * They could have been two: `POST /reviews` to vote, and something else to
   * "close" the approval once enough votes are in. That shape has a failure
   * mode that is easy to reach and hard to notice — a quorum that is reached
   * and then sits there, because whatever was supposed to notice it did not
   * run. An approval that everybody has agreed to and that is still blocking
   * a task is indistinguishable, from the board, from one nobody has looked
   * at. So the tally is evaluated on the write that changes it, and the
   * approval settles in the same transaction-shaped moment as the vote that
   * settled it.
   *
   * The two directions are deliberately asymmetric, per migration 0023:
   *
   *   N approvals are needed to proceed.  ONE rejection stops it, now.
   *
   * A reviewer who has spotted that the destination IBAN is wrong must not
   * have to wait for a colleague to agree before the payment stops.
   *
   * At the default quorum of 1 — which is every approval this installation
   * has ever raised — the first approval satisfies the tally and this behaves
   * exactly as `decideApproval` did before the quorum existed. Nothing about
   * the single-operator box changes.
   */
  reviewApproval(
    companyId: string,
    approvalId: string,
    verdict: ReviewVerdict,
    reason = "",
    opts: HumanActor = {},
  ): ApprovalReviewOutcome | null {
    const reviewerId = humanActor(opts);

    const pending = this.approvals.get(approvalId);
    // Same "null" contract as before: unknown, or belonging to another
    // company, or no longer pending. A caller cannot tell those apart, and
    // deliberately so — an answer that distinguished them would confirm the
    // existence of an approval the caller may not see.
    if (!pending || pending.company_id !== companyId || pending.status !== "pending") return null;

    // Throws `ApprovalReviewError` on a second vote from the same person, and
    // that is the whole four-eyes guarantee: a refreshed tab is not a second
    // reviewer. The route turns it into a 409.
    const review = this.approvalReviews.record({ approvalId, reviewerId, verdict, reason });
    const tally = this.approvalReviews.tally(approvalId);

    // Not yet: enough people have not yet said yes, and nobody has said no.
    // The approval stays pending, the task stays parked, and the caller is
    // told how many voices are still missing.
    if (!tally.blocked && !tally.satisfied) {
      return { review, tally, approval: this.approvals.get(approvalId) ?? pending, decided: false };
    }

    const decision = tally.blocked ? "rejected" : "approved";
    const approval = this.decideApproval(companyId, approvalId, decision, reason, opts);
    // `decideApproval` returns null only if the approval stopped being
    // pending between the two reads. The review is already recorded and is
    // still the truth about what this person said, so it is returned rather
    // than swallowed.
    if (!approval) return { review, tally, approval: pending, decided: false };

    return { review, tally, approval, decided: true };
  }

  /**
   * Decide a pending approval and, unlike calling `this.approvals.decide()`
   * directly, also leave a durable business record of it: a decision-log
   * entry (distinct from the audit chain — see decision-store.ts) and the
   * matching notification cleared from the inbox. Returns null exactly when
   * `approvals.decide()` would (already decided / does not exist).
   *
   * This writes `crew_approvals.status` without consulting the quorum, and is
   * therefore not the route any human's click should take — `reviewApproval`
   * is, and `decideChangeProposal` goes through it too.
   *
   * It stays public for exactly one caller: `reviewApproval` itself, once a
   * tally has authorised the decision. A second caller was added here once,
   * with a comment explaining why its gate had already run; it had not, and
   * the result was a quorum the UI displayed and nothing enforced. If you are
   * about to add a third, you are about to do that again.
   */
  decideApproval(
    companyId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    reason = "",
    opts: HumanActor = {},
  ): ApprovalRow | null {
    const decidedBy = humanActor(opts);
    const approval = this.approvals.decide(approvalId, decision, decidedBy, reason);
    if (!approval) return null;

    this.decisions.create({
      companyId,
      title: approval.summary,
      decision,
      context: approval.impact,
      rationale: reason,
      decidedBy,
      taskId: approval.task_id,
    });
    this.notifications.markReadByApproval(companyId, approval.id);

    if (decision === "approved" && approval.approval_type === "sandbox_elevation")
      this.sandboxAccess.settleApproval(companyId, approval.id);
    this.career.settleApproval(companyId, approval.id);
    this.settleApprovedTask(companyId, approval, decision, reason, opts);

    return approval;
  }

  /**
   * Moves the task an approval was blocking, now that the owner has decided.
   *
   * Without this the decision was a dead end. `handleCeoMessage` parks
   * sensitive work at `approval_required` and returns; approving it recorded
   * the decision, marked the notification read — and left the task parked
   * forever. Nothing ever transitioned it, so the one path the approval gate
   * exists for (transfers, terminations, anything legally or financially
   * real) was the one path that could never complete.
   *
   * Deliberately narrow: it acts only on a task currently sitting in
   * `approval_required`. Bound runtime-tool approvals finish their run and
   * park here too. Other mid-run approvals leave tasks `running` or `waiting`;
   * resuming those here could start a second run. A `file_change` approval has no
   * parked task at all; that one is applied through `applyChangeProposal`,
   * which re-reads this same approval.
   */
  private settleApprovedTask(
    companyId: string,
    approval: ApprovalRow,
    decision: "approved" | "rejected",
    reason: string,
    opts: HumanActor = {},
  ): void {
    const actorId = humanActor(opts);
    if (!approval.task_id) return;
    const task = this.tasks.get(approval.task_id);
    if (!task || task.company_id !== companyId) return;
    if (task.status !== "approval_required") return;

    if (decision === "rejected") {
      // A refused task must not linger as if it might still happen. It is
      // cancelled, carrying the owner's reason, so the board shows a decision
      // rather than a stall.
      this.tasks.transition(task.id, "cancelled", {
        reason: `Freigabe abgelehnt: ${reason || "ohne Begründung"}`,
        actorType: "owner",
        actorId,
        correlationId: task.correlation_id,
      });
      this.syncAgentStatuses(companyId);
      return;
    }

    // The sensitive branch parks the task before delegation ever runs, so
    // there is usually no agent yet. Re-deriving the classification from the
    // stored description picks the same department the EA would have picked,
    // rather than inventing a second rule for who does approved work.
    const agentId = task.assigned_agent_id ?? this.pickAgent(companyId, triage(task.description))?.id ?? null;

    this.tasks.transition(task.id, "ready", {
      assignedAgentId: agentId,
      reason: "vom Chef freigegeben",
      actorType: "owner",
      actorId,
      correlationId: task.correlation_id,
    });

    // And the intent to run becomes a row, the same as any other delegation —
    // otherwise the approved task would sit at `ready` waiting for someone to
    // press a button, which is the gap the run queue exists to close.
    if (agentId) this.enqueueRun(companyId, task.id, { requestedBy: actorId });

    this.syncAgentStatuses(companyId);
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type, runtime);
  }

  /** Mirrors registerRuntime(): wrapping is unconditional, health is reported truthfully by testConnection(). */
  registerSecretProvider(provider: SecretProvider): void {
    this.secretProviders.set(provider.kind, provider);
  }

  listSecretProviderKinds(): SecretProviderKind[] {
    return [...this.secretProviders.keys()];
  }

  async testSecretProvider(kind: SecretProviderKind): Promise<{ ok: boolean; message: string }> {
    const provider = this.secretProviders.get(kind);
    if (!provider) return { ok: false, message: `No "${kind}" provider is registered on this server.` };
    return provider.testConnection();
  }

  /**
   * Resolve a stored SecretRef to its live value. The value is returned to
   * the caller and never persisted here — not in the database, not in the
   * audit trail (whose `details` deliberately carry only the ref's
   * metadata), matching this store's own doc-comment
   * (domain/secret-store.ts) and docs/THREAT_MODEL.md.
   */
  async resolveSecret(
    companyId: string,
    secretId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): Promise<string> {
    const secret = this.secrets.get(secretId);
    if (!secret || secret.company_id !== companyId) {
      throw new SecretResolutionError(`Secret "${secretId}" does not exist.`);
    }
    const provider = this.secretProviders.get(secret.provider);
    if (!provider) {
      throw new SecretResolutionError(`No "${secret.provider}" provider is registered on this server.`);
    }

    const actorType = opts.actorType ?? "system";
    const actorId = opts.actorId ?? "orchestrator";
    try {
      const value = await provider.resolve({
        provider: secret.provider,
        itemRef: secret.item_ref,
        field: secret.field ?? undefined,
      });
      appendAuditEvent(this.db, {
        companyId,
        actorType,
        actorId,
        action: "secret.resolved",
        entityType: "secret",
        entityId: secret.id,
        outcome: "ok",
        details: { name: secret.name, provider: secret.provider },
      });
      return value;
    } catch (err) {
      appendAuditEvent(this.db, {
        companyId,
        actorType,
        actorId,
        action: "secret.resolved",
        entityType: "secret",
        entityId: secret.id,
        outcome: "failed",
        details: {
          name: secret.name,
          provider: secret.provider,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /** Mirrors registerSecretProvider(). */
  registerMemoryProvider(provider: MemoryProvider): void {
    this.memoryProviders.set(provider.kind, provider);
  }

  listMemoryProviderKinds(): string[] {
    return [...this.memoryProviders.keys()];
  }

  async testMemoryProvider(kind: string) {
    const provider = this.memoryProviders.get(kind);
    if (!provider) return { ok: false, message: `No "${kind}" provider is registered on this server.` };
    return {
      ...(await provider.testConnection()),
      ...(provider instanceof HybridMemoryProvider ? { sync: provider.syncStatus(), semanticAvailable: true } : {}),
    };
  }

  async syncMemoryProviders(): Promise<void> {
    for (const provider of this.memoryProviders.values()) {
      if (provider instanceof HybridMemoryProvider) await provider.syncPending();
    }
  }

  async searchSemanticMemory(provider: string, query: string, companyId?: string): Promise<MemorySearchHit[]> {
    if (!companyId || !this.configuration.effective(companyId).memory.semanticSearchEnabled)
      throw new CompanyConfigurationError(
        "semantic_search_disabled",
        "Externe semantische Suche ist für diese Firma deaktiviert.",
        403,
      );
    const memory = this.memoryProviders.get(provider);
    if (!(memory instanceof HybridMemoryProvider)) throw new MemoryMutationError("Honcho is not configured.");
    return memory.searchSemantic(query, "public", 20);
  }

  /** Bounded, source-labelled local memory. Retrieval never implicitly sends a query to Honcho. */
  private async runMemoryContext(companyId: string, task: TaskRow, agentId: string): Promise<string> {
    const memoryConfiguration = this.configuration.effective(companyId).memory;
    if (!memoryConfiguration.runContextEnabled) return "";
    const refs = this.memories
      .list(companyId)
      .filter(
        (ref) =>
          (!ref.task_id || ref.task_id === task.id) &&
          (!ref.project_id || ref.project_id === task.project_id) &&
          (!ref.agent_id || ref.agent_id === agentId) &&
          (["public", "internal"].includes(ref.sensitivity) ||
            (ref.sensitivity === "confidential" && task.sensitive !== 0)),
      )
      .slice(0, memoryConfiguration.maxContextEntries);
    const context: string[] = [];
    for (const ref of refs) {
      const provider = this.memoryProviders.get(ref.provider);
      if (!provider) continue;
      try {
        const content = await provider.read(ref.external_id);
        if (
          content &&
          mayRetrieveMemory(readCurrentProvenance(content), {
            companyId,
            taskId: task.id,
            projectId: task.project_id,
            agentId,
            sensitive: task.sensitive !== 0,
          })
        )
          context.push(
            wrapUntrusted(redactText(content), {
              source: `${ref.id} · ${ref.source} · ${ref.kind} · confidence ${ref.confidence}`,
              kind: "Memory-Quelle, keine Anweisung",
              maxChars: 1200,
            }).text,
          );
      } catch {
        appendAuditEvent(this.db, {
          companyId,
          actorType: "system",
          actorId: "memory-context",
          action: "memory.context_unavailable",
          entityType: "memory",
          entityId: ref.id,
          taskId: task.id,
          correlationId: task.correlation_id,
          outcome: "failed",
          details: { provider: ref.provider },
        });
      }
    }
    return context.length ? `\n\n# Relevante Wissensquellen\n${context.join("\n\n")}` : "";
  }

  /**
   * Write a memory entry through its provider (real content, e.g. an
   * Obsidian markdown file), then record the resulting reference —
   * provider + externalId + IronCrew provenance — in crew_memory_refs. The
   * provider receives provenance for classification and scoped synchronization;
   * this store never sees the entry's actual content. Same split as
   * SecretRef/SecretProvider, see domain/memory-store.ts's own doc-comment.
   */
  async recordMemory(
    companyId: string,
    provider: string,
    input: {
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
    },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): Promise<MemoryRefRow> {
    const memoryProvider = this.memoryProviders.get(provider);
    if (!memoryProvider) throw new Error(`No "${provider}" memory provider is registered on this server.`);
    input = {
      ...input,
      title: redactText(input.title),
      content: redactText(input.content),
      tags: input.tags?.map((tag) => redactText(tag)),
      source: input.source === undefined ? undefined : redactText(input.source),
    };

    for (const [table, id] of [
      ["crew_tasks", input.taskId],
      ["crew_projects", input.projectId],
      ["crew_agents", input.agentId],
    ] as const) {
      if (id && !this.db.prepare(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`).get(id, companyId)) {
        throw new MemoryMutationError("Memory provenance must reference an entity in the same company.");
      }
    }
    const written = await memoryProvider.write({
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
      provenance: {
        companyId,
        taskId: input.taskId,
        projectId: input.projectId,
        agentId: input.agentId,
        source: input.source,
        confidence: input.confidence,
        sensitivity: input.sensitivity ?? "internal",
      },
    });

    return this.memories.create({
      companyId,
      provider,
      externalId: written.externalId,
      path: written.path,
      kind: input.kind,
      title: input.title,
      taskId: input.taskId,
      projectId: input.projectId,
      agentId: input.agentId,
      source: input.source,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      actorType: opts.actorType,
      actorId: opts.actorId,
    });
  }

  /** Reads a memory entry's actual content back through its provider. Null if the ref or the underlying entry is gone. */
  async readMemoryContent(companyId: string, memoryId: string): Promise<{ ref: MemoryRefRow; content: string } | null> {
    const ref = this.memories.get(memoryId);
    if (!ref || ref.company_id !== companyId) return null;
    const provider = this.memoryProviders.get(ref.provider);
    if (!provider) return null;
    const content = await provider.read(ref.external_id);
    if (content === null) return null;
    return { ref, content };
  }

  /** Deletes both the provider's underlying entry (best-effort) and the crew_memory_refs row. */
  async deleteMemory(
    companyId: string,
    memoryId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): Promise<boolean> {
    const ref = this.memories.get(memoryId);
    if (!ref || ref.company_id !== companyId) return false;
    const provider = this.memoryProviders.get(ref.provider);
    if (provider) await provider.delete(ref.external_id);
    return this.memories.delete(memoryId, opts);
  }

  /** Full-text search over a provider's own written content — see MemoryProvider#search. */
  async searchMemory(provider: string, query: string): Promise<MemorySearchHit[]> {
    const memoryProvider = this.memoryProviders.get(provider);
    if (!memoryProvider) throw new Error(`No "${provider}" memory provider is registered on this server.`);
    return memoryProvider.search(query);
  }

  /**
   * Write the blob to disk, then record it. Validation (task/project exist,
   * same company, at most one scope) happens inside attachments.create() —
   * writing first means a rejected upload can leave an unreferenced blob on
   * disk, but content-addressing makes that at most a few harmless stray
   * bytes, never a correctness or security issue, and never duplicated
   * across two calls the way validating twice would be.
   */
  uploadAttachment(
    companyId: string,
    input: {
      filename: string;
      contentType?: string;
      buffer: Buffer;
      taskId?: string | null;
      projectId?: string | null;
      uploadedBy?: string;
      actorType?: ActorType;
      actorId?: string;
    },
  ): AttachmentRow {
    const blob = this.attachmentStorage.write(companyId, input.buffer);
    return this.attachments.create({
      companyId,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      storageKey: blob.storageKey,
      sha256: blob.sha256,
      uploadedBy: input.uploadedBy,
      actorType: input.actorType,
      actorId: input.actorId,
    });
  }

  readAttachment(companyId: string, attachmentId: string): { row: AttachmentRow; buffer: Buffer } | null {
    const row = this.attachments.get(attachmentId);
    if (!row || row.company_id !== companyId) return null;
    return { row, buffer: this.attachmentStorage.read(row.storage_key) };
  }

  /**
   * Deletes the row, then the blob too — but only once no other row (the
   * content-addressed store can be shared, see attachment-storage.ts)
   * references it any more.
   */
  deleteAttachment(
    companyId: string,
    attachmentId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): boolean {
    const existing = this.attachments.get(attachmentId);
    if (!existing || existing.company_id !== companyId) return false;
    const deleted = this.attachments.delete(attachmentId, opts);
    if (!deleted) return false;
    if (this.attachments.isStorageKeyOrphaned(deleted.storage_key)) {
      this.attachmentStorage.delete(deleted.storage_key);
    }
    return true;
  }

  // --- seeding ------------------------------------------------------------

  /**
   * Create the company, departments and seed crew. Idempotent: running it
   * again on an existing company leaves the data alone.
   */
  seedCompany(input: { name: string; slug: string; crew?: CrewConfig; departments?: DepartmentConfig }): string {
    const existing = this.db.prepare("SELECT id FROM crew_companies WHERE slug = ?").get(input.slug) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;

    const crew = input.crew ?? loadCrewConfig();
    const departments = input.departments ?? loadDepartmentConfig();

    const companyId = newId("cmp");
    this.db
      .prepare("INSERT INTO crew_companies (id, name, slug) VALUES (?,?,?)")
      .run(companyId, input.name, input.slug);

    const deptIds = new Map<string, string>();
    for (const d of departments.departments) {
      const id = newId("dept");
      this.db
        .prepare(
          "INSERT INTO crew_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)",
        )
        .run(id, companyId, d.key, d.name, d.description, d.sort_order);
      deptIds.set(d.key, id);
    }

    for (const agent of crew.agents) {
      this.hireAgent(companyId, agent, deptIds.get(agent.department) ?? null);
    }

    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "bootstrap",
      action: "company.seeded",
      entityType: "company",
      entityId: companyId,
      details: {
        name: input.name,
        departments: departments.departments.length,
        agents: crew.agents.length,
      },
    });

    return companyId;
  }

  /**
   * Seeds one agent as a Vessel × Talent pairing.
   *
   * The YAML still describes a whole agent, which is the right shape for a
   * config file a human edits. Where those fields *land* is what changed: the
   * role, policy and persona become a talent of the agent's own, and the
   * runtime becomes a vessel shared by everyone using that runtime — the same
   * grouping migration 0011 derives for an existing crew.
   */
  /**
   * Adds one post to the company.
   *
   * Public because seeding is no longer the only way a company grows: a
   * business pack hires the specialists its trade needs
   * (server/ironcrew/packs/pack-installer.ts). One definition of "what it
   * means to add a post" — the alternative was an installer with its own
   * three INSERTs, and the copy that drifts is always the one with fewer
   * readers.
   */
  hireAgent(companyId: string, agent: SeedAgent, departmentId: string | null): string {
    const vesselId = this.ensureVessel(companyId, "mock");

    // A role is keyed per company, so an existing one is *the* role rather
    // than a second copy of it. Reused rather than re-inserted because a post
    // can be removed (a pack uninstall does exactly that) while its role
    // survives — and hiring into that role again must not collide with the
    // row the previous holder left behind.
    const existingTalent = this.db
      .prepare("SELECT id FROM crew_talents WHERE company_id = ? AND key = ?")
      .get(companyId, agent.key) as { id: string } | undefined;

    const talentId = existingTalent?.id ?? newId("tal");
    if (!existingTalent) {
      this.db
        .prepare(
          `INSERT INTO crew_talents
             (id, company_id, key, professional_role, role_summary, seniority, policy_json, persona_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          talentId,
          companyId,
          agent.key,
          agent.professional_role,
          agent.role_summary,
          agent.seniority,
          JSON.stringify(agent.policy),
          JSON.stringify(agent.skin),
        );
    }

    const id = newId("agt");
    this.db
      .prepare(
        `INSERT INTO crew_agents
           (id, company_id, department_id, key, display_name, vessel_id, talent_id,
            status, is_executive_assistant)
         VALUES (?,?,?,?,?,?,?,'idle',?)`,
      )
      .run(
        id,
        companyId,
        departmentId,
        agent.key,
        agent.skin.display_name,
        vesselId,
        talentId,
        agent.is_executive_assistant ? 1 : 0,
      );
    return id;
  }

  /** One vessel per runtime per company; created on first use. */
  private ensureVessel(companyId: string, runtimeProvider: string): string {
    const existing = this.db
      .prepare("SELECT id FROM crew_vessels WHERE company_id = ? AND key = ?")
      .get(companyId, runtimeProvider) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = newId("vsl");
    this.db
      .prepare("INSERT INTO crew_vessels (id, company_id, key, label, runtime_provider) VALUES (?,?,?,?,?)")
      .run(id, companyId, runtimeProvider, `${runtimeProvider} (Standard)`, runtimeProvider);
    return id;
  }

  // --- reads --------------------------------------------------------------

  listAgents(companyId: string): AgentRow[] {
    return this.db
      .prepare(`${RESOLVED_AGENT_SELECT} WHERE a.company_id = ? ORDER BY a.key`)
      .all(companyId) as unknown as AgentRow[];
  }

  getAgent(companyId: string, key: string): AgentRow | null {
    return (
      (this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.company_id = ? AND a.key = ?`).get(companyId, key) as
        | AgentRow
        | undefined) ?? null
    );
  }

  executiveAssistant(companyId: string): AgentRow {
    const ea = this.db
      .prepare(`${RESOLVED_AGENT_SELECT} WHERE a.company_id = ? AND a.is_executive_assistant = 1`)
      .get(companyId) as AgentRow | undefined;
    if (!ea) throw new Error("No executive assistant is configured for this company.");
    return ea;
  }

  /** Every runtime registered with this orchestrator, mock and real alike. */
  listRuntimes(): AgentRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Change which registered runtime provider an agent's tasks execute
   * against. Returns null when the agent does not exist in this company —
   * callers translate that to a 404 rather than a validation error, since
   * the provider itself is validated separately (against listRuntimes())
   * before this is ever called.
   */
  setAgentRuntimeProvider(
    companyId: string,
    agentId: string,
    provider: string,
    opts: HumanActor = {},
  ): AgentRow | null {
    const agent = this.db
      .prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ? AND a.company_id = ?`)
      .get(agentId, companyId) as AgentRow | undefined;
    if (!agent) return null;
    if (!this.runtimes.has(provider)) {
      throw new Error(`Unknown runtime provider "${provider}". Registered: ${[...this.runtimes.keys()].join(", ")}`);
    }
    // Moving an agent between runtimes is now moving it into a different
    // vessel — which is the point of the split. The talent it carries (role,
    // policy, persona) is untouched, so the same role really does run
    // somewhere else rather than being redefined there.
    const vesselId = this.ensureVessel(companyId, provider);
    this.db
      .prepare("UPDATE crew_agents SET vessel_id = ?, updated_at = ? WHERE id = ?")
      .run(vesselId, Date.now(), agentId);
    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId: humanActor(opts),
      action: "agent.runtime_changed",
      entityType: "agent",
      entityId: agentId,
      details: { from: agent.runtime_provider, to: provider, vesselId },
    });
    return { ...agent, runtime_provider: provider, vessel_id: vesselId };
  }

  /**
   * Agent status derived from held work — never self-reported, so the UI
   * figure cannot disagree with the backend.
   */
  agentStatus(companyId: string, agentId: string): string {
    const rows = this.db
      .prepare("SELECT status FROM crew_tasks WHERE company_id = ? AND assigned_agent_id = ?")
      .all(companyId, agentId) as unknown as Array<{ status: TaskStatus }>;
    const agent = this.db.prepare("SELECT status FROM crew_agents WHERE id = ?").get(agentId) as
      | { status: string }
      | undefined;
    const lastRun = this.db
      .prepare("SELECT status FROM crew_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(agentId) as { status: string } | undefined;

    return deriveAgentStatus({
      online: agent?.status !== "offline",
      paused: agent?.status === "paused",
      rateLimited: lastRun?.status === "rate_limited" && rows.some((row) => row.status === "waiting"),
      taskStatuses: rows.map((r) => r.status),
      lastRunFailed: lastRun?.status === "failed",
    });
  }

  /** Refresh the persisted agent status from derived state. */
  syncAgentStatuses(companyId: string): void {
    for (const agent of this.listAgents(companyId)) {
      if (agent.status === "paused" || agent.status === "offline") continue;
      const derived = this.agentStatus(companyId, agent.id);
      this.db
        .prepare("UPDATE crew_agents SET status = ?, updated_at = ? WHERE id = ?")
        .run(derived, Date.now(), agent.id);
    }
  }

  // --- conversation -------------------------------------------------------

  ensureCeoConversation(companyId: string): string {
    const existing = this.db
      .prepare("SELECT id FROM crew_conversations WHERE company_id = ? AND kind = 'ceo_ea' LIMIT 1")
      .get(companyId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = newId("conv");
    this.db
      .prepare("INSERT INTO crew_conversations (id, company_id, kind, title) VALUES (?,?, 'ceo_ea', ?)")
      .run(id, companyId, "CEO & Executive Assistant");
    return id;
  }

  private addMessage(input: {
    companyId: string;
    conversationId: string;
    role: "ceo" | "agent" | "system";
    body: string;
    authorAgentId?: string | null;
    taskId?: string | null;
    triage?: TriageResult | null;
    correlationId: string;
  }): string {
    const id = newId("msg");
    this.db
      .prepare(
        `INSERT INTO crew_messages
           (id, company_id, conversation_id, role, author_agent_id, body, task_id, triage_json, correlation_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.conversationId,
        input.role,
        input.authorAgentId ?? null,
        input.body,
        input.taskId ?? null,
        input.triage ? JSON.stringify(input.triage) : null,
        input.correlationId,
      );
    return id;
  }

  listMessages(conversationId: string, limit = 200): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM crew_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(conversationId, limit) as unknown as Array<Record<string, unknown>>;
  }

  // --- the main flow ------------------------------------------------------

  /**
   * Handle a message from the CEO: triage it, and where warranted create a
   * task and delegate it.
   *
   * The EA never approves anything and never executes a sensitive action
   * itself — it raises an approval request and reports back.
   */
  handleCeoMessage(companyId: string, body: string, opts: HumanActor & { projectId?: string } = {}): CeoMessageResult {
    const actorId = humanActor(opts);
    const correlationId = newCorrelationId();
    const conversationId = this.ensureCeoConversation(companyId);
    const ea = this.executiveAssistant(companyId);

    if (opts.projectId && this.projects.get(opts.projectId)?.company_id !== companyId)
      throw new Error("Projekt gehört nicht zu dieser Firma.");
    const result = triage(body);
    const messageId = this.addMessage({
      companyId,
      conversationId,
      role: "ceo",
      body,
      triage: result,
      correlationId,
    });

    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId: actorId,
      action: "ceo.message_received",
      entityType: "message",
      entityId: messageId,
      correlationId,
      details: { category: result.category, confidence: result.confidence, sensitive: result.sensitive },
    });

    // Weak signal: ask rather than guess.
    if (result.needsClarification) {
      const reply =
        "Ich habe die Nachricht erhalten, kann sie aber nicht eindeutig einordnen. " +
        "Soll ich daraus eine Aufgabe machen, oder ist es eine Frage zur direkten Beantwortung?";
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        triage: result,
        correlationId,
      });
      return { conversationId, messageId, triage: result, task: null, assignedAgent: null, reply, correlationId };
    }

    // Status requests are answered from state, not by starting work.
    if (result.category === "status_request") {
      const reply = this.buildStatusSummary(companyId);
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        triage: result,
        correlationId,
      });
      return { conversationId, messageId, triage: result, task: null, assignedAgent: null, reply, correlationId };
    }

    // A project starts with a real EA planning run, never with implicit execution.
    if (result.category === "project") {
      const project = opts.projectId
        ? this.projects.get(opts.projectId)!
        : this.projects.create({
            companyId,
            title: body.split("\n")[0].slice(0, 120),
            summary: body,
            ownerAgentId: ea.id,
            actorType: "owner",
            actorId,
          });
      const task = this.tasks.create({
        companyId,
        projectId: project.id,
        title: `Projektplan: ${project.title}`.slice(0, 160),
        description: body,
        status: "ready",
        assignedAgentId: ea.id,
        createdBy: actorId,
        correlationId,
        riskLevel: "low",
        sensitive: result.sensitive,
      });
      this.projectPlans.create(companyId, project.id, task.id, actorId);
      this.enqueueRun(companyId, task.id, { requestedBy: actorId });
      const reply = `Ich erstelle einen Projektplan für „${project.title}“ mit Aufgaben, Abhängigkeiten, Budget und Abnahmekriterien. Die Projektarbeit beginnt erst nach Ihrer Planfreigabe.`;
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        taskId: task.id,
        triage: result,
        correlationId,
      });
      return { conversationId, messageId, triage: result, task, assignedAgent: ea, reply, correlationId };
    }

    // Create the task.
    const task = this.tasks.create({
      companyId,
      title: body.split("\n")[0].slice(0, 120),
      description: body,
      projectId: opts.projectId,
      status: "ready",
      priority: result.category === "incident" ? "urgent" : "normal",
      riskLevel: result.riskLevel,
      sensitive: result.sensitive,
      createdBy: "owner",
      correlationId,
    });

    // Sensitive work is parked behind an approval before anyone touches it.
    if (result.sensitive) {
      const approval = this.approvals.request(
        companyId,
        {
          approvalType: this.approvalTypeFor(body),
          requestedBy: ea.id,
          summary: `Freigabe erforderlich für: ${task.title}`,
          riskLevel: "high",
          impact: "Sensible Aktion mit rechtlicher oder finanzieller Wirkung.",
          proposedAction: body,
        },
        { taskId: task.id, correlationId },
      );
      this.notifyApprovalRequested(companyId, approval);
      this.tasks.transition(task.id, "approval_required", {
        reason: "sensitive request awaiting owner approval",
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });

      const reply =
        `Das ist eine freigabepflichtige Aktion. Ich habe sie NICHT ausgeführt.\n` +
        `Freigabeanfrage ${approval.id} liegt in Ihrer Decision Inbox.`;
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        taskId: task.id,
        triage: result,
        correlationId,
      });
      return {
        conversationId,
        messageId,
        triage: result,
        task: this.tasks.get(task.id),
        assignedAgent: null,
        reply,
        correlationId,
      };
    }

    // Delegate.
    const agent = result.category === "question" ? ea : this.pickAgent(companyId, result);
    let assigned: AgentRow | null = null;
    let reply: string;

    if (agent && mayDelegateAutonomously(result)) {
      assigned = agent;
      reply =
        `Verstanden. Ich habe die Aufgabe "${task.title}" angelegt und an ` +
        `${agent.display_name} (${agent.professional_role}) delegiert. ` +
        `Sie erhalten das Ergebnis zur Abnahme.`;
    } else if (agent) {
      assigned = agent;
      reply =
        `Verstanden. Ich habe die Aufgabe "${task.title}" angelegt und ${agent.display_name} ` +
        `zugewiesen. Umfang und Vorgehen lege ich Ihnen vor der Ausführung vor.`;
    } else {
      reply =
        `Aufgabe "${task.title}" ist angelegt, aber ich habe noch keinen passenden ` +
        `Verantwortlichen gefunden. Bitte weisen Sie sie zu.`;
    }

    if (assigned) {
      this.tasks.transition(task.id, "assigned", {
        assignedAgentId: assigned.id,
        reason: `delegated by executive assistant (${result.category})`,
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });
      // Return the task to ready so the scheduler's atomic claim owns the
      // assignment decision; delegation records intent, claiming grants it.
      this.tasks.transition(task.id, "ready", {
        reason: "queued for execution",
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });
      // "queued for execution" used to be a hope. Now it is a row: the run
      // request outlives this process, so work delegated at three in the
      // morning is still waiting to be picked up at eight.
      if (mayDelegateAutonomously(result)) this.enqueueRun(companyId, task.id, { requestedBy: actorId });
      else {
        const approval = this.approvals.request(
          companyId,
          {
            approvalType: "production_change",
            requestedBy: ea.id,
            summary: `Vorgehen freigeben: ${task.title}`,
            riskLevel: result.riskLevel,
            proposedAction: task.description,
            impact: "Nicht autonome Aufgabe; Umfang und Ausführung prüfen.",
          },
          { taskId: task.id, correlationId },
        );
        this.notifyApprovalRequested(companyId, approval);
        this.tasks.transition(task.id, "approval_required", {
          reason: "awaiting owner scope approval",
          actorType: "agent",
          actorId: ea.id,
          correlationId,
        });
      }
    }

    this.addMessage({
      companyId,
      conversationId,
      role: "agent",
      authorAgentId: ea.id,
      body: reply,
      taskId: task.id,
      triage: result,
      correlationId,
    });

    return {
      conversationId,
      messageId,
      triage: result,
      task: this.tasks.get(task.id),
      assignedAgent: assigned,
      reply,
      correlationId,
    };
  }

  /**
   * Map a sensitive request to the approval type that gates it.
   *
   * Matching runs on normalised text and on word STARTS only: a trailing \b
   * would reject the inflected forms people actually write ("überweise"),
   * and \b before an umlaut never matches at all.
   */
  private approvalTypeFor(body: string): string {
    const t = normaliseGerman(body);
    const has = (...list: string[]) => list.some((stem) => new RegExp(`(?:^|[^a-z0-9])${stem}`, "i").test(t));

    if (has("ueberweis", "zahlung", "transfer", "iban", "lastschrift", "bezahl")) return "bank_transfer";
    if (has("ustva", "umsatzsteuer", "steuererklaerung", "elster", "finanzamt")) return "tax_filing";
    if (has("vertrag", "nda", "kuendig", "unterschreib", "unterzeichn")) return "contract_execution";
    if (has("produktiv", "production", "live schalten")) return "production_deployment";
    if (has("passwort", "password", "api-key", "api key", "zugangsdaten", "secret")) return "secret_disclosure";
    return "irreversible_data_change";
  }

  /** Choose an agent by department hint, falling back to the COO. */
  private pickAgent(companyId: string, result: TriageResult): AgentRow | null {
    if (result.suggestedDepartment) {
      const row = this.db
        .prepare(
          `${RESOLVED_AGENT_SELECT}
             JOIN crew_departments d ON d.id = a.department_id
            WHERE a.company_id = ? AND d.key = ? AND a.is_executive_assistant = 0
            ORDER BY a.key LIMIT 1`,
        )
        .get(companyId, result.suggestedDepartment) as AgentRow | undefined;
      if (row) return row;
    }
    return this.getAgent(companyId, "coo") ?? null;
  }

  /**
   * "Goals and goal ancestry in the context builder" (docs/ROADMAP.md Phase
   * 2): when a task's project traces up to a strategic goal, tell the agent
   * why the work matters, not only what to do. Returns "" — never a
   * fabricated block — when the task has no project, the project has no
   * goal, or the goal chain cannot be resolved, so a run's prompt never
   * claims strategic context that does not actually exist.
   */
  private buildStrategicContext(projectId: string | null): string {
    if (!projectId) return "";
    const project = this.projects.get(projectId);
    if (!project?.goal_id) return "";
    const chain = this.goals.ancestry(project.goal_id);
    if (chain.length === 0) return "";
    return `\n\n# Strategischer Kontext\nDieser Auftrag dient dem Projekt "${project.title}", das folgendem Ziel folgt:\n${chain.map((g) => g.title).join(" -> ")}`;
  }

  buildStatusSummary(companyId: string): string {
    const counts = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM crew_tasks WHERE company_id = ? GROUP BY status")
      .all(companyId) as unknown as Array<{ status: string; n: number }>;
    const pending = this.approvals.listPending(companyId).length;

    const parts = counts.length ? counts.map((c) => `${c.n}× ${c.status}`).join(", ") : "keine Aufgaben erfasst";
    return `Aktueller Stand: ${parts}. Offene Freigaben: ${pending}.`;
  }

  // --- execution ----------------------------------------------------------

  /**
   * Claim and execute one ready task with the given runtime.
   *
   * Returns null when nothing was claimable or another worker won the race.
   * The budget gate runs before the claim, so a blocked company does not
   * churn task state.
   */
  /**
   * Whether this run may proceed under its vessel's concurrency cap.
   *
   * The check is by *rank*, not by count, and that is deliberate. Counting
   * before inserting is a read-then-write: two dispatchers for two different
   * agents sharing one vessel would both read "one slot free" and both take
   * it. Here the run row is already committed, so both dispatchers see both
   * rows and order them the same way — the earlier one is admitted, the later
   * one backs off. The database resolves the race rather than the timing of
   * two callers.
   *
   * Order is by `rowid` — SQLite's insertion order — and not by `created_at`,
   * which is only millisecond-precise: two runs created in the same
   * millisecond would need a tiebreak, and `id` is a random UUID, so that
   * tiebreak would decide by coin flip which of them counts as "first".
   * A cap that admits or refuses the same situation differently on different
   * runs is worse than no cap, because nobody can reproduce it. `rowid` is
   * monotonic per insert, so "ahead of me" means exactly what it says.
   */
  private vesselAdmits(agent: AgentRow, runId: string, now = Date.now()): boolean {
    if (!agent.vessel_id) return true;
    const limit = Math.max(1, agent.vessel_max_concurrency);

    const rank = this.db
      .prepare(
        `SELECT COUNT(*) AS ahead
           FROM crew_runs r
           JOIN crew_agents a ON a.id = r.agent_id
          WHERE (COALESCE(r.routing_vessel_id,a.vessel_id) = ? OR COALESCE(r.routing_origin_vessel_id,a.vessel_id) = ?)
            AND r.status IN ('queued','running')
            AND COALESCE(r.heartbeat_at, r.created_at) > ?
            AND r.rowid < (SELECT rowid FROM crew_runs WHERE id = ?)`,
      )
      .get(agent.vessel_id, agent.vessel_id, now - VESSEL_RUN_STALE_MS, runId) as { ahead: number };

    const meetings = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM crew_routing_meeting_leases WHERE company_id=? AND (vessel_id=? OR origin_vessel_id=?) AND expires_at>?",
      )
      .get(agent.company_id, agent.vessel_id, agent.vessel_id, now) as { n: number };
    return rank.ahead + meetings.n < limit;
  }

  /**
   * Rebinds an agent to a different vessel, talent, or both.
   *
   * Both ids are re-checked against this company before anything is written.
   * The foreign keys alone would not catch it: `crew_vessels.id` is unique
   * across the database, so binding an agent to *another company's* vessel is
   * a perfectly valid FK and a complete tenancy break. The check has to be
   * here, where the company is known.
   */
  setAgentPairing(
    companyId: string,
    agentId: string,
    pairing: { vesselId?: string; talentId?: string },
    opts: HumanActor = {},
  ): AgentRow | null {
    const agent = this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as AgentRow | undefined;
    if (!agent || agent.company_id !== companyId) return null;

    if (pairing.vesselId !== undefined) {
      const vessel = this.vessels.get(pairing.vesselId);
      if (!vessel || vessel.company_id !== companyId) {
        throw new VesselMutationError(`Vessel "${pairing.vesselId}" gehört nicht zu dieser Firma.`);
      }
    }
    if (pairing.talentId !== undefined) {
      const talent = this.talents.get(pairing.talentId);
      if (!talent || talent.company_id !== companyId) {
        throw new TalentMutationError(`Talent "${pairing.talentId}" gehört nicht zu dieser Firma.`);
      }
    }

    const now = Date.now();
    if (pairing.vesselId !== undefined) {
      this.db
        .prepare("UPDATE crew_agents SET vessel_id = ?, updated_at = ? WHERE id = ?")
        .run(pairing.vesselId, now, agentId);
    }
    if (pairing.talentId !== undefined) {
      this.db
        .prepare("UPDATE crew_agents SET talent_id = ?, updated_at = ? WHERE id = ?")
        .run(pairing.talentId, now, agentId);
    }

    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId: humanActor(opts),
      action: "agent.repaired",
      entityType: "agent",
      entityId: agentId,
      details: {
        vesselId: pairing.vesselId ?? agent.vessel_id,
        talentId: pairing.talentId ?? agent.talent_id,
      },
    });

    return (this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as AgentRow | undefined) ?? null;
  }

  // --- routines: recurring work that leaves a trace -------------------------

  /**
   * Fires every routine that is due, turning each into an ordinary task.
   *
   * A routine deliberately does not act. It asks — in the owner's own words,
   * on a timer — and everything after that is the normal path: the EA
   * triages it, an approval gate stops it if it is sensitive, the budget
   * engine sees the spend, and the board shows it. A scheduler that performed
   * actions directly would be invisible to all four.
   *
   * The limit is per tick, not per routine: a company whose routines all come
   * due at once should produce a queue, not a stampede.
   */
  runDueRoutines(
    companyId: string,
    opts: { limit?: number; now?: number } = {},
  ): {
    fired: number;
    tasks: TaskRow[];
  } {
    const limit = Math.max(1, opts.limit ?? 10);
    const now = opts.now ?? Date.now();
    const tasks: TaskRow[] = [];

    for (let i = 0; i < limit; i++) {
      const routine = this.routines.claimDue(companyId, now);
      if (!routine) break;
      tasks.push(this.taskFromRoutine(companyId, routine, now));
    }

    return { fired: tasks.length, tasks };
  }

  /** Fires one routine now, whatever its schedule says. The operator's "do it now". */
  runRoutineNow(companyId: string, routineId: string): TaskRow | null {
    const routine = this.routines.get(routineId);
    if (!routine || routine.company_id !== companyId) return null;
    return this.taskFromRoutine(companyId, routine, Date.now());
  }

  private taskFromRoutine(companyId: string, routine: RoutineRow, now: number): TaskRow {
    const correlationId = newCorrelationId();
    const classification = triage(routine.instruction);

    // The routine's own text, not a summary of it: an operator reading the
    // task should see exactly what they asked for, and the EA should triage
    // the same words it would have triaged from the chat.
    // Created `ready`, exactly as handleCeoMessage creates a request the owner
    // typed — a routine is the owner asking on a timer, so it enters the
    // board through the same door and the same legal transitions.
    const task = this.tasks.create({
      companyId,
      title: `Routine: ${routine.name}`,
      description: routine.instruction,
      status: "ready",
      projectId: routine.project_id,
      riskLevel: classification.riskLevel,
      sensitive: classification.sensitive,
      createdBy: `routine:${routine.id}`,
      correlationId,
    });
    this.routines.recordTask(routine.id, task.id);

    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: `routine:${routine.id}`,
      action: "routine.fired",
      entityType: "routine",
      entityId: routine.id,
      taskId: task.id,
      correlationId,
      details: { name: routine.name, firedAt: now },
    });

    // A sensitive routine is parked behind an approval exactly like a
    // sensitive request typed into the chat — a timer must not be a way to
    // skip the gate.
    if (classification.sensitive) {
      const approval = this.approvals.request(
        companyId,
        {
          approvalType: this.approvalTypeFor(routine.instruction),
          requestedBy: `routine:${routine.id}`,
          summary: `Freigabe erforderlich für Routine: ${routine.name}`,
          riskLevel: "high",
          impact: "Wiederkehrende Aktion mit rechtlicher oder finanzieller Wirkung.",
          proposedAction: routine.instruction,
        },
        { taskId: task.id, correlationId },
      );
      this.notifyApprovalRequested(companyId, approval);
      this.tasks.transition(task.id, "approval_required", {
        reason: "sensitive routine awaiting owner approval",
        actorType: "system",
        actorId: `routine:${routine.id}`,
        correlationId,
      });
      return this.tasks.get(task.id)!;
    }

    // Otherwise it is delegated and queued like anything else the owner asks
    // for, so it actually runs rather than sitting in the inbox.
    const agent = routine.agent_id
      ? (this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(routine.agent_id) as AgentRow | undefined)
      : this.pickAgent(companyId, classification);

    if (agent) {
      // assigned, then back to ready: the same two steps delegation takes, so
      // the scheduler's atomic claim stays the thing that grants the work.
      this.tasks.transition(task.id, "assigned", {
        assignedAgentId: agent.id,
        reason: `angelegt von Routine "${routine.name}"`,
        actorType: "system",
        actorId: `routine:${routine.id}`,
        correlationId,
      });
      this.tasks.transition(task.id, "ready", {
        reason: "queued for execution",
        actorType: "system",
        actorId: `routine:${routine.id}`,
        correlationId,
      });
      this.enqueueRun(companyId, task.id, { requestedBy: `routine:${routine.id}` });
    }

    this.syncAgentStatuses(companyId);
    return this.tasks.get(task.id)!;
  }

  // --- tools: what an agent may reach for ----------------------------------

  /**
   * Decides whether an agent may use a tool right now, raising an approval
   * when the grant says one is needed.
   *
   * The two halves are deliberately one call. A caller that asked "may I?"
   * and separately "should I request approval?" could act on the first
   * answer and skip the second — and the tools this matters for are exactly
   * the ones that submit forms and spend money.
   *
   * Returns `"denied"` without saying why: the reason is in the audit log for
   * an operator, not in the return value for a caller that might branch on it.
   */
  requestToolUse(
    companyId: string,
    agentId: string,
    toolKey: string,
    context: { taskId?: string | null; runId?: string | null; projectId?: string | null; summary?: string } = {},
  ): { outcome: "allowed" } | { outcome: "denied" } | { outcome: "approval_required"; approvalId: string } {
    const decision: ToolDecision = this.tools.resolve(companyId, agentId, toolKey, {
      projectId: context.projectId ?? null,
    });

    if (!decision.allowed) {
      appendAuditEvent(this.db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "tool.denied",
        entityType: "tool",
        entityId: toolKey,
        taskId: context.taskId ?? null,
        runId: context.runId ?? null,
        outcome: "denied",
        details: { toolKey, reason: decision.reason },
      });
      return { outcome: "denied" };
    }

    if (!decision.requiresApproval) {
      appendAuditEvent(this.db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "tool.used",
        entityType: "tool",
        entityId: decision.tool.id,
        taskId: context.taskId ?? null,
        runId: context.runId ?? null,
        details: { toolKey, riskClass: decision.tool.risk_class, via: decision.via },
      });
      return { outcome: "allowed" };
    }

    const approval = this.approvals.request(
      companyId,
      {
        approvalType: "irreversible_data_change",
        requestedBy: agentId,
        summary: context.summary ?? `Werkzeug "${decision.tool.label || decision.tool.key}" verwenden`,
        riskLevel: decision.tool.risk_class === "external" ? "high" : "medium",
        impact: `Das Werkzeug wirkt ${decision.tool.risk_class === "external" ? "nach außen" : "im Arbeitsbereich"}.`,
        rollbackPlan: "Die Freigabe verweigern; ohne Freigabe wird das Werkzeug nicht verwendet.",
        proposedAction: decision.tool.key,
      },
      { taskId: context.taskId ?? null, runId: context.runId ?? null },
    );
    this.notifyApprovalRequested(companyId, approval);
    return { outcome: "approval_required", approvalId: approval.id };
  }

  /**
   * The tools this server can actually perform, registered once per company.
   *
   * `ensure` rather than `register`: this runs at every boot, and an operator
   * who switched a tool off company-wide must not have it switched back on by
   * a restart. Registering a tool grants nothing — presence is not permission
   * (domain/tool-store.ts) — so booting with all of them is safe and the
   * grants stay the owner's decision.
   */
  ensureBuiltinTools(companyId: string): void {
    const builtins = [
      { key: "web.search", label: "Websuche", riskClass: "read" as const, description: "Sucht im Web." },
      {
        key: "browser.read",
        label: "Browser (lesen)",
        riskClass: "read" as const,
        description: "Öffnet und liest Seiten.",
      },
      {
        key: "browser.interact",
        label: "Browser (bedienen)",
        riskClass: "write" as const,
        description: "Klickt und füllt Felder aus.",
      },
      {
        key: "browser.external",
        label: "Browser (absenden)",
        riskClass: "external" as const,
        description: "Sendet Formulare ab, lädt hoch oder herunter.",
      },
    ];
    for (const tool of builtins) {
      this.tools.ensure({ companyId, origin: "builtin", ...tool }, { actorType: "system", actorId: "boot" });
    }
  }

  /** Tool presence never grants access; the existing owner UI manages grants. */
  ensureRuntimeTools(companyId: string): void {
    for (const key of [...Object.values(COMPANY_RUNTIME_TOOLS), "workspace.read", "workspace.list"]) {
      this.tools.ensure(
        { companyId, key, label: key, riskClass: "read", origin: "builtin" },
        { actorType: "system", actorId: "boot" },
      );
    }
  }

  runtimeToolExecutor(companyId: string) {
    this.ensureRuntimeTools(companyId);
    return createCompanyToolExecutor({
      companyId,
      permitted: async (key, ctx) =>
        this.tools.resolve(companyId, ctx.agentId!, key, { projectId: ctx.projectId }).allowed,
      authorize: async (key, ctx, call) => {
        const task = this.tasks.get(ctx.taskId);
        if (
          !task ||
          task.company_id !== companyId ||
          task.assigned_agent_id !== ctx.agentId ||
          task.project_id !== ctx.projectId
        ) {
          return { status: "denied", reason: "Aufgabe gehört nicht zu diesem Agenten-/Projekt-Scope." };
        }
        const grant = this.tools.resolve(companyId, ctx.agentId!, key, { projectId: ctx.projectId });
        if (!grant.allowed) return { status: "denied", reason: "Werkzeug nicht freigegeben." };
        if (!grant.requiresApproval && key !== "approval.request") return { status: "allowed" };
        const proposedAction = toolApprovalBinding(ctx, key, call.arguments);
        const previous = this.db
          .prepare(
            `
          SELECT id, status, expires_at FROM crew_approvals
          WHERE company_id = ? AND task_id = ? AND requested_by = ? AND proposed_action = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `,
          )
          .get(companyId, ctx.taskId, ctx.agentId, proposedAction) as
          | { id: string; status: string; expires_at: number | null }
          | undefined;
        if (previous?.status === "approved" && (previous.expires_at === null || previous.expires_at > Date.now())) {
          return { status: "allowed", approvalId: previous.id };
        }
        if (previous?.status === "rejected" || previous?.status === "cancelled") {
          return { status: "denied", reason: "Diese konkrete Werkzeugaktion wurde abgelehnt oder widerrufen." };
        }
        return {
          status: "approval_required",
          approvalType: key === "approval.request" ? String(call.arguments.approvalType) : "runtime_tool_use",
          summary:
            key === "approval.request"
              ? String(call.arguments.summary)
              : `Werkzeug ${key} verwenden. Parameter: ${redactText(canonicalToolArguments(call.arguments))}`,
          riskLevel: key === "approval.request" ? String(call.arguments.riskLevel ?? "high") : "medium",
          proposedAction,
        };
      },
      listTasks: async (ctx, limit) =>
        this.tasks
          .list(companyId)
          .filter((t) => !ctx.projectId || t.project_id === ctx.projectId)
          .slice(0, limit),
      readTask: async (ctx, id) => {
        const task = this.tasks.get(id);
        return task?.company_id === companyId && (!ctx.projectId || task.project_id === ctx.projectId) ? task : null;
      },
      searchMemory: async (ctx, query, limit) => {
        const task = this.tasks.get(ctx.taskId);
        if (
          !task ||
          task.company_id !== companyId ||
          task.assigned_agent_id !== ctx.agentId ||
          task.project_id !== ctx.projectId
        ) {
          throw new Error("Ungültiger Aufgaben-Scope für Memory Search.");
        }
        const refs = this.memories
          .list(companyId)
          .filter(
            (r) =>
              (!r.project_id || r.project_id === ctx.projectId) &&
              (!r.task_id || r.task_id === ctx.taskId) &&
              (!r.agent_id || r.agent_id === ctx.agentId) &&
              (["public", "internal"].includes(r.sensitivity) ||
                (r.sensitivity === "confidential" && task.sensitive !== 0)),
          );
        const found: MemorySearchHit[] = [];
        for (const provider of this.memoryProviders.values()) {
          const allowed = new Set(refs.filter((r) => r.provider === provider.kind).map((r) => r.external_id));
          found.push(
            ...(await provider.search(query, limit))
              .filter(
                (hit) =>
                  allowed.has(hit.externalId) &&
                  mayRetrieveMemory(hit.provenance, {
                    companyId,
                    taskId: ctx.taskId,
                    projectId: ctx.projectId,
                    agentId: ctx.agentId,
                    sensitive: task.sensitive !== 0,
                  }),
              )
              .map((hit) => ({
                externalId: redactText(hit.externalId, ctx.redactValues),
                title: redactText(hit.title, ctx.redactValues),
                snippet: redactText(hit.snippet, ctx.redactValues),
                path: hit.path === null ? null : redactText(hit.path, ctx.redactValues),
              })),
          );
        }
        return found.slice(0, limit);
      },
      audit: async (stage, call, ctx, result) => {
        appendAuditEvent(this.db, {
          companyId,
          actorType: "agent",
          actorId: ctx.agentId!,
          action: `runtime.tool.${stage}`,
          entityType: "tool",
          entityId: call.name,
          taskId: ctx.taskId,
          runId: ctx.runId,
          correlationId: ctx.correlationId,
          details: { callId: call.id, arguments: call.arguments, result },
        });
      },
    });
  }

  /**
   * Mirrors the configured MCP servers into the tool registry.
   *
   * An MCP server is a tool source, so it belongs in the same registry behind
   * the same gate rather than in a parallel permission system that would
   * eventually disagree with this one. Risk class `external` by default: an
   * MCP server reaches something outside this process, and what exactly is up
   * to whoever installed it.
   *
   * Servers that disappeared from the configuration are disabled rather than
   * deleted — deleting would silently drop the grants an operator made, so
   * re-adding a server would come back with its access wiped and nobody would
   * know why.
   */
  syncMcpTools(companyId: string, serverNames: readonly string[]): { added: number; disabled: number } {
    let added = 0;
    for (const name of serverNames) {
      const key = `mcp.${name}`;
      if (!this.tools.byKey(companyId, key)) {
        this.tools.register(
          { companyId, key, label: `MCP: ${name}`, riskClass: "external", origin: "mcp" },
          { actorType: "system", actorId: "boot" },
        );
        added++;
      }
    }

    const configured = new Set(serverNames.map((n) => `mcp.${n}`));
    let disabled = 0;
    for (const tool of this.tools.list(companyId)) {
      if (tool.origin === "mcp" && tool.enabled === 1 && !configured.has(tool.key)) {
        this.tools.setEnabled(tool.id, false, { actorType: "system", actorId: "boot" });
        disabled++;
      }
    }
    return { added, disabled };
  }

  registerSearchProvider(provider: SearchProvider): void {
    this.searchProviders.set(provider.kind, provider);
  }

  listSearchProviderKinds(): string[] {
    return [...this.searchProviders.keys()];
  }

  async testSearchProvider(kind: string): Promise<{ ok: boolean; message: string }> {
    const provider = this.searchProviders.get(kind);
    if (!provider) return { ok: false, message: `Kein "${kind}"-Suchanbieter registriert.` };
    return provider.testConnection();
  }

  // --- business packs -----------------------------------------------------
  //
  // Registration happens in the composition root, exactly as it does for
  // runtimes, secret providers and search providers: an adapter exists here
  // only if the operator configured its environment variables, so "is this
  // integration available" is answered by what is registered rather than by a
  // button that is always there and sometimes works.

  /**
   * Installing and removing business packs.
   *
   * Lazy because the installer holds a reference back to this orchestrator
   * (it hires posts through `hireAgent`), and building it in the constructor
   * would mean handing out `this` before the fields below it exist.
   */
  get packs(): PackInstaller {
    this.packInstaller ??= new PackInstaller(this.db, this);
    return this.packInstaller;
  }

  /**
   * Registers the off-box copy of the audit chain.
   *
   * One shipper, not a list. Two sinks would need two cursors — the shipper
   * has a `cursorNamespace` for exactly that — but nothing yet asks for two,
   * and a list here would invite the mistake the namespace exists to prevent:
   * two shippers sharing a cursor, each seeing only the entries the other had
   * not already claimed, leaving a hole in both copies.
   */
  registerAuditShipper(shipper: AuditShipper): void {
    this.auditShipperInstance = shipper;
  }

  /** Null when nobody configured a sink. */
  get auditShipper(): AuditShipper | null {
    return this.auditShipperInstance;
  }

  registerPackIntegration(adapter: PackIntegrationAdapter): void {
    this.packIntegrations.set(adapter.key, adapter);
  }

  getPackIntegration(key: string): PackIntegrationAdapter | undefined {
    return this.packIntegrations.get(key);
  }

  listPackIntegrationKeys(): string[] {
    return [...this.packIntegrations.keys()];
  }

  hasPackIntegration(key: string): boolean {
    return this.packIntegrations.has(key);
  }

  /**
   * Probes one integration.
   *
   * Reports rather than throws, like every other `testConnection` in this
   * codebase: "not configured" is an answer an operator needs on the settings
   * page, not an exception somebody has to catch to display.
   */
  async testPackIntegration(key: string): Promise<IntegrationStatus> {
    const adapter = this.packIntegrations.get(key);
    if (!adapter) {
      return {
        ok: false,
        message: `Die Integration "${key}" ist nicht konfiguriert. Ohne ihre Umgebungsvariablen wird sie nicht geladen.`,
      };
    }
    try {
      return await adapter.testConnection();
    } catch (err) {
      // An adapter that throws from its own probe is a bug in the adapter,
      // and it must not take the settings page down with it.
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A web search on an agent's behalf, through the tool gate.
   *
   * The gate is checked here rather than left to the caller, because a caller
   * that could search without asking is a caller for whom the gate does not
   * exist. The result comes back both raw — for a UI to render as links — and
   * fenced, which is the only form that may reach a prompt: these sentences
   * were written by strangers.
   */
  async searchWeb(
    companyId: string,
    agentId: string,
    query: SearchQuery,
    opts: { kind?: string; projectId?: string | null; taskId?: string | null; runId?: string | null } = {},
  ): Promise<
    | { outcome: "denied" }
    | { outcome: "approval_required"; approvalId: string }
    | { outcome: "ok"; provider: string; results: SearchResult[]; prompt: string }
  > {
    const kind = opts.kind ?? this.listSearchProviderKinds()[0];
    const provider = kind ? this.searchProviders.get(kind) : undefined;
    if (!provider) throw new Error(`Kein "${kind ?? "—"}"-Suchanbieter registriert.`);

    const gate = this.requestToolUse(companyId, agentId, "web.search", {
      taskId: opts.taskId,
      runId: opts.runId,
      projectId: opts.projectId,
      summary: `Websuche: ${sanitiseLine(query.query, 120)}`,
    });
    if (gate.outcome !== "allowed") return gate;

    const results = await provider.search(query);
    return {
      outcome: "ok",
      provider: provider.kind,
      results,
      prompt: wrapSearchResults(results, { provider: provider.kind, query: query.query }),
    };
  }

  // --- the run queue: intent to run, kept until it happened ----------------
  //
  // Everything above creates tasks. Nothing above makes them run: that needed
  // someone to call executeNextTask, which was fine while the only ingress was
  // a person typing into the Command Center and stopped being fine the moment
  // mail and chat could create work at three in the morning.
  //
  // So an ingress records the *intent* to run, durably, and a drain turns
  // intents into runs whenever the company has capacity. The queue is what
  // makes "the server is running as a service" mean something.

  /**
   * Records that a task should run.
   *
   * The attempt budget comes from the agent's vessel — `max_retries + 1`,
   * since the first go is not a retry. That is the fourth vessel column
   * finally doing something: an operator raising retries on a flaky runtime
   * changes how hard the queue tries, without touching the queue.
   */
  enqueueRun(
    companyId: string,
    taskId: string,
    opts: { requestedBy?: string; maxAttempts?: number; notBefore?: number } = {},
  ): { request: RunRequestRow; isNew: boolean } | null {
    const task = this.tasks.get(taskId);
    if (!task || task.company_id !== companyId) return null;

    return this.runRequests.enqueue({
      companyId,
      taskId,
      requestedBy: opts.requestedBy ?? task.created_by,
      maxAttempts: opts.maxAttempts ?? this.attemptBudgetFor(task.assigned_agent_id),
      notBefore: opts.notBefore,
      correlationId: task.correlation_id,
    });
  }

  private attemptBudgetFor(agentId: string | null): number {
    if (!agentId) return 1;
    const agent = this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as AgentRow | undefined;
    // +1 because max_retries counts retries, and the first attempt is not one.
    return agent ? Math.max(1, agent.vessel_max_retries + 1) : 1;
  }

  /**
   * Turns queued intents into runs, until the queue is empty or `limit` is hit.
   *
   * The limit exists because this is called on a timer: an unbounded drain
   * that starts every queued run at once would defeat both the agent lock and
   * the vessel's concurrency cap by making them fight over a hundred
   * simultaneous dispatches instead of a handful.
   *
   * Three outcomes per request, and the difference between the last two is the
   * point of the whole queue:
   *
   *   completed  the run finished; the task moved to review or approval waiting
   *   failed     the run happened and went wrong — that spends an attempt,
   *              and enough of them dead-letter the request for a human
   *   deferred   the run never started because the agent or the vessel was
   *              busy. Nothing was attempted, so nothing is spent; it goes
   *              back on the queue with a short delay.
   */
  async drainRunQueue(
    companyId: string,
    opts: ExecuteOptions & { limit?: number; leaseOwner?: string } = {},
  ): Promise<{ claimed: number; completed: number; failed: number; deferred: number }> {
    const limit = Math.max(1, opts.limit ?? 5);
    const leaseOwner = `${opts.leaseOwner ?? `drain:${process.pid}`}:${newCorrelationId()}`;
    const result = { claimed: 0, completed: 0, failed: 0, deferred: 0 };

    // A drain that crashed mid-run holds a lease nobody will release. Sweeping
    // first means the recovery happens on the next tick rather than needing a
    // restart of the whole service.
    this.runRequests.sweepExpired(companyId);

    for (let i = 0; i < limit; i++) {
      const request = this.runRequests.claimNext(companyId, leaseOwner);
      if (!request) break;
      result.claimed++;

      try {
        const task = this.tasks.get(request.task_id);
        if (!task || task.company_id !== companyId || task.status === "cancelled") {
          this.runRequests.cancel(request.id, { reason: "Aufgabe nicht mehr ausführbar." });
          continue;
        }
        if (task.status === "done" || task.status === "review") {
          this.runRequests.complete(request.id, { leaseOwner });
          result.completed++;
          continue;
        }
        const previousRun = request.run_id ? this.runs.get(request.run_id) : null;
        const retryDue = task.status === "failed" && request.attempts > 1;
        const runnerWaiting =
          previousRun?.status === "waiting" &&
          this.runs
            .listEvents(previousRun.id)
            .some((event) => event.type === "run.waiting" && event.payload.reason === "runner_unavailable");
        const cooldownOver = task.status === "waiting" && (previousRun?.status === "rate_limited" || runnerWaiting);
        // Only the due queue lease may revive these states. An approval or a
        // human blocker must never be interpreted as a retry opportunity.
        const unresolvedApproval = this.db
          .prepare(
            "SELECT 1 FROM crew_approvals WHERE task_id = ? AND status IN ('pending', 'rejected', 'expired') LIMIT 1",
          )
          .get(task.id);
        if ((retryDue || cooldownOver) && !unresolvedApproval) {
          this.tasks.transition(task.id, "ready", {
            expectedVersion: task.status_version,
            reason: cooldownOver ? "Provider-Cooldown beendet" : "Automatischer Wiederholungsversuch nach Backoff",
            actorType: "system",
            actorId: "scheduler",
            correlationId: task.correlation_id,
          });
        }
        const executed = await this.withRunRequestLease(request, () =>
          this.executeTaskById(companyId, request.task_id, opts),
        );

        if (!executed) {
          this.runRequests.defer(request.id, "Nicht startbereit: Agent oder Vessel belegt.", { leaseOwner });
          result.deferred++;
          continue;
        }

        result[this.settleRunRequest(request, executed)]++;
      } catch (err) {
        // An exception here is the drain's own failure, not the runtime's —
        // executeTask already catches those. Spending an attempt is right:
        // whatever broke will break again next tick, and the dead letter is
        // how it becomes visible instead of looping forever.
        if (err instanceof RoutingError && err.status === 503) {
          this.runRequests.defer(request.id, err.message, { leaseOwner });
          result.deferred++;
          continue;
        }
        this.runRequests.fail(request.id, err instanceof Error ? err.message : String(err), { leaseOwner });
        result.failed++;
      }
    }

    return result;
  }

  private async withRunRequestLease<T>(request: RunRequestRow, execute: () => Promise<T>): Promise<T> {
    const heartbeat = setInterval(() => {
      this.runRequests.renew(request.id, request.lease_owner!);
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await execute();
    } finally {
      clearInterval(heartbeat);
    }
  }

  private settleRunRequest(
    request: RunRequestRow,
    executed: { task: TaskRow; runId: string; events: RunEvent[] },
  ): "completed" | "failed" | "deferred" {
    if (executed.task.status === "failed") {
      // The run's own summary is the useful text here; the queue records
      // it so the reason survives on the request a human is looking at.
      this.runRequests.fail(
        request.id,
        this.runs.get(executed.runId)?.error_message || executed.task.result_summary || "Lauf fehlgeschlagen.",
        {
          runId: executed.runId,
          leaseOwner: request.lease_owner!,
        },
      );
      return "failed";
    } else if (
      executed.task.status === "waiting" &&
      executed.events.some((event) => event.type === "run.waiting" && event.payload.reason === "runner_unavailable")
    ) {
      const event = [...executed.events]
        .reverse()
        .find((event) => event.type === "run.waiting" && event.payload.reason === "runner_unavailable");
      const retryAt = event?.payload.retryAt;
      this.runRequests.defer(request.id, "Runner nicht verfügbar: Fortsetzung nach freier Kapazität.", {
        delayMs:
          typeof retryAt === "number" && Number.isFinite(retryAt) ? Math.max(30_000, retryAt - Date.now()) : 30_000,
        runId: executed.runId,
        leaseOwner: request.lease_owner!,
      });
      return "deferred";
    } else if (executed.task.status === "waiting" && this.runs.get(executed.runId)?.status === "rate_limited") {
      const rateLimit = [...executed.events].reverse().find((event) => event.type === "rate_limit.detected");
      const resetAt = rateLimit?.payload.resetAt;
      const now = Date.now();
      const delayMs =
        typeof resetAt === "number" && Number.isFinite(resetAt) ? Math.max(30_000, resetAt - now) : 60_000;
      this.runRequests.defer(request.id, "Provider-Limit: Fortsetzung nach Cooldown.", {
        delayMs,
        now,
        runId: executed.runId,
        leaseOwner: request.lease_owner!,
      });
      return "deferred";
    } else {
      this.runRequests.complete(request.id, { runId: executed.runId, leaseOwner: request.lease_owner! });
      return "completed";
    }
  }

  async executeNextTask(
    companyId: string,
    opts: ExecuteOptions = {},
  ): Promise<{ task: TaskRow; runId: string; events: RunEvent[] } | null> {
    const claimable = this.tasks.findClaimable(companyId);
    if (claimable.length === 0) return null;
    const candidate = claimable[0];
    const intent = this.enqueueRun(companyId, candidate.id);
    if (!intent) return null;
    const leaseOwner = `manual:${process.pid}:${newCorrelationId()}`;
    const request = this.runRequests.claimNext(companyId, leaseOwner, { taskId: candidate.id });
    if (!request) return null;
    try {
      const executed = await this.withRunRequestLease(request, () => this.executeTask(companyId, candidate, opts));
      if (executed) this.settleRunRequest(request, executed);
      else this.runRequests.defer(request.id, "Nicht startbereit: Agent oder Vessel belegt.", { leaseOwner });
      return executed;
    } catch (error) {
      if (error instanceof RoutingError && error.status === 503)
        this.runRequests.defer(request.id, error.message, { leaseOwner });
      else this.runRequests.fail(request.id, error instanceof Error ? error.message : String(error), { leaseOwner });
      throw error;
    }
  }

  /**
   * Executes one *named* task, if it is claimable right now.
   *
   * The queue names a specific task, where `executeNextTask` takes whatever is
   * next — so the claimability check has to happen here rather than at the
   * caller. It deliberately re-uses `findClaimable`, so "claimable" keeps one
   * definition: a drain and a button must not disagree about whether a task
   * may start.
   *
   * Returns null when the task exists but cannot start yet. That is not an
   * error — see `drainRunQueue`, which treats it as "try again shortly"
   * rather than as a failed attempt.
   */
  async executeTaskById(
    companyId: string,
    taskId: string,
    opts: ExecuteOptions = {},
  ): Promise<{ task: TaskRow; runId: string; events: RunEvent[] } | null> {
    const candidate = this.tasks.findClaimable(companyId).find((t) => t.id === taskId);
    if (!candidate) return null;
    return this.executeTask(companyId, candidate, opts);
  }

  /** Re-read after asynchronous preparation, immediately before a new invocation. */
  private admittedVendorRestrictions(
    companyId: string,
    runtimeType: string,
    model?: string,
  ): CompanyPolicyRestrictions {
    const policy = this.companyPolicies.effective(companyId);
    const decision = evaluateRuntimeModel(policy, runtimeType, model);
    if (!decision.allowed) throw new RoutingError("vendor_denied", decision.reason, 403);
    return {
      allowedFamilies: [...policy.allowed_families],
      allowedProviders: [...policy.openrouter.allowed_providers],
    };
  }

  private async resolveWorkspace(
    companyId: string,
    projectId: string | null,
    runtime: AgentRuntime,
    override?: string,
  ): Promise<string> {
    const project = projectId ? this.projects.get(projectId) : null;
    if (project && project.company_id !== companyId) throw new Error("Projekt gehört zu einer anderen Firma.");
    const workspace = override ?? project?.workspace_path;
    if (workspace) {
      if (!path.isAbsolute(workspace)) throw new Error("Projekt-Workspace muss ein absoluter Pfad sein.");
      return path.normalize(workspace);
    }
    // A mock never touches disk. Every real runtime must explicitly declare
    // filesystem independence or receive a configured project workspace.
    if ((await runtime.capabilities()).workspaceRequired === false) return "";
    throw new Error("Kein Projekt-Workspace konfiguriert. Bitte dem Projekt einen absoluten Arbeitsordner zuweisen.");
  }

  private async executeTask(
    companyId: string,
    candidate: TaskRow,
    opts: ExecuteOptions = {},
  ): Promise<{ task: TaskRow; runId: string; events: RunEvent[] } | null> {
    const agentId = candidate.assigned_agent_id;
    if (!agentId) return null;

    let agent = this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as AgentRow | undefined;
    if (!agent || agent.company_id !== companyId) return null;

    if (this.approvals.listPending(companyId).some((approval) => approval.task_id === candidate.id)) return null;
    if (!this.projectPlans.forTask(companyId, candidate.id) && this.careerWorkflow.prepare(companyId, candidate))
      return null;
    const careerInternal = this.career.internalForTask(companyId, candidate.id);
    const rootTaskId = careerInternal?.taskId;
    if (careerInternal && opts.runtimeType)
      throw new Error("Interne Lead-Runs verwenden ausschließlich die Modellzuordnung ihres Mitarbeiters.");
    const originalAgent = agent;
    this.budgets.assertRunPermitted(companyId, {
      rootTaskId,
      agentId,
      taskId: candidate.id,
      projectId: candidate.project_id,
      runtimeType: originalAgent.runtime_provider,
    });
    const binding = this.routing.binding(companyId, agentId);
    let route: RouteSelection | null = null;
    let routedMemory: string | undefined;
    if (binding) {
      if (opts.runtimeType)
        throw new RoutingError(
          "override_denied",
          "Ein gebundenes Profil kann nicht per Dispatch-Override umgangen werden.",
          403,
        );
      if (
        originalAgent.vessel_id &&
        this.routing.activeCount(companyId, originalAgent.vessel_id) >= originalAgent.vessel_max_concurrency
      )
        return null;
      routedMemory = await this.runMemoryContext(companyId, candidate, agentId);
      // Once work has started, retries stay on the route actually used. A
      // provider switch requires a new explicit owner configuration revision.
      const previous = this.db
        .prepare(
          "SELECT routing_vessel_id,runtime_type,model FROM crew_runs WHERE company_id=? AND task_id=? AND routing_profile_key=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(companyId, candidate.id, binding.profile.key) as
        | { routing_vessel_id: string; runtime_type: string; model: string }
        | undefined;
      const targets = [binding.profile.primary!, ...binding.profile.fallbacks];
      const pinnedIndex = previous
        ? targets.findIndex(
            (t) =>
              t.vesselId === previous.routing_vessel_id &&
              t.runtimeType === previous.runtime_type &&
              t.model === previous.model,
          )
        : -1;
      if (previous && (pinnedIndex < 0 || (pinnedIndex > 0 && !binding.profile.allowFallback)))
        throw new RoutingError(
          "route_changed",
          "Bisherige Ausführungsroute passt nicht zur gespeicherten Profilversion.",
        );
      const selectedBinding =
        pinnedIndex >= 0
          ? {
              ...binding,
              profile: { ...binding.profile, primary: targets[pinnedIndex], fallbacks: [], allowFallback: false },
            }
          : binding;
      route = await selectProfileRoute({
        db: this.db,
        store: this.routing,
        budgets: this.budgets,
        runtimes: this.runtimes,
        companyId,
        agentId,
        taskId: candidate.id,
        projectId: candidate.project_id,
        correlationId: candidate.correlation_id,
        binding: selectedBinding,
        sensitive: candidate.sensitive !== 0 || routedMemory.length > 0,
        workspace: (r) => this.resolveWorkspace(companyId, candidate.project_id, r, opts.workspacePath),
      });
      if (pinnedIndex >= 0) route.fallbackIndex = pinnedIndex;
      const vessel = route.vessel;
      agent = {
        ...agent,
        vessel_id: vessel.id,
        vessel_key: vessel.key,
        runtime_provider: route.target.runtimeType,
        vessel_model: route.target.model,
        vessel_timeout_ms: Math.min(originalAgent.vessel_timeout_ms, vessel.timeout_ms),
        vessel_max_concurrency: vessel.max_concurrency,
      };
    }
    const runtimeType = route?.target.runtimeType ?? opts.runtimeType ?? agent.runtime_provider;
    const runtime = route?.runtime ?? this.runtimes.get(runtimeType);
    if (!runtime) throw new Error(`No runtime registered for type "${runtimeType}".`);

    // A provider cooldown applies to its other queued tasks too. The source
    // is durable queue state, so a restart cannot reset the provider's limit.
    const coolingDown = this.db
      .prepare(
        `
      SELECT 1 FROM crew_run_requests q JOIN crew_runs r ON r.id = q.run_id
      WHERE q.company_id = ? AND q.status IN ('queued', 'running')
        AND q.not_before > ? AND r.runtime_type = ? AND r.status = 'rate_limited'
      LIMIT 1
    `,
      )
      .get(companyId, Date.now(), runtimeType);
    if (coolingDown) return null;

    // Pre-dispatch budget gate.
    this.budgets.assertRunPermitted(companyId, {
      rootTaskId,
      agentId,
      projectId: candidate.project_id,
      taskId: candidate.id,
      runtimeType,
    });

    // Consume a grant only after the run owns its task and workspace.
    let permission = resolvePermissionMode({ provider: runtimeType, companyId, taskId: candidate.id });
    let sandboxExpiresAt: number | undefined;
    let sandboxTimer: ReturnType<typeof setTimeout> | undefined;

    // The vessel's model, if it names one. Empty means "whatever the runtime
    // defaults to", which is why it is normalised to undefined rather than
    // passed through as "" — a runtime asked to use a model called "" fails
    // in a way that looks like a broken account rather than a blank field.
    const model = agent.vessel_model.trim() || undefined;

    const run = this.runs.create({
      companyId,
      taskId: candidate.id,
      agentId,
      projectId: candidate.project_id,
      runtimeType,
      model,
      permissionMode: permission.mode,
      sandboxGrantId: permission.grantId ?? null,
      correlationId: candidate.correlation_id,
      routingVesselId: agent.vessel_id,
      routingOriginVesselId: originalAgent.vessel_id,
      routingProfileKey: route?.profileKey,
      routingRevision: route?.revision,
    });

    const claimed = this.tasks.claim({
      taskId: candidate.id,
      runId: run.id,
      agentId,
      expectedVersion: candidate.status_version,
      correlationId: candidate.correlation_id,
    });
    if (!claimed) {
      this.runs.setStatus(run.id, "cancelled");
      return null;
    }

    // One agent, one run. The task claim above stops two workers taking the
    // same task; this stops two *different* tasks being dispatched to the
    // same agent, which would have them share one workspace, one CLI session
    // and one budget — and each would clear the pre-dispatch budget gate
    // without seeing the other's spend.
    //
    // Fail-closed: no lease, no run. The task goes back to `ready` rather
    // than sitting claimed by a run that never happened, so it is picked up
    // again as soon as the agent is free.
    if (!this.agentLocks.acquire(agentId, run.id)) {
      this.tasks.releaseLock(candidate.id, run.id);
      this.tasks.transition(claimed.id, "ready", {
        reason: "agent busy with another run",
        actorType: "system",
        actorId: "scheduler",
        correlationId: claimed.correlation_id,
      });
      this.runs.setStatus(run.id, "cancelled");
      return null;
    }

    // The vessel's own cap, one layer out from the agent lock. The lock says
    // "this agent is busy"; this says "this runtime has no seat free" — five
    // agents sharing one Claude Code vessel are five agents sharing one CLI
    // account and one rate limit, and starting all five at once is how that
    // account gets throttled.
    //
    // Same fail-closed shape as above: the task returns to `ready` and is
    // picked up as soon as a seat frees.
    const companyHasCapacity = this.configuration.admitsTask(companyId, run.id, VESSEL_RUN_STALE_MS);
    if (!companyHasCapacity || !this.vesselAdmits(agent, run.id) || !this.vesselAdmits(originalAgent, run.id)) {
      this.agentLocks.release(agentId, run.id);
      this.tasks.releaseLock(candidate.id, run.id);
      this.tasks.transition(claimed.id, "ready", {
        reason: companyHasCapacity
          ? `vessel "${agent.vessel_key || agent.vessel_id}" is at its concurrency limit`
          : "company is at its concurrency limit",
        actorType: "system",
        actorId: "scheduler",
        correlationId: claimed.correlation_id,
      });
      this.runs.setStatus(run.id, "cancelled");
      return null;
    }

    this.tasks.transition(claimed.id, "running", {
      reason: "run started",
      actorType: "agent",
      actorId: agentId,
      correlationId: claimed.correlation_id,
    });

    const seedAgentGuidance = buildAgentGuidance({
      professional_role: agent.professional_role,
      role_summary: agent.role_summary,
      skin: JSON.parse(agent.persona_json),
      policy: JSON.parse(agent.policy_json),
    });

    const strategicContext = this.buildStrategicContext(candidate.project_id);

    const events: RunEvent[] = [];
    let failed = false;
    let waiting = false;
    let rateLimited = false;
    let runtimeToolApproval = false;
    let summary = "";

    // The vessel's timeout, as an abort signal. Both runtimes already honour
    // `context.signal` — CliAdapterRuntime kills its process tree on it and
    // MockRuntime stops iterating — so the cap is enforced by the thing doing
    // the work rather than by a watchdog that can only notice afterwards.
    const timeoutMs = Math.min(
      agent.vessel_timeout_ms > 0 ? agent.vessel_timeout_ms : DEFAULT_RUN_TIMEOUT_MS,
      this.configuration.effective(companyId).runtime.maxRunTimeoutMs,
    );
    const abort = new AbortController();
    this.activeRuns.set(run.id, { companyId, taskId: candidate.id, abort, runtime });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    // A finished run must not hold the process open for the rest of its
    // vessel's timeout — which, at ten minutes by default, is exactly what an
    // un-unref'd timer would do to a server trying to shut down.
    timer.unref?.();
    const lockHeartbeat = setInterval(() => {
      if (!this.tasks.renewLock(candidate.id, run.id) || !this.agentLocks.renew(agentId, run.id)) {
        abort.abort();
        return;
      }
      this.runs.heartbeat(run.id);
    }, 30_000);
    lockHeartbeat.unref?.();

    /**
     * Records a failure the runtime did not report itself.
     *
     * It goes through the same two channels every other event does — the
     * returned list and `onEvent` — because a failure that only reaches the
     * database is invisible both to the caller that asked for the run and to
     * the websocket the Command Center is listening on. That hole already
     * existed for the catch branch below; a timeout would have inherited it.
     */
    const recordFailure = (payload: Record<string, unknown>): void => {
      const persisted = this.runs.appendEvent({
        companyId,
        runId: run.id,
        taskId: candidate.id,
        projectId: candidate.project_id,
        agentId,
        type: "run.failed",
        payload,
      });
      events.push(persisted);
      opts.onEvent?.(persisted);
      failed = true;
    };

    try {
      const workspacePath = await this.resolveWorkspace(companyId, candidate.project_id, runtime, opts.workspacePath);
      this.runs.setWorkspace(run.id, workspacePath);
      const planning = this.projectPlans.forTask(companyId, candidate.id);
      const grant =
        planning || careerInternal || (route && route.fallbackIndex > 0)
          ? null
          : this.sandboxAccess.consumeForRun({
              companyId,
              taskId: candidate.id,
              agentId,
              projectId: candidate.project_id,
              provider: runtimeType,
              workspacePath,
              runId: run.id,
            });
      permission = resolvePermissionMode({
        provider: runtimeType,
        companyId,
        taskId: candidate.id,
        workspacePath,
        requested: grant ? "elevated" : "restricted",
        grant,
      });
      this.runs.setPermission(run.id, permission.mode, permission.grantId ?? null);
      if (grant && permission.mode === "elevated") {
        sandboxExpiresAt = grant.expiresAt;
        sandboxTimer = setTimeout(
          () => abort.abort(new Error("Sandbox-Freigabe abgelaufen")),
          Math.max(0, grant.expiresAt - Date.now()),
        );
        sandboxTimer.unref?.();
      }
      appendAuditEvent(this.db, {
        companyId,
        actorType: "system",
        actorId: "permission-resolver",
        action: "permission.resolved",
        entityType: "run",
        entityId: run.id,
        taskId: candidate.id,
        correlationId: candidate.correlation_id,
        details: { mode: permission.mode, code: permission.code, grantId: permission.grantId ?? null },
      });
      const approvedGuidance = this.coaching.current(companyId, agentId);
      const coachingContext = approvedGuidance
        ? `\n\n# Vom Owner freigegebenes Coaching (Version ${approvedGuidance.version}; untergeordnet zu Policy und Fachgrenzen)\n${wrapUntrusted(approvedGuidance.guidance, { source: "owner-approved coaching", kind: "guidance" }).text}\nSkill-Referenzen: ${JSON.stringify(approvedGuidance.skills)}`
        : "";
      if (approvedGuidance)
        appendAuditEvent(this.db, {
          companyId,
          actorType: "system",
          actorId: "context-builder",
          action: "coaching.context_used",
          entityType: "run",
          entityId: run.id,
          taskId: candidate.id,
          details: { agentId, version: approvedGuidance.version },
        });
      const planningContext = planning
        ? "\n\n" +
          projectPlanningInstructions(
            this.listAgents(companyId).map((a) => ({ key: a.key, role: a.professional_role })),
          )
        : "";
      const careerContext = this.careerWorkflow.instructions(companyId, candidate.id, agentId);
      const memoryContext = routedMemory ?? (await this.runMemoryContext(companyId, candidate, agentId));
      const input: RunInput = {
        prompt: `${seedAgentGuidance}${coachingContext}${strategicContext}${planningContext}${careerContext ? `\n\n${careerContext}` : ""}\n\n# Aufgabe\n${candidate.description}${candidate.review_notes ? `\n\n# Revision des CEO\n${candidate.review_notes}` : ""}${memoryContext}`,
        model,
        ...(route ? { modelProfile: route.profileKey } : {}),
      };
      const context: RunContext = {
        companyId,
        projectId: candidate.project_id,
        taskId: candidate.id,
        runId: run.id,
        agentId,
        correlationId: candidate.correlation_id,
        workspacePath,
        sensitive: candidate.sensitive !== 0 || memoryContext.length > 0,
        permissionMode: permission.mode,
        sandboxGrantId: permission.grantId,
        sandboxExpiresAt,
        signal: abort.signal,
        allowedTools:
          planning || careerInternal
            ? []
            : ["workspace.read", "workspace.list"].filter((key) => {
                const decision = this.tools.resolve(companyId, agentId, key, { projectId: candidate.project_id });
                return decision.allowed && !decision.requiresApproval;
              }),
      };
      if (route) {
        const currentRoute = this.routing.binding(companyId, agentId);
        if (
          currentRoute?.revision !== route.revision ||
          currentRoute.profile.key !== route.profileKey ||
          workspacePath !== route.workspacePath
        )
          throw new RoutingError("route_changed", "Routing oder Workspace wurde während der Vorbereitung geändert.");
        this.routing.target(companyId, route.target);
        this.budgets.assertRunPermitted(companyId, {
          rootTaskId,
          agentId,
          taskId: candidate.id,
          projectId: candidate.project_id,
          runtimeType,
          provider: runtimeType,
          originRuntimeType: originalAgent.runtime_provider,
          modelVendor: route.target.vendorModel.split("/")[0],
        });
      }
      const sessionRef = this.runs.resumableSession(this.runs.get(run.id)!, workspacePath);
      const canResume = sessionRef && runtime.resumeRun && (await runtime.capabilities()).sessionResume;
      // Workspace, memory and capability discovery may await external work. Re-read
      // career assignment and junior limits after those awaits, before any model starts.
      if (!planning) this.careerWorkflow.assertBeforeStart(companyId, candidate.id, agentId);
      context.vendorRestrictions = this.admittedVendorRestrictions(companyId, runtimeType, model);
      const stream = canResume
        ? runtime.resumeRun!(sessionRef, { ...input, sessionRef }, context)
        : runtime.startRun(input, context);
      if (canResume) {
        appendAuditEvent(this.db, {
          companyId,
          actorType: "system",
          actorId: "orchestrator",
          action: "run.resumed",
          entityType: "run",
          entityId: run.id,
          taskId: candidate.id,
          correlationId: candidate.correlation_id,
          details: { runtimeType, sessionRef },
        });
      }
      for await (const ev of stream) {
        const currentTask = this.tasks.get(candidate.id);
        if (currentTask?.execution_run_id !== run.id || currentTask.status !== "running") {
          abort.abort();
          break;
        }
        const persisted = this.runs.appendEvent({
          companyId,
          runId: run.id,
          taskId: candidate.id,
          projectId: candidate.project_id,
          agentId,
          type: ev.type,
          payload: ev.payload,
          correlationId: ev.correlationId,
        });
        events.push(persisted);
        opts.onEvent?.(persisted);

        this.runs.heartbeat(run.id);

        if (ev.type === "usage.updated") {
          const p = ev.payload as { inputTokens?: number; outputTokens?: number; costMicros?: number };
          this.runs.addUsage(run.id, p.inputTokens ?? 0, p.outputTokens ?? 0, p.costMicros ?? 0);
          this.budgets.recordCost({
            rootTaskId,
            companyId,
            runId: run.id,
            taskId: candidate.id,
            projectId: candidate.project_id,
            agentId,
            runtimeType,
            ...(route
              ? {
                  provider: runtimeType,
                  originRuntimeType: originalAgent.runtime_provider,
                  modelVendor: route.target.vendorModel.split("/")[0],
                }
              : {}),
            // A subscription runtime reports no price; record it as quota.
            kind: (p.costMicros ?? 0) > 0 ? "usage" : "quota",
            inputTokens: p.inputTokens ?? 0,
            outputTokens: p.outputTokens ?? 0,
            costMicros: p.costMicros ?? 0,
          });
          // Usage can arrive between paid model/tool rounds. Stop the
          // iterator before requesting its next event once any applicable
          // monetary hard stop is reached; quota-only events retain cost 0.
          try {
            this.budgets.assertRunPermitted(companyId, {
              rootTaskId,
              agentId,
              projectId: candidate.project_id,
              taskId: candidate.id,
              runtimeType,
              ...(route
                ? {
                    provider: runtimeType,
                    originRuntimeType: originalAgent.runtime_provider,
                    modelVendor: route.target.vendorModel.split("/")[0],
                  }
                : {}),
            });
          } catch (err) {
            abort.abort(err);
            throw err;
          }
        }

        if (ev.type === "message.completed") summary = String((persisted.payload as { text?: string }).text ?? "");
        if (ev.type === "run.failed") failed = true;
        if (ev.type === "run.cancelled") failed = true;
        if (ev.type === "rate_limit.detected") {
          rateLimited = true;
          waiting = true;
        }
        if (ev.type === "run.waiting") waiting = true;
        if (ev.type === "approval.required") {
          const p = ev.payload as {
            approvalType?: string;
            summary?: string;
            riskLevel?: string;
            proposedAction?: string;
          };
          const boundAction = isToolApprovalBinding(p.proposedAction) ? p.proposedAction : undefined;
          if (boundAction) runtimeToolApproval = true;
          const pending = boundAction
            ? (this.db
                .prepare(
                  `
            SELECT id FROM crew_approvals WHERE company_id = ? AND task_id = ? AND requested_by = ?
              AND proposed_action = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
            LIMIT 1
          `,
                )
                .get(companyId, candidate.id, agentId, boundAction, Date.now()) as { id: string } | undefined)
            : undefined;
          if (!pending) {
            const approval = this.approvals.request(
              companyId,
              {
                approvalType: p.approvalType ?? "irreversible_data_change",
                requestedBy: agentId,
                summary: p.summary ?? "Agent requested approval",
                riskLevel: (p.riskLevel as "high") ?? "high",
                proposedAction: boundAction,
              },
              { taskId: candidate.id, runId: run.id, correlationId: candidate.correlation_id },
            );
            this.notifyApprovalRequested(companyId, approval);
          }
        }
      }
    } catch (err) {
      // A timeout reads as an opaque abort from inside the runtime, so name it
      // here instead: "the vessel's limit stopped this" is actionable — raise
      // the limit or split the task — where "aborted" is not.
      recordFailure(
        timedOut
          ? { message: `Zeitlimit des Vessels erreicht (${timeoutMs} ms).`, timedOut: true }
          : { message: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      clearTimeout(timer);
      clearInterval(lockHeartbeat);
      clearTimeout(sandboxTimer);
      this.activeRuns.delete(run.id);
    }

    if (abort.signal.aborted && !failed && !timedOut && this.tasks.get(candidate.id)?.status === "running")
      recordFailure({ message: String(abort.signal.reason ?? "Run abgebrochen") });

    // A runtime that ends its stream quietly on abort would otherwise leave a
    // timed-out run looking like a clean finish waiting for review.
    if (timedOut && !failed) {
      recordFailure({ message: `Zeitlimit des Vessels erreicht (${timeoutMs} ms).`, timedOut: true });
    }

    // A recovered/reassigned task belongs to its successor. A late stream
    // may leave evidence on its own run, but cannot finish the successor's task.
    const heldTask = this.tasks.get(candidate.id);
    if (!heldTask || heldTask.execution_run_id !== run.id || heldTask.status !== "running") {
      this.tasks.releaseLock(candidate.id, run.id);
      this.agentLocks.release(agentId, run.id);
      return { task: heldTask ?? candidate, runId: run.id, events };
    }
    if (rateLimited && !failed) this.runs.setStatus(run.id, "rate_limited");

    this.tasks.releaseLock(candidate.id, run.id);
    // Guarded on run.id, so a run whose lease already expired and was taken
    // over cannot free the new owner's lock on its way out.
    this.agentLocks.release(agentId, run.id);

    if (!failed && !waiting && this.projectPlans.forTask(companyId, candidate.id)) {
      const plan = this.projectPlans.capture(companyId, candidate.id, run.id, summary);
      if (plan.status === "failed") recordFailure({ message: `Projektplan ungültig: ${plan.error}` });
    }
    if (
      !careerInternal &&
      this.career.routingForTask(companyId, candidate.id) &&
      !failed &&
      !waiting &&
      !events.some((e) => e.type === "run.completed")
    )
      recordFailure({ message: "Arbeitsrun wurde nicht vollständig abgeschlossen; keine Bewertung möglich." });
    if (careerInternal && !failed && !waiting) {
      try {
        if (!events.some((e) => e.type === "run.completed"))
          throw new Error("Lead-Run endete ohne bestätigten Abschluss.");
        this.careerWorkflow.capture(companyId, candidate.id, run.id, summary);
      } catch (error) {
        recordFailure({ message: `Lead-Ausgabe ungültig: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (careerInternal && failed)
      this.careerWorkflow.fail(
        companyId,
        candidate.id,
        "Lead-Run fehlgeschlagen; Details im Runverlauf. Eine erneute Ausführung erfordert eine explizite Entscheidung.",
      );
    const current = this.tasks.get(candidate.id)!;
    const target: TaskStatus = failed
      ? "failed"
      : runtimeToolApproval
        ? "approval_required"
        : waiting
          ? "waiting"
          : careerInternal
            ? "done"
            : "review";
    this.tasks.transition(candidate.id, target, {
      expectedVersion: current.status_version,
      reason: `run ${run.id} finished`,
      actorType: "agent",
      actorId: agentId,
      resultSummary: summary || null,
      correlationId: candidate.correlation_id,
    });

    if (target === "review" && !this.projectPlans.forTask(companyId, candidate.id)) {
      this.careerWorkflow.queueReview(companyId, this.tasks.get(candidate.id)!, run.id);
    }
    if (target === "review" && summary) {
      const plan = this.projectPlans.forTask(companyId, candidate.id);
      this.addMessage({
        companyId,
        conversationId: this.ensureCeoConversation(companyId),
        role: "agent",
        authorAgentId: this.executiveAssistant(companyId).id,
        taskId: candidate.id,
        correlationId: candidate.correlation_id,
        body: plan
          ? `Projektplan bereit: ${plan.plan?.goal}. Bitte Aufgaben, Risiken und Budget im Projektplan prüfen und freigeben. Quelle: Run ${run.id}.`
          : `${this.career.reviewForRun(companyId, run.id)?.status === "pending" ? "Ergebnis eingereicht; Lead-Review ausstehend" : this.career.reviewForRun(companyId, run.id)?.status === "owner_required" ? "Ergebnis zur Owner-Abnahme; neutraler Reviewer fehlt" : "Ergebnis zur Abnahme"}: ${candidate.title}\n\n${summary.slice(0, 16000)}\n\nQuelle: ${agent.display_name}, Run ${run.id}.`,
      });
    }
    if (target === "review" && summary && this.memoryProviders.has("obsidian")) {
      try {
        await this.recordMemory(
          companyId,
          "obsidian",
          {
            kind: "summary",
            title: `Run-Ergebnis: ${candidate.title}`,
            content: summary.slice(0, 16000),
            taskId: candidate.id,
            projectId: candidate.project_id,
            agentId,
            source: `run:${run.id} (noch nicht vom CEO abgenommen)`,
            confidence: 0.5,
            sensitivity: candidate.sensitive ? "confidential" : "internal",
          },
          { actorType: "agent", actorId: agentId },
        );
      } catch {
        appendAuditEvent(this.db, {
          companyId,
          actorType: "system",
          actorId: "memory",
          action: "memory.run_result_failed",
          entityType: "run",
          entityId: run.id,
          taskId: candidate.id,
          correlationId: candidate.correlation_id,
          outcome: "failed",
          details: { provider: "obsidian" },
        });
      }
    }

    this.syncAgentStatuses(companyId);
    return { task: this.tasks.get(candidate.id)!, runId: run.id, events };
  }

  /** Atomic plan review: no task tree or budget escapes a failed approval. */
  reviewProjectPlan(
    companyId: string,
    taskId: string,
    decision: "approved" | "rejected",
    opts: HumanActor = {},
  ): TaskRow[] {
    const actorId = humanActor(opts);
    const plan = this.projectPlans.forTask(companyId, taskId);
    const parent = this.tasks.get(taskId);
    if (
      !plan ||
      !parent ||
      parent.company_id !== companyId ||
      parent.status !== "review" ||
      plan.status !== "review" ||
      !plan.plan
    )
      throw new Error("Projektplan ist nicht zur Freigabe bereit.");
    const pendingNotifications: ApprovalRow[] = [];
    this.db.exec("SAVEPOINT approve_project_plan");
    try {
      this.projectPlans.markReviewed(companyId, taskId, decision, actorId);
      const children: TaskRow[] = [];
      if (decision === "approved") {
        const existingBudget = this.db
          .prepare(
            "SELECT limit_micros FROM crew_budgets WHERE company_id=? AND scope_type='project' AND scope_id=? AND active=1 AND hard_stop=1 AND limit_micros>0",
          )
          .get(companyId, plan.project_id);
        if (plan.plan.budgetMicros === 0 && !existingBudget)
          throw new Error("Vor der Planfreigabe ist ein positives Projektbudget mit Hard Stop erforderlich.");
        const ids = new Map<string, string>();
        for (const step of plan.plan.tasks) {
          const agent = this.getAgent(companyId, step.agentKey);
          if (!agent) throw new Error(`Agent nicht verfügbar: ${step.agentKey}`);
          // Model risk labels cannot remove a risk independently recognized by policy.
          const classified = triage(`${step.title} ${step.description}`);
          const sensitive = classified.sensitive || ["high", "critical"].includes(step.riskLevel);
          const child = this.tasks.create({
            companyId,
            projectId: plan.project_id,
            parentTaskId: parent.id,
            title: step.title,
            description: step.description,
            acceptanceCriteria: step.acceptanceCriteria,
            status: "planned",
            assignedAgentId: agent.id,
            createdBy: actorId,
            riskLevel: sensitive ? "high" : step.riskLevel,
            sensitive,
            correlationId: parent.correlation_id,
          });
          ids.set(step.key, child.id);
          children.push(child);
        }
        for (const step of plan.plan.tasks)
          for (const dependency of step.dependsOn)
            this.tasks.addDependency(companyId, ids.get(step.key)!, ids.get(dependency)!, {
              actorType: "owner",
              actorId,
            });
        // A plan adds a hard ceiling, while every existing lower ceiling remains binding.
        const budget = this.db
          .prepare(
            "SELECT limit_micros FROM crew_budgets WHERE company_id=? AND scope_type='project' AND scope_id=? AND active=1 AND window_kind='calendar_month_utc'",
          )
          .get(companyId, plan.project_id) as { limit_micros: number } | undefined;
        const approvedLimit = plan.plan.budgetMicros;
        if (approvedLimit > 0)
          this.budgets.setBudget({
            companyId,
            scopeType: "project",
            scopeId: plan.project_id,
            limitMicros:
              budget && budget.limit_micros > 0 ? Math.min(budget.limit_micros, approvedLimit) : approvedLimit,
            hardStop: true,
          });
        for (const child of children) {
          this.tasks.transition(child.id, "ready", {
            actorType: "owner",
            actorId,
            reason: "Projektplan vom CEO freigegeben",
          });
          if (child.sensitive) {
            const approval = this.approvals.request(
              companyId,
              {
                approvalType: this.approvalTypeFor(child.description),
                requestedBy: child.assigned_agent_id!,
                summary: `Aktion freigeben: ${child.title}`,
                riskLevel: "high",
                proposedAction: child.description,
                impact: "Projektplanfreigabe ersetzt keine Freigabe einer konkreten risikoreichen Aktion.",
              },
              { taskId: child.id, correlationId: parent.correlation_id },
            );
            pendingNotifications.push(approval);
            this.tasks.transition(child.id, "approval_required", {
              actorType: "owner",
              actorId,
              reason: "Separate Aktionsfreigabe erforderlich",
            });
          } else this.enqueueRun(companyId, child.id, { requestedBy: actorId });
        }
      }
      this.tasks.transition(taskId, decision === "approved" ? "done" : "cancelled", {
        actorType: "owner",
        actorId,
        reason: `Projektplan ${decision === "approved" ? "freigegeben" : "abgelehnt"}`,
      });
      this.addMessage({
        companyId,
        conversationId: this.ensureCeoConversation(companyId),
        role: "agent",
        authorAgentId: this.executiveAssistant(companyId).id,
        taskId,
        correlationId: parent.correlation_id,
        body:
          decision === "approved"
            ? `Projektplan freigegeben. ${children.length} Teilaufgaben mit Abhängigkeiten angelegt; sensible Aktionen warten auf separate Freigaben.`
            : "Projektplan abgelehnt. Es wurden keine Teilaufgaben gestartet.",
      });
      this.db.exec("RELEASE approve_project_plan");
      for (const approval of pendingNotifications) {
        try {
          this.notifyApprovalRequested(companyId, approval);
        } catch (error) {
          appendAuditEvent(this.db, {
            companyId,
            actorType: "system",
            actorId: "notification",
            action: "project.plan_notification_failed",
            entityType: "approval",
            entityId: approval.id,
            outcome: "failed",
            details: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      return children.map((child) => this.tasks.get(child.id)!);
    } catch (error) {
      this.db.exec("ROLLBACK TO approve_project_plan");
      this.db.exec("RELEASE approve_project_plan");
      throw error;
    }
  }

  async abortRun(companyId: string, runId: string, reason: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active || active.companyId !== companyId) return;
    active.abort.abort(new Error(reason));
    await active.runtime.cancelRun(runId);
  }

  async changeTaskStatus(
    companyId: string,
    taskId: string,
    status: TaskStatus,
    reason: string,
    opts: HumanActor = {},
  ): Promise<TaskRow | null> {
    const existing = this.tasks.get(taskId);
    if (!existing || existing.company_id !== companyId) return null;
    if (
      status !== "cancelled" &&
      (existing.status === "approval_required" ||
        this.approvals.listPending(companyId).some((approval) => approval.task_id === taskId))
    )
      throw new Error("Offene Freigabe muss zuerst im Freigabeprozess entschieden werden.");
    if (this.projectPlans.forTask(companyId, taskId)?.status === "review" && status === "done")
      throw new Error("Projektplan über Planfreigabe abschließen.");
    const task = this.tasks.transition(taskId, status, {
      reason,
      actorType: "owner",
      actorId: humanActor(opts),
      correlationId: existing.correlation_id,
    });
    if (task && existing.execution_run_id && status !== "running") {
      await this.abortRun(companyId, existing.execution_run_id, reason);
      this.runs.setStatus(existing.execution_run_id, "cancelled", { errorMessage: reason });
    }
    return task;
  }

  /**
   * CEO accepts a result in review. The EA records the outcome and the task
   * is done.
   */
  acceptReview(companyId: string, taskId: string, note = "", opts: HumanActor = {}): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task || task.company_id !== companyId) return null;
    if (this.projectPlans.forTask(companyId, taskId)?.status === "review")
      throw new Error("Projektplan über die Planfreigabe akzeptieren.");
    // A CEO action that does not apply right now is a "no", not a crash:
    // return null so the API answers 409 rather than surfacing a store error.
    if (
      task.status !== "review" ||
      this.approvals.listPending(companyId).some((approval) => approval.task_id === taskId)
    )
      return null;

    const done = this.tasks.transition(taskId, "done", {
      reason: "accepted by CEO",
      actorType: "owner",
      actorId: humanActor(opts),
      reviewNotes: note || null,
      correlationId: task.correlation_id,
    });
    if (!done) return null;

    this.addMessage({
      companyId,
      conversationId: this.ensureCeoConversation(companyId),
      role: "agent",
      authorAgentId: ea.id,
      body: `Abgenommen: "${task.title}". ${task.result_summary ?? ""}`.trim(),
      taskId,
      correlationId: task.correlation_id,
    });
    this.syncAgentStatuses(companyId);
    return done;
  }

  /** CEO requests a revision: the task goes back to ready for another attempt. */
  requestRevision(companyId: string, taskId: string, reason: string, opts: HumanActor = {}): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task || task.company_id !== companyId) return null;
    if (
      task.status === "approval_required" ||
      this.approvals.listPending(companyId).some((approval) => approval.task_id === taskId)
    )
      return null;
    if (!canTransition(task.status, "ready")) return null;

    let revised: TaskRow | null;
    this.db.exec("SAVEPOINT revise_career_task");
    try {
      revised = this.tasks.transition(taskId, "ready", {
        reason: `revision requested: ${reason}`,
        actorType: "owner",
        actorId: humanActor(opts),
        reviewNotes: reason,
        correlationId: task.correlation_id,
      });
      const internal = this.career.internalForTask(companyId, taskId);
      if (revised && internal?.status === "failed") this.career.reopenLink(companyId, internal.id, humanActor(opts));
      this.db.exec("RELEASE revise_career_task");
    } catch (error) {
      this.db.exec("ROLLBACK TO revise_career_task; RELEASE revise_career_task");
      throw error;
    }
    if (!revised) return null;

    // A revision is a new run that has to actually happen; without this the
    // task would sit at `ready` waiting for someone to press a button.
    this.enqueueRun(companyId, taskId, { requestedBy: humanActor(opts) });

    this.addMessage({
      companyId,
      conversationId: this.ensureCeoConversation(companyId),
      role: "agent",
      authorAgentId: ea.id,
      body: `Revision angenommen für "${task.title}". Grund: ${reason}. Ich lasse überarbeiten.`,
      taskId,
      correlationId: task.correlation_id,
    });
    this.syncAgentStatuses(companyId);
    return revised;
  }

  /** Recover tasks whose worker died, so nothing is silently stuck. */
  recoverOrphanedTasks(companyId: string, now = Date.now()): TaskRow[] {
    const recovered: TaskRow[] = [];
    for (const task of this.tasks.findOrphaned(companyId, now)) {
      if (!task.execution_run_id) continue;
      const r = this.tasks.recoverOrphaned(task.id, task.execution_run_id);
      if (r) {
        this.runs.setStatus(task.execution_run_id, "failed", { errorMessage: "worker lost; run orphaned" });
        recovered.push(r);
      }
    }
    return recovered;
  }
}
