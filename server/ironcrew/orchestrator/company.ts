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
import { TaskStore, type TaskRow } from "../domain/task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { appendAuditEvent, type ActorType } from "../domain/audit.ts";
import { canTransition, deriveAgentStatus, type TaskStatus } from "../domain/task-state.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { BudgetEngine } from "../policy/budget-engine.ts";
import { SandboxGrantStore } from "../domain/sandbox-grant-store.ts";
import { GoalStore } from "../domain/goal-store.ts";
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
import { MemoryStore, type MemoryRefRow } from "../domain/memory-store.ts";
import type { MemoryKind, MemoryProvider, MemorySearchHit } from "../memory/memory-provider.ts";
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
import { MarketplaceInstaller, type InstallOptions, type InstallResult } from "../marketplace/marketplace-installer.ts";
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
import type { AgentRuntime, RunEvent } from "../runtime/run-events.ts";

/**
 * An agent as every consumer here needs it: the row plus its talent and vessel
 * followed (see domain/agent-resolution.ts). The name and the field meanings
 * are unchanged from before the Vessel × Talent split — only the storage moved.
 */
export type AgentRow = ResolvedAgentRow;

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

export class CompanyOrchestrator {
  readonly tasks: TaskStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalEngine;
  readonly budgets: BudgetEngine;
  readonly sandboxGrants: SandboxGrantStore;
  readonly goals: GoalStore;
  readonly projects: ProjectStore;
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
  private readonly messengerChannels = new Map<string, MessengerChannel>();
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
    this.tasks = new TaskStore(db);
    this.runs = new RunStore(db);
    this.approvals = new ApprovalEngine(db);
    this.sandboxGrants = new SandboxGrantStore(db);
    this.budgets = new BudgetEngine(db);
    this.goals = new GoalStore(db);
    this.projects = new ProjectStore(db);
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

    const runtimeType = agent.runtime_provider;
    const runtime = this.runtimes.get(runtimeType);
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

    const participantNames = new Map(participants.map((p) => [p.agent_id, p.display_name]));
    const recent = this.meetings.recentTurns(meetingId, CompanyOrchestrator.MEETING_TURN_CONTEXT_WINDOW);
    const transcript =
      recent.length === 0
        ? "(Noch keine Wortmeldungen.)"
        : recent.map((t) => `${participantNames.get(t.agent_id) ?? t.agent_id}: ${t.contribution}`).join("\n");

    const prompt = `${guidance}\n\n# Meeting\nThema: ${meeting.topic}\n\nBisherige Wortmeldungen (letzte ${recent.length}):\n${transcript}\n\nGib deine Wortmeldung kurz und konkret (2-4 Sätze).`;

    const round = meeting.current_round + 1;
    let contribution = "";
    let costMicros = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const ev of runtime.startRun(
        { prompt },
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
          workspacePath: opts.workspacePath ?? "/tmp/iron-crew-workspace",
          permissionMode: "restricted",
        },
      )) {
        if (ev.type === "usage.updated") {
          const p = ev.payload as { inputTokens?: number; outputTokens?: number; costMicros?: number };
          inputTokens += p.inputTokens ?? 0;
          outputTokens += p.outputTokens ?? 0;
          costMicros += p.costMicros ?? 0;
        }
        if (ev.type === "message.completed") contribution = String((ev.payload as { text?: string }).text ?? "");
      }
    } catch (err) {
      contribution = `[Fehler: ${err instanceof Error ? err.message : String(err)}]`;
    }

    if (costMicros > 0 || inputTokens > 0 || outputTokens > 0) {
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
      createdBy: opts.actorId ?? "ceo",
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
  acceptMessengerPairing(companyId: string, pairingId: string, role: PairingRole) {
    const pairing = this.messengerPairings.get(pairingId);
    if (!pairing || pairing.company_id !== companyId) return null;
    return this.messengerPairings.accept(pairingId, role, { actorType: "owner", actorId: "ceo" });
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
    opts: { reason?: string } = {},
  ): ChangeProposalRow | null {
    const proposal = this.changeProposals.get(proposalId);
    if (!proposal || proposal.company_id !== companyId) return null;

    if (proposal.approval_id) {
      this.approvals.decide(proposal.approval_id, decision, "ceo", opts.reason ?? "");
    }
    return this.changeProposals.decide(proposalId, decision, { actorType: "owner", actorId: "ceo", ...opts });
  }

  /**
   * Writes an approved proposal.
   *
   * The approval is re-read here rather than trusted from the proposal row:
   * a decision that was reversed, expired or cancelled after the proposal was
   * marked approved must stop the write, and the approval is where that
   * lives.
   */
  applyChangeProposal(companyId: string, proposalId: string): ApplyResult {
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

    return this.changeProposals.apply(proposalId, { actorType: "owner", actorId: "ceo" });
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
   * Decide a pending approval and, unlike calling `this.approvals.decide()`
   * directly, also leave a durable business record of it: a decision-log
   * entry (distinct from the audit chain — see decision-store.ts) and the
   * matching notification cleared from the inbox. Returns null exactly when
   * `approvals.decide()` would (already decided / does not exist).
   */
  decideApproval(
    companyId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    reason = "",
  ): ApprovalRow | null {
    const approval = this.approvals.decide(approvalId, decision, "ceo", reason);
    if (!approval) return null;

    this.decisions.create({
      companyId,
      title: approval.summary,
      decision,
      context: approval.impact,
      rationale: reason,
      decidedBy: "ceo",
      taskId: approval.task_id,
    });
    this.notifications.markReadByApproval(companyId, approval.id);

    return approval;
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

  async testMemoryProvider(kind: string): Promise<{ ok: boolean; message: string }> {
    const provider = this.memoryProviders.get(kind);
    if (!provider) return { ok: false, message: `No "${kind}" provider is registered on this server.` };
    return provider.testConnection();
  }

  /**
   * Write a memory entry through its provider (real content, e.g. an
   * Obsidian markdown file), then record the resulting reference —
   * provider + externalId + IronCrew provenance — in crew_memory_refs. The
   * provider never sees task/project/agent ids or confidence/sensitivity;
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

    const written = await memoryProvider.write({
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
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
      this.insertAgent(companyId, agent, deptIds.get(agent.department) ?? null);
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
  private insertAgent(companyId: string, agent: SeedAgent, departmentId: string | null): string {
    const vesselId = this.ensureVessel(companyId, "mock");

    const talentId = newId("tal");
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
  setAgentRuntimeProvider(companyId: string, agentId: string, provider: string): AgentRow | null {
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
      actorId: "ceo",
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
      rateLimited: agent?.status === "rate_limited" || lastRun?.status === "rate_limited",
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
  handleCeoMessage(companyId: string, body: string): CeoMessageResult {
    const correlationId = newCorrelationId();
    const conversationId = this.ensureCeoConversation(companyId);
    const ea = this.executiveAssistant(companyId);

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
      actorId: "ceo",
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

    // Create the task.
    const task = this.tasks.create({
      companyId,
      title: body.split("\n")[0].slice(0, 120),
      description: body,
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
    const agent = this.pickAgent(companyId, result);
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
  async executeNextTask(
    companyId: string,
    opts: { runtimeType?: string; workspacePath?: string; onEvent?: (e: RunEvent) => void } = {},
  ): Promise<{ task: TaskRow; runId: string; events: RunEvent[] } | null> {
    const claimable = this.tasks.findClaimable(companyId);
    if (claimable.length === 0) return null;

    const candidate = claimable[0];
    const agentId = candidate.assigned_agent_id;
    if (!agentId) return null;

    const agent = this.db.prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id = ?`).get(agentId) as AgentRow | undefined;
    if (!agent) return null;

    const runtimeType = opts.runtimeType ?? agent.runtime_provider;
    const runtime = this.runtimes.get(runtimeType);
    if (!runtime) throw new Error(`No runtime registered for type "${runtimeType}".`);

    // Pre-dispatch budget gate.
    this.budgets.assertRunPermitted(companyId, {
      agentId,
      projectId: candidate.project_id,
      taskId: candidate.id,
      runtimeType,
    });

    // Elevation is reachable only through a live grant minted from an
    // approved sandbox_elevation approval (SandboxGrantStore). Its mere
    // presence is what the orchestrator "asks" resolvePermissionMode() for —
    // the resolver re-validates company/runtime/task scope and expiry itself
    // and fails closed to "restricted" on any mismatch, so this lookup is a
    // narrowing convenience, never the authority.
    const grant = this.sandboxGrants.findLive({
      companyId,
      provider: runtimeType,
      taskId: candidate.id,
    });
    const permission = resolvePermissionMode({
      provider: runtimeType,
      companyId,
      taskId: candidate.id,
      requested: grant ? "elevated" : "restricted",
      grant,
    });
    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "permission-resolver",
      action: "permission.resolved",
      entityType: "task",
      entityId: candidate.id,
      taskId: candidate.id,
      correlationId: candidate.correlation_id,
      details: { mode: permission.mode, code: permission.code, grantId: permission.grantId ?? null },
    });

    const run = this.runs.create({
      companyId,
      taskId: candidate.id,
      agentId,
      projectId: candidate.project_id,
      runtimeType,
      permissionMode: permission.mode,
      sandboxGrantId: permission.grantId ?? null,
      correlationId: candidate.correlation_id,
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
    let summary = "";

    try {
      for await (const ev of runtime.startRun(
        { prompt: `${seedAgentGuidance}${strategicContext}\n\n# Aufgabe\n${candidate.description}` },
        {
          companyId,
          projectId: candidate.project_id,
          taskId: candidate.id,
          runId: run.id,
          agentId,
          correlationId: candidate.correlation_id,
          workspacePath: opts.workspacePath ?? "/tmp/iron-crew-workspace",
          permissionMode: permission.mode,
        },
      )) {
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
            companyId,
            runId: run.id,
            taskId: candidate.id,
            projectId: candidate.project_id,
            agentId,
            runtimeType,
            // A subscription runtime reports no price; record it as quota.
            kind: (p.costMicros ?? 0) > 0 ? "usage" : "quota",
            inputTokens: p.inputTokens ?? 0,
            outputTokens: p.outputTokens ?? 0,
            costMicros: p.costMicros ?? 0,
          });
        }

        if (ev.type === "message.completed") summary = String((ev.payload as { text?: string }).text ?? "");
        if (ev.type === "run.failed") failed = true;
        if (ev.type === "run.cancelled") failed = true;
        if (ev.type === "run.waiting") waiting = true;
        if (ev.type === "approval.required") {
          const p = ev.payload as { approvalType?: string; summary?: string; riskLevel?: string };
          const approval = this.approvals.request(
            companyId,
            {
              approvalType: p.approvalType ?? "irreversible_data_change",
              requestedBy: agentId,
              summary: p.summary ?? "Agent requested approval",
              riskLevel: (p.riskLevel as "high") ?? "high",
            },
            { taskId: candidate.id, runId: run.id, correlationId: candidate.correlation_id },
          );
          this.notifyApprovalRequested(companyId, approval);
        }
      }
    } catch (err) {
      this.runs.appendEvent({
        companyId,
        runId: run.id,
        taskId: candidate.id,
        agentId,
        type: "run.failed",
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
      failed = true;
    }

    this.tasks.releaseLock(candidate.id, run.id);
    // Guarded on run.id, so a run whose lease already expired and was taken
    // over cannot free the new owner's lock on its way out.
    this.agentLocks.release(agentId, run.id);

    const current = this.tasks.get(candidate.id)!;
    const target: TaskStatus = failed ? "failed" : waiting ? "waiting" : "review";
    this.tasks.transition(candidate.id, target, {
      expectedVersion: current.status_version,
      reason: `run ${run.id} finished`,
      actorType: "agent",
      actorId: agentId,
      resultSummary: summary || null,
      correlationId: candidate.correlation_id,
    });

    this.syncAgentStatuses(companyId);
    return { task: this.tasks.get(candidate.id)!, runId: run.id, events };
  }

  /**
   * CEO accepts a result in review. The EA records the outcome and the task
   * is done.
   */
  acceptReview(companyId: string, taskId: string, note = ""): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // A CEO action that does not apply right now is a "no", not a crash:
    // return null so the API answers 409 rather than surfacing a store error.
    if (!canTransition(task.status, "done")) return null;

    const done = this.tasks.transition(taskId, "done", {
      reason: "accepted by CEO",
      actorType: "owner",
      actorId: "ceo",
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
  requestRevision(companyId: string, taskId: string, reason: string): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!canTransition(task.status, "ready")) return null;

    const revised = this.tasks.transition(taskId, "ready", {
      reason: `revision requested: ${reason}`,
      actorType: "owner",
      actorId: "ceo",
      reviewNotes: reason,
      correlationId: task.correlation_id,
    });
    if (!revised) return null;

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
