/**
 * IronCrew — REST surface.
 *
 * Deliberately self-contained: it takes an Express app, a database handle and
 * a broadcast function, and nothing else. It does not reach into the upstream
 * runtime god-object, so it can be tested headlessly and mounted independently.
 *
 * Every request body is Zod-validated at the boundary. Every write goes
 * through the domain layer, so state-machine validation, atomic claiming,
 * budget gates and audit logging cannot be bypassed by calling the API
 * directly — the same guarantees the UI gets.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CompanyOrchestrator, type AgentRow } from "../orchestrator/company.ts";
import { createCrewAuth, methodGuard, type CrewAuth } from "../auth/crew-auth.ts";
import { BUSINESS_PACKS, findPack } from "../packs/catalog.ts";
import type { BusinessPack } from "../packs/business-pack.ts";
import { PackMutationError } from "../packs/pack-store.ts";
import { registerCrewAuthRoutes } from "./auth-routes.ts";
import { CrewLiveEvents } from "./live-events.ts";
import type { OidcProvider } from "../auth/oidc-provider.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { listAuditEvents, verifyAuditChain } from "../domain/audit.ts";
import { getVendorPolicy, evaluateModel, filterModelCatalogue } from "../policy/vendor-policy.ts";
import { ApprovalRequiredError } from "../policy/approval-policy.ts";
import { ApprovalReviewError, MAX_REQUIRED_APPROVALS } from "../domain/approval-review-store.ts";
import { BudgetExceededError } from "../policy/budget-engine.ts";
import { InvalidTransitionError, TASK_STATUSES } from "../domain/task-state.ts";
import { TaskDependencyError } from "../domain/task-store.ts";
import { GoalMutationError } from "../domain/goal-store.ts";
import { GOAL_STATUSES, InvalidGoalTransitionError } from "../domain/goal-state.ts";
import { ProjectMutationError } from "../domain/project-store.ts";
import {
  InvalidMilestoneTransitionError,
  InvalidProjectTransitionError,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
} from "../domain/project-state.ts";
import { SecretMutationError } from "../domain/secret-store.ts";
import { SecretResolutionError } from "../secrets/secret-provider.ts";
import { AttachmentMutationError } from "../domain/attachment-store.ts";
import { RemoteWorkerMutationError } from "../domain/remote-worker-store.ts";
import { MeetingMutationError } from "../domain/meeting-store.ts";
import { InvalidMeetingTransitionError, MEETING_STATUSES } from "../domain/meeting-state.ts";
import { MemoryMutationError } from "../domain/memory-store.ts";
import { MEMORY_KINDS } from "../memory/memory-provider.ts";
import { registerSandboxRoutes } from "./sandbox-routes.ts";
import { registerCoachingRoutes } from "./coaching-routes.ts";
import { registerCharacterRoutes } from "./character-routes.ts";
import {
  MailboxAccessError,
  MailboxMutationError,
  MAILBOX_ACCESS_LEVELS,
  MAILBOX_KINDS,
} from "../domain/mailbox-store.ts";
import { MarketplaceMutationError, MARKETPLACE_KINDS } from "../domain/marketplace-store.ts";
import { MarketplaceSourceError } from "../marketplace/marketplace-source.ts";
import { MarketplaceInstallError } from "../marketplace/marketplace-installer.ts";
import { MessengerPairingError, PAIRING_ROLES } from "../domain/messenger-pairing-store.ts";
import { MessengerChannelError } from "../notify/messenger-channel.ts";
import { ChangeProposalError, CHANGE_PROPOSAL_STATUSES } from "../domain/change-proposal-store.ts";
import { VesselMutationError } from "../domain/vessel-store.ts";
import { TalentMutationError, SENIORITY_LEVELS } from "../domain/talent-store.ts";
import { RunRequestError, RUN_REQUEST_STATUSES } from "../domain/run-request-store.ts";
import type { JobStatus } from "../scheduler/scheduler.ts";
import { ToolMutationError } from "../domain/tool-store.ts";
import { RoutineMutationError } from "../domain/routine-store.ts";
import { SearchProviderError } from "../search/search-provider.ts";
import type { RunEvent } from "../runtime/run-events.ts";

export type Broadcast = (type: string, payload: unknown) => void;

const ceoMessageSchema = z.object({
  projectId: z.string().min(1).optional(),
  body: z.string().min(1).max(20000),
});
const reviewSchema = z.object({ note: z.string().max(5000).optional() });
const revisionSchema = z.object({ reason: z.string().min(1).max(5000) });
const taskStatusSchema = z.object({ status: z.enum(TASK_STATUSES), reason: z.string().max(2000).optional() });
const taskDependencySchema = z.object({ dependsOnId: z.string().min(1).max(200) });
const quorumSchema = z.object({
  // The upper bound lives in the store (a quorum nobody can satisfy is a
  // deadlock dressed as diligence); repeated here so a typo is refused at the
  // edge with a field name attached rather than as a domain error.
  required: z.number().int().min(1).max(MAX_REQUIRED_APPROVALS),
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(5000).optional(),
});
const budgetSchema = z.object({
  scopeType: z.enum(["company", "agent", "project", "task", "runtime", "provider"]),
  scopeId: z.string().max(200).optional(),
  limitMicros: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(100).optional(),
  hardStop: z.boolean().optional(),
});
const modelCheckSchema = z.object({
  model: z.string().min(1).max(200),
  provider: z.string().max(200).optional(),
});
const setAgentRuntimeSchema = z.object({ runtimeProvider: z.string().min(1).max(100) });
const createGoalSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  parentId: z.string().max(200).nullable().optional(),
});
const updateGoalSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
});
const goalStatusSchema = z.object({ status: z.enum(GOAL_STATUSES) });
const goalReparentSchema = z.object({ parentId: z.string().max(200).nullable() });
const createProjectSchema = z.object({
  title: z.string().min(1).max(500),
  key: z.string().min(1).max(200).optional(),
  summary: z.string().max(20000).optional(),
  goalId: z.string().max(200).nullable().optional(),
  ownerAgentId: z.string().max(200).nullable().optional(),
  workspacePath: z.string().max(2000).nullable().optional(),
});
const updateProjectSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(20000).optional(),
  goalId: z.string().max(200).nullable().optional(),
  ownerAgentId: z.string().max(200).nullable().optional(),
  workspacePath: z.string().max(2000).nullable().optional(),
});
const projectStatusSchema = z.object({ status: z.enum(PROJECT_STATUSES) });
const createMilestoneSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  dueAt: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const updateMilestoneSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
  dueAt: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const milestoneStatusSchema = z.object({ status: z.enum(MILESTONE_STATUSES) });
const createSecretSchema = z.object({
  name: z.string().min(1).max(200),
  provider: z.enum(["vaultwarden", "protonpass", "keychain"]),
  itemRef: z.string().min(1).max(500),
  field: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});
const updateSecretSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  itemRef: z.string().min(1).max(500).optional(),
  field: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).optional(),
});
// 8MB decoded, generously rounded up for base64 overhead (~4/3x) — the
// authoritative cutoff is the decoded byte length checked in the upload
// route itself; this just bounds how much undecoded JSON the parser has to
// accept, comfortably under express.json()'s 12mb body limit (server/security/auth.ts).
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const uploadAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(500),
    contentType: z.string().max(200).optional(),
    dataBase64: z.string().min(1).max(11_200_000),
    taskId: z.string().max(200).optional(),
    projectId: z.string().max(200).optional(),
  })
  .refine((v) => !(v.taskId && v.projectId), {
    message: "An attachment may be scoped to a task or a project, not both.",
  });
const createRemoteWorkerSchema = z.object({
  label: z.string().min(1).max(200),
  environment: z.string().max(200).optional(),
  host: z.string().min(1).max(500),
  port: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).max(200),
  privateKeyPath: z.string().min(1).max(1000),
  knownHostsPolicy: z.enum(["strict", "accept"]).optional(),
  notes: z.string().max(2000).optional(),
});
const createMeetingSchema = z.object({
  topic: z.string().min(1).max(500),
  moderatorAgentId: z.string().min(1).max(200),
  participantAgentIds: z.array(z.string().min(1).max(200)).min(1),
  projectId: z.string().max(200).nullable().optional(),
  maxRounds: z.number().int().min(1).max(50).optional(),
  budgetMicros: z.number().int().nonnegative().optional(),
});
const meetingTurnSchema = z.object({ agentId: z.string().min(1).max(200).optional() });
const meetingEndSchema = z.object({ minutes: z.string().max(20000).optional() });
const createActionItemSchema = z.object({
  description: z.string().min(1).max(2000),
  assignedAgentId: z.string().max(200).nullable().optional(),
});
const mailboxCredentialsSchema = z.object({
  password: z.string().max(2000).optional(),
  bearerToken: z.string().max(4000).optional(),
  clientSecret: z.string().max(2000).optional(),
  refreshToken: z.string().max(4000).optional(),
});
const createMailboxSchema = z.object({
  label: z.string().min(1).max(200),
  kind: z.enum(MAILBOX_KINDS),
  emailAddress: z.string().min(1).max(320),
  host: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useTls: z.boolean().optional(),
  username: z.string().max(320).optional(),
  smtpHost: z.string().max(500).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  sessionUrl: z.string().max(2000).optional(),
  tenantId: z.string().max(200).optional(),
  clientId: z.string().max(200).optional(),
  credentials: mailboxCredentialsSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().min(30).max(86_400).optional(),
  autoTriage: z.boolean().optional(),
});
const updateMailboxSchema = createMailboxSchema.partial().omit({ kind: true });
const grantMailboxAgentSchema = z.object({
  agentId: z.string().min(1).max(200),
  access: z.enum(MAILBOX_ACCESS_LEVELS).optional(),
});
const createMarketplaceSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(MARKETPLACE_KINDS),
  url: z.string().min(1).max(2048),
  enabled: z.boolean().optional(),
});

// The kind decides how the URL is parsed, so it stays fixed for the life of
// a source — changing it would silently reinterpret the same URL.
const updateMarketplaceSchema = createMarketplaceSchema.partial().omit({ kind: true });

const createRoutineSchema = z.object({
  name: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20000),
  intervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 31),
  agentId: z.string().min(1).max(200).nullish(),
  projectId: z.string().min(1).max(200).nullish(),
  enabled: z.boolean().optional(),
});
const updateRoutineSchema = createRoutineSchema.omit({ enabled: true }).partial();

const grantToolSchema = z
  .object({
    agentId: z.string().min(1).max(200).optional(),
    talentId: z.string().min(1).max(200).optional(),
    projectId: z.string().min(1).max(200).optional(),
    requiresApproval: z.boolean().nullable().optional(),
    // Waiving the gate on a tool that reaches outside is a sentence someone
    // wrote, not a field someone forgot — so it needs its own flag here too.
    allowUnapprovedExternal: z.boolean().optional(),
  })
  .refine((v) => [v.agentId, v.talentId, v.projectId].filter(Boolean).length === 1, {
    message: "Genau eines von agentId, talentId oder projectId angeben.",
  });
const toolEnabledSchema = z.object({ enabled: z.boolean() });
const agentToolsQuerySchema = z.object({ projectId: z.string().min(1).max(200).optional() });
const searchSchema = z.object({
  agentId: z.string().min(1).max(200),
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional(),
  language: z.string().max(20).optional(),
  safeSearch: z.enum(["off", "moderate", "strict"]).optional(),
  kind: z.string().max(50).optional(),
  projectId: z.string().min(1).max(200).optional(),
  taskId: z.string().min(1).max(200).optional(),
});

const createVesselSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().max(200).optional(),
  runtimeProvider: z.string().min(1).max(120),
  model: z.string().max(200).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000)
    .optional(),
  maxRetries: z.number().int().min(0).max(20).optional(),
  maxConcurrency: z.number().int().min(1).max(100).optional(),
});
// `key` is omitted rather than made optional: renaming a vessel's key would
// silently orphan anything that referred to it by key.
const updateVesselSchema = createVesselSchema.omit({ key: true }).partial();

const createTalentSchema = z.object({
  key: z.string().min(1).max(120),
  professionalRole: z.string().min(1).max(200),
  roleSummary: z.string().max(2000).optional(),
  seniority: z.enum(SENIORITY_LEVELS).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  persona: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(z.string().max(200)).max(100).optional(),
});
const updateTalentSchema = createTalentSchema.omit({ key: true }).partial();

const agentPairingSchema = z
  .object({ vesselId: z.string().min(1).max(200).optional(), talentId: z.string().min(1).max(200).optional() })
  .refine((v) => v.vesselId !== undefined || v.talentId !== undefined, {
    message: "Mindestens vesselId oder talentId angeben.",
  });

const listRunQueueSchema = z.object({
  status: z.enum(RUN_REQUEST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const drainRunQueueSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

const acceptPairingSchema = z.object({ role: z.enum(PAIRING_ROLES) });
const changeProposalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(5000).optional(),
});
const listChangeProposalsSchema = z.object({
  status: z.enum(CHANGE_PROPOSAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const listExternalEventsSchema = z.object({
  sourceKind: z.string().max(200).optional(),
  unhandled: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const installEntrySchema = z.object({
  entryId: z.string().min(1).max(400),
  /** Values for the variables the entry declared but could not carry. */
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Install under a different local name, e.g. to avoid a clash. */
  name: z.string().min(1).max(80).optional(),
});

const sendMailSchema = z.object({
  to: z.array(z.string().min(1).max(320)).min(1).max(50),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(100_000),
  inReplyTo: z.string().max(500).optional(),
  /** When set, the send is performed as that agent and needs its grant. */
  agentId: z.string().max(200).optional(),
});
const createMemorySchema = z.object({
  provider: z.string().min(1).max(100),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(200_000),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  taskId: z.string().max(200).nullable().optional(),
  projectId: z.string().max(200).nullable().optional(),
  agentId: z.string().max(200).nullable().optional(),
  source: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["internal", "confidential", "public"]).optional(),
});

/** Translate domain errors into honest HTTP statuses rather than a blanket 500. */
function sendDomainError(res: Response, err: unknown): boolean {
  if (err instanceof ApprovalRequiredError) {
    res.status(403).json({
      error: "approval_required",
      message: err.message,
      approvalId: err.approvalId,
      approvalType: err.approvalType,
    });
    return true;
  }
  if (err instanceof ApprovalReviewError) {
    // Covers the second vote from one person, a vote on an approval that has
    // already been decided, and an out-of-range quorum. All of them are the
    // caller asking for something that cannot be, so 409 rather than 500 —
    // and the message is the store's German sentence, which already explains
    // itself to whoever is looking at the screen.
    res.status(409).json({ error: "invalid_approval_review", message: err.message });
    return true;
  }
  if (err instanceof BudgetExceededError) {
    res.status(402).json({
      error: "budget_exceeded",
      message: err.message,
      scopeType: err.scopeType,
      scopeId: err.scopeId,
    });
    return true;
  }
  if (err instanceof InvalidTransitionError) {
    res.status(409).json({ error: "invalid_transition", message: err.message });
    return true;
  }
  if (err instanceof TaskDependencyError) {
    res.status(400).json({ error: "invalid_task_dependency", message: err.message });
    return true;
  }
  if (err instanceof InvalidGoalTransitionError) {
    res.status(409).json({ error: "invalid_goal_transition", message: err.message });
    return true;
  }
  if (err instanceof GoalMutationError) {
    res.status(400).json({ error: "invalid_goal_mutation", message: err.message });
    return true;
  }
  if (err instanceof InvalidProjectTransitionError) {
    res.status(409).json({ error: "invalid_project_transition", message: err.message });
    return true;
  }
  if (err instanceof InvalidMilestoneTransitionError) {
    res.status(409).json({ error: "invalid_milestone_transition", message: err.message });
    return true;
  }
  if (err instanceof ProjectMutationError) {
    res.status(400).json({ error: "invalid_project_mutation", message: err.message });
    return true;
  }
  if (err instanceof SecretMutationError) {
    res.status(400).json({ error: "invalid_secret_mutation", message: err.message });
    return true;
  }
  // SecretResolutionError is deliberately NOT mapped here — the one place it
  // can be thrown from a route (POST /secrets/:id/test) catches it locally
  // and reports {ok:false, message} with a 200, since "the vault couldn't
  // resolve this ref right now" is a status the UI displays, not a client
  // request error.
  if (err instanceof AttachmentMutationError) {
    res.status(400).json({ error: "invalid_attachment_mutation", message: err.message });
    return true;
  }
  if (err instanceof RemoteWorkerMutationError) {
    res.status(400).json({ error: "invalid_remote_worker_mutation", message: err.message });
    return true;
  }
  if (err instanceof InvalidMeetingTransitionError) {
    res.status(409).json({ error: "invalid_meeting_transition", message: err.message });
    return true;
  }
  if (err instanceof MeetingMutationError) {
    res.status(400).json({ error: "invalid_meeting_mutation", message: err.message });
    return true;
  }
  if (err instanceof MemoryMutationError) {
    res.status(400).json({ error: "invalid_memory_mutation", message: err.message });
    return true;
  }
  // A refused grant is not a malformed request — it is a permission answer.
  if (err instanceof MailboxAccessError) {
    res.status(403).json({ error: "mailbox_access_denied", message: err.message });
    return true;
  }
  if (err instanceof MailboxMutationError) {
    res.status(400).json({ error: "invalid_mailbox_mutation", message: err.message });
    return true;
  }
  if (err instanceof MarketplaceMutationError) {
    res.status(400).json({ error: "invalid_marketplace_mutation", message: err.message });
    return true;
  }
  // The request was fine; someone else's server was not. 502 says which of
  // the two failed, where a 400 would blame the caller for a broken catalog.
  if (err instanceof MarketplaceSourceError) {
    res.status(502).json({ error: "marketplace_unreachable", message: err.message });
    return true;
  }
  // A refused install is a policy answer about this machine (an unallowed
  // launcher, an oversized skill), not a malformed request body.
  if (err instanceof MarketplaceInstallError) {
    res.status(422).json({ error: "install_refused", message: err.message });
    return true;
  }
  // Pairing refusals are state answers ("this sender is blocked"), not bad
  // requests: 409 so a UI can say what happened instead of blaming the form.
  if (err instanceof MessengerPairingError) {
    res.status(409).json({ error: "invalid_pairing_transition", message: err.message });
    return true;
  }
  // Same split as MarketplaceSourceError: the caller was fine, the chat
  // provider was not.
  if (err instanceof MessengerChannelError) {
    res.status(502).json({ error: "messenger_unreachable", message: err.message });
    return true;
  }
  // Refusing to write is the feature. 409 rather than 400 because the
  // request was well-formed and the *gate* is what said no.
  if (err instanceof ChangeProposalError) {
    res.status(409).json({ error: "change_proposal_refused", message: err.message });
    return true;
  }
  // A vessel or talent that agents still hold refuses to be deleted, and the
  // message names them — 409, because the request was fine and the *state* is
  // what said no.
  if (err instanceof PackMutationError) {
    res.status(409).json({ error: "invalid_pack_mutation", message: err.message });
    return true;
  }
  if (err instanceof VesselMutationError || err instanceof TalentMutationError) {
    res.status(409).json({ error: "invalid_pairing_mutation", message: err.message });
    return true;
  }
  if (err instanceof RunRequestError) {
    res.status(409).json({ error: "invalid_run_request_transition", message: err.message });
    return true;
  }
  if (err instanceof RoutineMutationError) {
    res.status(400).json({ error: "invalid_routine_mutation", message: err.message });
    return true;
  }
  if (err instanceof ToolMutationError) {
    res.status(409).json({ error: "invalid_tool_mutation", message: err.message });
    return true;
  }
  // The request was fine; the search provider on the other end was not.
  if (err instanceof SearchProviderError) {
    res.status(502).json({ error: "search_unreachable", message: err.message });
    return true;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", issues: err.issues });
    return true;
  }
  return false;
}

/** Express 5 types params as `string | string[]`; routes here take one value. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function wrap(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!sendDomainError(res, err)) next(err);
    }
  };
}

/**
 * What the API needs from the background scheduler.
 *
 * Narrowed to two methods rather than taking the Scheduler itself: the routes
 * are mounted before the scheduler exists (it needs the company id this
 * function returns), so this is resolved lazily through a callback. Keeping
 * the surface tiny also keeps the API from growing a dependency on the loop's
 * internals.
 */
export interface SchedulerHandle {
  status(): JobStatus[];
  runNow(name: string): Promise<JobStatus>;
}

export interface IronCrewApiOptions {
  db: DatabaseSync;
  broadcast?: Broadcast;
  /** Company slug this installation operates. */
  companySlug?: string;
  companyName?: string;
  orchestrator?: CompanyOrchestrator;
  /** Resolved per request; absent means IRONCREW_SCHEDULER=off. */
  scheduler?: () => SchedulerHandle | null;
  /** Injectable so a test can drive the guards without a second database. */
  auth?: CrewAuth;
  /**
   * The directory, when an operator configured one. Absent means the password
   * login is the only door — which is the correct default for a self-hosted
   * single-operator box.
   */
  oidc?: OidcProvider | null;
}

export interface IronCrewApi {
  orchestrator: CompanyOrchestrator;
  companyId: string;
  auth: CrewAuth;
  /** Also used by scheduler/native-worker callbacks; never send to legacy WS. */
  broadcast: Broadcast;
}

export function registerIronCrewRoutes(app: Express, opts: IronCrewApiOptions): IronCrewApi {
  const { db } = opts;

  const orchestrator = opts.orchestrator ?? new CompanyOrchestrator(db);
  if (!opts.orchestrator) orchestrator.registerRuntime(new MockRuntime());

  const companyId = orchestrator.seedCompany({
    name: opts.companyName ?? "IronCrew",
    slug: opts.companySlug ?? "iron-crew",
  });

  const live = new CrewLiveEvents(companyId);
  const broadcast: Broadcast = (type, payload) => {
    live.publish(type, payload);
    // Optional observer for embedding/tests. Production uses only the
    // authenticated SSE channel, never the shared legacy WebSocket.
    opts.broadcast?.(type, payload);
  };
  const base = "/api/crew";

  // --- identity -----------------------------------------------------------
  //
  // Order matters and is the whole design (server/ironcrew/auth/crew-auth.ts):
  //
  //   1. `identify` runs for everything under /api/crew and never rejects, so
  //      even the login endpoint knows whether someone is already signed in.
  //   2. the auth routes register next, carrying their own guards — logging in
  //      must not require being logged in.
  //   3. the blanket guards come after, so every route below is covered
  //      without 135 individual registrations to keep in sync. The endpoint
  //      somebody forgets to add to a list is the one that ends up open.
  //
  // While `crew_users` is empty nothing changes for an existing installation:
  // the guards let every request through, because there is no person to name
  // and the shared password (server/security/auth.ts) is still the only
  // credential. Creating the first account switches the surface over in the
  // same instant.
  const auth = opts.auth ?? createCrewAuth(db);
  app.use(base, auth.identify);
  registerCrewAuthRoutes(app, { base, auth, oidc: opts.oidc ?? null });
  app.use(base, auth.requireUser);
  app.use(base, methodGuard(auth));
  app.get(`${base}/events`, (req, res) => live.connect(req, res, auth));
  // Cover successful writes even where an older route has no specific event.
  // Domain background jobs use the same broadcast function below.
  app.use(base, (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res.once("finish", () => {
        if (res.statusCode < 400) broadcast("crew_state_changed", {});
      });
    }
    next();
  });

  /** Who to record for this request — a real user id once anyone is signed in. */
  const actorOf = (req: Request) => auth.actorOf(req);

  /**
   * Endpoints that need more than "may change things".
   *
   * Approving is the owner's alone (docs/THREAT_MODEL.md T-01), and so is
   * anything that hands out authority: a vault secret, a tool grant, a chat
   * pairing that reaches the CEO path. An operator runs the company; an owner
   * decides what the company is allowed to do.
   */
  const ownerOnly = auth.requireRole("owner");
  registerCharacterRoutes(app, { db, companyId, auth, base });
  registerCoachingRoutes(app, { db, companyId, auth, base });
  registerSandboxRoutes(app, {
    db,
    companyId,
    auth,
    base,
    service: orchestrator.sandboxAccess,
    onRevoke: (grant) =>
      grant.consumed_run_id
        ? orchestrator.abortRun(companyId, grant.consumed_run_id, "Sandbox-Freigabe widerrufen")
        : undefined,
  });
  app.get(
    `${base}/project-plans`,
    wrap((_req, res) => {
      res.json({ plans: orchestrator.projectPlans.list(companyId) });
    }),
  );
  app.post(
    `${base}/project-plans/:taskId/review`,
    ownerOnly,
    wrap((req, res) => {
      const { decision } = z
        .object({ decision: z.enum(["approved", "rejected"]) })
        .strict()
        .parse(req.body);
      res.json({ tasks: orchestrator.reviewProjectPlan(companyId, param(req, "taskId"), decision, actorOf(req)) });
    }),
  );

  // --- company / org ------------------------------------------------------

  app.get(
    `${base}/company`,
    wrap((_req, res) => {
      const company = db.prepare("SELECT * FROM crew_companies WHERE id = ?").get(companyId);
      const departments = db
        .prepare("SELECT * FROM crew_departments WHERE company_id = ? ORDER BY sort_order")
        .all(companyId);
      res.json({ company, departments });
    }),
  );

  /**
   * One agent shape for every endpoint that returns an agent, so a client
   * never has to handle both a mapped shape and a raw database row.
   */
  const presentAgent = (a: AgentRow) => ({
    id: a.id,
    key: a.key,
    displayName: a.display_name,
    professionalRole: a.professional_role,
    roleSummary: a.role_summary,
    seniority: a.seniority,
    departmentId: a.department_id,
    // Vessel × Talent: which container executes this agent, and which
    // capability package it carries. Both are ids the UI can follow, plus the
    // resolved values so a caller need not fetch three things to show one row.
    vesselId: a.vessel_id,
    vesselKey: a.vessel_key,
    runtimeProvider: a.runtime_provider,
    talentId: a.talent_id,
    talentKey: a.talent_key,
    skills: JSON.parse(a.skills_json) as string[],
    isExecutiveAssistant: a.is_executive_assistant === 1,
    // Persona is cosmetic; policy is authoritative. Both are exposed so the
    // UI can show that they are separate, but they are never merged.
    persona: JSON.parse(a.persona_json),
    policy: JSON.parse(a.policy_json),
    status: orchestrator.agentStatus(companyId, a.id),
  });

  app.get(
    `${base}/agents`,
    wrap((_req, res) => {
      res.json({ agents: orchestrator.listAgents(companyId).map(presentAgent) });
    }),
  );

  app.patch(
    `${base}/agents/:id/runtime`,
    wrap((req, res) => {
      const { runtimeProvider } = setAgentRuntimeSchema.parse(req.body ?? {});
      const registered = orchestrator.listRuntimes().map((r) => r.type);
      if (!registered.includes(runtimeProvider)) {
        res
          .status(400)
          .json({ error: "unknown_runtime", message: `No runtime registered for "${runtimeProvider}".`, registered });
        return;
      }
      const agent = orchestrator.setAgentRuntimeProvider(companyId, param(req, "id"), runtimeProvider, actorOf(req));
      if (!agent) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_agent_changed", { agentId: agent.id, runtimeProvider: agent.runtime_provider });
      res.json({ agent: presentAgent(agent) });
    }),
  );

  // --- runtime providers ---------------------------------------------------

  /**
   * Provider Health: capabilities/health/auth for every runtime registered
   * with this orchestrator, mock and real CLI adapters alike. Each of these
   * three calls does its own capability probe (e.g. `claude --version`) per
   * the AgentRuntime contract, so this is meant for an on-demand panel, not
   * a tight poll. Never carries a token — AuthStatus.accountHint is
   * contractually non-identifying (docs/PROVIDER_AUTH.md).
   */
  app.get(
    `${base}/runtimes`,
    wrap(async (_req, res) => {
      const runtimes = await Promise.all(
        orchestrator.listRuntimes().map(async (r) => ({
          type: r.type,
          capabilities: await r.capabilities(),
          health: await r.healthCheck(),
          auth: await r.authStatus(),
        })),
      );
      res.json({ runtimes });
    }),
  );

  // --- CEO chat -----------------------------------------------------------

  app.get(
    `${base}/chat`,
    wrap((_req, res) => {
      const conversationId = orchestrator.ensureCeoConversation(companyId);
      res.json({ conversationId, messages: orchestrator.listMessages(conversationId) });
    }),
  );

  app.post(
    `${base}/chat`,
    wrap((req, res) => {
      const { body, projectId } = ceoMessageSchema.parse(req.body);
      const result = orchestrator.handleCeoMessage(companyId, body, { ...actorOf(req), projectId });
      broadcast("crew_chat_message", { conversationId: result.conversationId, reply: result.reply });
      if (result.task) broadcast("crew_task_changed", { taskId: result.task.id, status: result.task.status });
      res.status(201).json({
        ...result,
        // Same agent shape as /agents, rather than a raw database row.
        assignedAgent: result.assignedAgent ? presentAgent(result.assignedAgent) : null,
      });
    }),
  );

  // --- tasks --------------------------------------------------------------

  app.get(
    `${base}/tasks`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: TASK_STATUSES });
        return;
      }
      res.json({ tasks: orchestrator.tasks.list(companyId, { status: status as never }) });
    }),
  );

  app.get(
    `${base}/tasks/:id`,
    wrap((req, res) => {
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        task,
        runs: orchestrator.runs.listForTask(task.id),
        blockers: orchestrator.tasks.blockers(task.id),
        blocking: orchestrator.tasks.blocking(task.id),
        audit: listAuditEvents(db, companyId, { taskId: task.id, limit: 200 }),
      });
    }),
  );

  /** Execute the next claimable task. Streams events over the websocket. */
  app.post(
    `${base}/tasks/execute-next`,
    wrap(async (_req, res) => {
      const result = await orchestrator.executeNextTask(companyId, {
        onEvent: (e: RunEvent) => broadcast("crew_run_event", e),
      });
      if (!result) {
        res.json({ executed: false, reason: "nothing claimable" });
        return;
      }
      broadcast("crew_task_changed", { taskId: result.task.id, status: result.task.status });
      res.json({ executed: true, task: result.task, runId: result.runId, eventCount: result.events.length });
    }),
  );

  app.post(
    `${base}/tasks/:id/accept`,
    wrap((req, res) => {
      const { note } = reviewSchema.parse(req.body ?? {});
      const task = orchestrator.acceptReview(companyId, param(req, "id"), note ?? "", actorOf(req));
      if (!task) {
        res.status(409).json({ error: "cannot_accept", message: "Task is not in a reviewable state." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  app.post(
    `${base}/tasks/:id/revise`,
    wrap((req, res) => {
      const { reason } = revisionSchema.parse(req.body ?? {});
      const task = orchestrator.requestRevision(companyId, param(req, "id"), reason, actorOf(req));
      if (!task) {
        res.status(409).json({ error: "cannot_revise", message: "Task is not in a reviewable state." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  /**
   * Generic status move — the Kanban board's server-side validation. Every
   * drag from one column to another lands here, and `TaskStore.transition()`
   * is the only thing that decides whether the move is legal (the same state
   * machine `executeNextTask`/`acceptReview`/`requestRevision` already go
   * through); an illegal move throws `InvalidTransitionError`, mapped to 409
   * by `sendDomainError`, and the frontend never applies it locally — the
   * board only ever reflects what this endpoint actually returns.
   */
  app.post(
    `${base}/tasks/:id/status`,
    wrap(async (req, res) => {
      const { status, reason } = taskStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.tasks.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const task = await orchestrator.changeTaskStatus(
        companyId,
        existing.id,
        status,
        reason ?? "moved on the board",
        actorOf(req),
      );
      if (!task) {
        res.status(409).json({ error: "cannot_transition", message: "Task status changed concurrently." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  app.post(
    `${base}/tasks/:id/dependencies`,
    wrap((req, res) => {
      const { dependsOnId } = taskDependencySchema.parse(req.body ?? {});
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const blocker = orchestrator.tasks.get(dependsOnId);
      if (!blocker || blocker.company_id !== companyId) {
        res.status(404).json({ error: "depends_on_not_found" });
        return;
      }
      orchestrator.tasks.addDependency(companyId, task.id, dependsOnId, actorOf(req));
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.status(201).json({ blockers: orchestrator.tasks.blockers(task.id) });
    }),
  );

  app.delete(
    `${base}/tasks/:id/dependencies/:dependsOnId`,
    wrap((req, res) => {
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.tasks.removeDependency(companyId, task.id, param(req, "dependsOnId"), {
        ...actorOf(req),
      });
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ blockers: orchestrator.tasks.blockers(task.id) });
    }),
  );

  // --- goals ----------------------------------------------------------------

  app.get(
    `${base}/goals`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(GOAL_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: GOAL_STATUSES });
        return;
      }
      const topLevel = req.query.topLevel === "true";
      const parentId = typeof req.query.parentId === "string" ? req.query.parentId : undefined;
      res.json({
        goals: orchestrator.goals.list(companyId, {
          status: status as never,
          parentId: topLevel ? null : parentId,
        }),
      });
    }),
  );

  app.get(
    `${base}/goals/:id`,
    wrap((req, res) => {
      const goal = orchestrator.goals.get(param(req, "id"));
      if (!goal || goal.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        goal,
        ancestry: orchestrator.goals.ancestry(goal.id),
        children: orchestrator.goals.children(goal.id),
      });
    }),
  );

  app.post(
    `${base}/goals`,
    wrap((req, res) => {
      const input = createGoalSchema.parse(req.body ?? {});
      const goal = orchestrator.goals.create({ companyId, ...input, ...actorOf(req) });
      broadcast("crew_goal_changed", { goalId: goal.id });
      res.status(201).json({ goal });
    }),
  );

  app.patch(
    `${base}/goals/:id`,
    wrap((req, res) => {
      const patch = updateGoalSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const goal = orchestrator.goals.update(existing.id, patch, actorOf(req));
      broadcast("crew_goal_changed", { goalId: existing.id });
      res.json({ goal });
    }),
  );

  app.post(
    `${base}/goals/:id/status`,
    wrap((req, res) => {
      const { status } = goalStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const goal = orchestrator.goals.setStatus(existing.id, status, actorOf(req));
      broadcast("crew_goal_changed", { goalId: existing.id, status });
      res.json({ goal });
    }),
  );

  app.post(
    `${base}/goals/:id/reparent`,
    wrap((req, res) => {
      const { parentId } = goalReparentSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (parentId) {
        const parent = orchestrator.goals.get(parentId);
        if (!parent || parent.company_id !== companyId) {
          res.status(404).json({ error: "parent_not_found" });
          return;
        }
      }
      const goal = orchestrator.goals.reparent(existing.id, parentId, actorOf(req));
      broadcast("crew_goal_changed", { goalId: existing.id });
      res.json({ goal });
    }),
  );

  // --- projects and milestones ---------------------------------------------

  app.get(
    `${base}/projects`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(PROJECT_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: PROJECT_STATUSES });
        return;
      }
      const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
      res.json({ projects: orchestrator.projects.list(companyId, { status: status as never, goalId }) });
    }),
  );

  /** Project detail view: the project itself, its milestones and its tasks. */
  app.get(
    `${base}/projects/:id`,
    wrap((req, res) => {
      const project = orchestrator.projects.get(param(req, "id"));
      if (!project || project.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        project,
        milestones: orchestrator.projects.listMilestones(project.id),
        tasks: orchestrator.tasks.list(companyId, { projectId: project.id }),
      });
    }),
  );

  app.post(
    `${base}/projects`,
    wrap((req, res) => {
      const input = createProjectSchema.parse(req.body ?? {});
      const project = orchestrator.projects.create({ companyId, ...input, ...actorOf(req) });
      broadcast("crew_project_changed", { projectId: project.id });
      res.status(201).json({ project });
    }),
  );

  app.patch(
    `${base}/projects/:id`,
    wrap((req, res) => {
      const patch = updateProjectSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const project = orchestrator.projects.update(existing.id, patch, actorOf(req));
      broadcast("crew_project_changed", { projectId: existing.id });
      res.json({ project });
    }),
  );

  app.post(
    `${base}/projects/:id/status`,
    wrap((req, res) => {
      const { status } = projectStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const project = orchestrator.projects.setStatus(existing.id, status, actorOf(req));
      broadcast("crew_project_changed", { projectId: existing.id, status });
      res.json({ project });
    }),
  );

  app.post(
    `${base}/projects/:id/milestones`,
    wrap((req, res) => {
      const input = createMilestoneSchema.parse(req.body ?? {});
      const project = orchestrator.projects.get(param(req, "id"));
      if (!project || project.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.addMilestone({
        companyId,
        projectId: project.id,
        ...input,
        ...actorOf(req),
      });
      broadcast("crew_project_changed", { projectId: project.id });
      res.status(201).json({ milestone });
    }),
  );

  app.patch(
    `${base}/milestones/:id`,
    wrap((req, res) => {
      const patch = updateMilestoneSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.getMilestone(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.updateMilestone(existing.id, patch);
      broadcast("crew_project_changed", { projectId: existing.project_id });
      res.json({ milestone });
    }),
  );

  app.post(
    `${base}/milestones/:id/status`,
    wrap((req, res) => {
      const { status } = milestoneStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.getMilestone(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.setMilestoneStatus(existing.id, status, {
        ...actorOf(req),
      });
      broadcast("crew_project_changed", { projectId: existing.project_id, status });
      res.json({ milestone });
    }),
  );

  // --- runs ---------------------------------------------------------------

  app.get(
    `${base}/runs/:id/events`,
    wrap((req, res) => {
      const run = orchestrator.runs.get(param(req, "id"));
      if (!run || run.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const afterSeq = Number(req.query.afterSeq ?? -1);
      res.json({ run, events: orchestrator.runs.listEvents(run.id, { afterSeq }) });
    }),
  );

  // --- approvals ----------------------------------------------------------

  /**
   * Reviews with a name attached.
   *
   * `crew_approval_reviews.reviewer_id` is a `usr_…`, which is the right
   * thing to store — an account can be renamed, and the audit chain must not
   * change when it is. It is the wrong thing to *show*: "hat bereits
   * bewertet: usr_0f432eb5…" tells the second reviewer nothing about who
   * looked at this before them, which is the entire question they are asking.
   * Resolved here rather than in the client so the UI does not have to fetch
   * the account list to render a decision panel — and so a viewer, who may
   * read reviews but not the user directory, still sees names.
   */
  function withReviewerNames(approvalId: string) {
    return orchestrator.approvalReviews.listFor(approvalId).map((review) => {
      const user = review.reviewer_id.startsWith("usr_") ? auth.users.get(review.reviewer_id) : null;
      return {
        ...review,
        // Falls back to the id, never to "Unbekannt": a deleted account is
        // still evidence, and an id is at least traceable.
        reviewer_label: user ? user.display_name || user.email : review.reviewer_id,
      };
    });
  }

  app.get(
    `${base}/approvals`,
    wrap((_req, res) => {
      // Each pending approval carries its own vote alongside it. A UI that had
      // to fetch the tally per row would either make N requests or show the
      // quorum late, and "late" here means an owner pressing a button on a
      // gate somebody else already closed.
      // Bounded. Each row now costs a tally, a review list and a name lookup
      // per reviewer, and `listPending` has no limit of its own — approvals
      // are raised by agents on risky actions, so the list is not
      // operator-sized by construction. A decision inbox showing the oldest
      // 200 is a decision inbox; one that pages the whole backlog on every
      // poll is a load generator.
      const approvals = orchestrator.approvals
        .listPending(companyId)
        .slice(0, 200)
        .map((approval) => ({
          ...approval,
          tally: orchestrator.approvalReviews.tally(approval.id),
          reviews: withReviewerNames(approval.id),
        }));
      res.json({ approvals });
    }),
  );

  app.get(
    `${base}/approvals/:id/reviews`,
    wrap((req, res) => {
      const approval = orchestrator.approvals.get(param(req, "id"));
      if (!approval || approval.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Readable by any signed-in user, not only an owner: who has already
      // looked at a dangerous change is exactly what the second reviewer
      // needs to know before adding their own name to it.
      res.json({
        approval,
        tally: orchestrator.approvalReviews.tally(approval.id),
        reviews: withReviewerNames(approval.id),
      });
    }),
  );

  app.post(
    `${base}/approvals/:id/quorum`,
    ownerOnly,
    wrap((req, res) => {
      const { required } = quorumSchema.parse(req.body ?? {});
      const tally = orchestrator.approvalReviews.setRequiredApprovals(param(req, "id"), required, {
        actorId: actorOf(req).actorId,
      });
      broadcast("crew_approval_quorum_changed", { approvalId: param(req, "id"), required: tally.required });
      res.json({ tally });
    }),
  );

  app.post(
    `${base}/approvals/:id/decide`,
    ownerOnly,
    wrap((req, res) => {
      const { decision, reason } = decisionSchema.parse(req.body ?? {});
      // Goes through the vote, not around it. At the default quorum of 1 the
      // first verdict settles the approval and this behaves exactly as it did
      // before quorums existed; at 2 it records one voice and says how many
      // are still missing.
      const outcome = orchestrator.reviewApproval(companyId, param(req, "id"), decision, reason ?? "", actorOf(req));
      if (!outcome) {
        res.status(409).json({ error: "already_decided", message: "This approval is no longer pending." });
        return;
      }
      if (!outcome.decided) {
        // 202: taken, and not yet acted upon. A 200 here would let a UI
        // report "freigegeben" for a change that is still waiting for a
        // second human — the one thing this whole feature exists to prevent.
        broadcast("crew_approval_reviewed", {
          approvalId: outcome.approval.id,
          approvals: outcome.tally.approvals,
          required: outcome.tally.required,
        });
        res.status(202).json({ approval: outcome.approval, tally: outcome.tally, review: outcome.review });
        return;
      }
      broadcast("crew_approval_decided", { approvalId: outcome.approval.id, status: outcome.approval.status });
      res.json({ approval: outcome.approval, tally: outcome.tally, review: outcome.review });
    }),
  );

  // --- decision inbox: notifications + decision log ------------------------

  app.get(
    `${base}/notifications`,
    wrap((req, res) => {
      const unreadOnly = req.query.unread === "true";
      res.json({
        notifications: orchestrator.notifications.list(companyId, { unreadOnly }),
        unreadCount: orchestrator.notifications.countUnread(companyId),
      });
    }),
  );

  app.post(
    `${base}/notifications/:id/read`,
    wrap((req, res) => {
      const notification = orchestrator.notifications.get(param(req, "id"));
      if (!notification || notification.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const updated = orchestrator.notifications.markRead(notification.id);
      broadcast("crew_notification_read", { notificationId: notification.id });
      res.json({ notification: updated });
    }),
  );

  app.get(
    `${base}/decisions`,
    wrap((req, res) => {
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      res.json({ decisions: orchestrator.decisions.list(companyId, { taskId, projectId }) });
    }),
  );

  // --- secrets (password-manager integration) ------------------------------
  //
  // Only ever returns SecretRef rows (name/provider/itemRef/field) — never a
  // resolved value. The one exception is POST /secrets/:id/test, which
  // resolves the value in memory to prove the ref actually works, then
  // reports only {ok, message} — the value itself never leaves the server.

  app.get(
    `${base}/secret-providers`,
    wrap(async (_req, res) => {
      const kinds: Array<"vaultwarden" | "protonpass" | "keychain"> = ["vaultwarden", "protonpass", "keychain"];
      const providers = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          registered: orchestrator.listSecretProviderKinds().includes(kind),
          ...(await orchestrator.testSecretProvider(kind)),
        })),
      );
      res.json({ providers });
    }),
  );

  app.get(
    `${base}/secrets`,
    wrap((_req, res) => {
      res.json({ secrets: orchestrator.secrets.list(companyId) });
    }),
  );

  app.post(
    `${base}/secrets`,
    ownerOnly,
    wrap((req, res) => {
      const input = createSecretSchema.parse(req.body ?? {});
      const secret = orchestrator.secrets.create({ companyId, ...input, ...actorOf(req) });
      broadcast("crew_secret_changed", { secretId: secret.id });
      res.status(201).json({ secret });
    }),
  );

  app.patch(
    `${base}/secrets/:id`,
    ownerOnly,
    wrap((req, res) => {
      const patch = updateSecretSchema.parse(req.body ?? {});
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const secret = orchestrator.secrets.update(existing.id, patch, actorOf(req));
      broadcast("crew_secret_changed", { secretId: existing.id });
      res.json({ secret });
    }),
  );

  app.delete(
    `${base}/secrets/:id`,
    ownerOnly,
    wrap((req, res) => {
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.secrets.delete(existing.id, actorOf(req));
      broadcast("crew_secret_changed", { secretId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/secrets/:id/test`,
    ownerOnly,
    wrap(async (req, res) => {
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      try {
        const value = await orchestrator.resolveSecret(companyId, existing.id, actorOf(req));
        res.json({ ok: true, length: value.length });
      } catch (err) {
        if (err instanceof SecretResolutionError) {
          res.json({ ok: false, message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  // --- attachments (task/project-scoped + the general document store) -----

  app.get(
    `${base}/attachments`,
    wrap((req, res) => {
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      if (taskId) {
        res.json({ attachments: orchestrator.attachments.listForTask(companyId, taskId) });
      } else if (projectId) {
        res.json({ attachments: orchestrator.attachments.listForProject(companyId, projectId) });
      } else {
        res.json({ attachments: orchestrator.attachments.listGeneral(companyId) });
      }
    }),
  );

  app.post(
    `${base}/attachments`,
    wrap((req, res) => {
      const input = uploadAttachmentSchema.parse(req.body ?? {});
      const buffer = Buffer.from(input.dataBase64, "base64");
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        res.status(413).json({
          error: "attachment_too_large",
          message: `Attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB.`,
        });
        return;
      }
      const attachment = orchestrator.uploadAttachment(companyId, {
        filename: input.filename,
        contentType: input.contentType,
        buffer,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        ...actorOf(req),
      });
      broadcast("crew_attachment_changed", { attachmentId: attachment.id });
      res.status(201).json({ attachment });
    }),
  );

  app.get(
    `${base}/attachments/:id/download`,
    wrap((req, res) => {
      const found = orchestrator.readAttachment(companyId, param(req, "id"));
      if (!found) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const asciiFallback = found.row.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
      res.setHeader("Content-Type", found.row.content_type);
      res.setHeader("Content-Length", String(found.buffer.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(found.row.filename)}`,
      );
      res.send(found.buffer);
    }),
  );

  app.delete(
    `${base}/attachments/:id`,
    wrap((req, res) => {
      const deleted = orchestrator.deleteAttachment(companyId, param(req, "id"), {
        ...actorOf(req),
      });
      if (!deleted) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_attachment_changed", { attachmentId: param(req, "id"), deleted: true });
      res.json({ ok: true });
    }),
  );

  // --- network (Tailscale/Headscale status + remote workers over the tailnet) ---

  app.get(
    `${base}/tailscale`,
    wrap(async (_req, res) => {
      try {
        const [status, connection] = await Promise.all([orchestrator.tailscaleStatus(), orchestrator.testTailscale()]);
        res.json({ ...status, ok: connection.ok, message: connection.message });
      } catch (err) {
        res.json({
          backendState: "Unknown",
          self: null,
          peers: [],
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  app.get(
    `${base}/remote-workers`,
    wrap((_req, res) => {
      res.json({ remoteWorkers: orchestrator.remoteWorkers.list(companyId) });
    }),
  );

  app.post(
    `${base}/remote-workers`,
    wrap((req, res) => {
      const input = createRemoteWorkerSchema.parse(req.body ?? {});
      const worker = orchestrator.remoteWorkers.create({ companyId, ...input, ...actorOf(req) });
      broadcast("crew_remote_worker_changed", { remoteWorkerId: worker.id });
      res.status(201).json({ remoteWorker: worker });
    }),
  );

  app.delete(
    `${base}/remote-workers/:id`,
    wrap((req, res) => {
      const existing = orchestrator.remoteWorkers.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.remoteWorkers.delete(existing.id, actorOf(req));
      broadcast("crew_remote_worker_changed", { remoteWorkerId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/remote-workers/:id/test`,
    wrap(async (req, res) => {
      const existing = orchestrator.remoteWorkers.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await orchestrator.testRemoteWorker(companyId, existing.id));
    }),
  );

  // --- meetings -------------------------------------------------------------
  //
  // One round is one participant's turn (round-robin by default, or the
  // moderator can pick an explicit speaker) — total turns are bounded by
  // max_rounds alone, never multiplied by participant count. A meeting
  // self-closes the moment max_rounds or its own budget cap is reached;
  // POST .../next-turn after that is a safe no-op ({turn: null}), so the
  // UI can keep calling it without special-casing "is this meeting over".

  app.get(
    `${base}/meetings`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(MEETING_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: MEETING_STATUSES });
        return;
      }
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      res.json({ meetings: orchestrator.meetings.list(companyId, { status: status as never, projectId }) });
    }),
  );

  app.post(
    `${base}/meetings`,
    wrap((req, res) => {
      const input = createMeetingSchema.parse(req.body ?? {});
      const meeting = orchestrator.meetings.create({
        companyId,
        ...input,
        ...actorOf(req),
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.status(201).json({ meeting });
    }),
  );

  app.get(
    `${base}/meetings/:id`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        meeting,
        participants: orchestrator.meetings.participants(meeting.id),
        turns: orchestrator.meetings.turns(meeting.id),
        actionItems: orchestrator.meetings.actionItems(meeting.id),
      });
    }),
  );

  app.post(
    `${base}/meetings/:id/start`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const started = orchestrator.meetings.start(meeting.id, actorOf(req));
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: started });
    }),
  );

  app.post(
    `${base}/meetings/:id/next-turn`,
    wrap(async (req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { agentId } = meetingTurnSchema.parse(req.body ?? {});
      const result = await orchestrator.runMeetingTurn(companyId, meeting.id, { agentId });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: result?.meeting ?? orchestrator.meetings.get(meeting.id), turn: result?.turn ?? null });
    }),
  );

  app.post(
    `${base}/meetings/:id/end`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { minutes } = meetingEndSchema.parse(req.body ?? {});
      const ended = orchestrator.meetings.end(meeting.id, minutes ?? meeting.minutes, {
        ...actorOf(req),
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: ended });
    }),
  );

  app.post(
    `${base}/meetings/:id/cancel`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const cancelled = orchestrator.meetings.cancel(meeting.id, actorOf(req));
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: cancelled });
    }),
  );

  app.post(
    `${base}/meetings/:id/action-items`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const input = createActionItemSchema.parse(req.body ?? {});
      const item = orchestrator.meetings.addActionItem({
        meetingId: meeting.id,
        ...input,
        ...actorOf(req),
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.status(201).json({ actionItem: item });
    }),
  );

  app.post(
    `${base}/meetings/action-items/:id/convert`,
    wrap((req, res) => {
      const item = orchestrator.meetings.getActionItem(param(req, "id"));
      if (!item) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const task = orchestrator.convertActionItemToTask(companyId, item.id, actorOf(req));
      if (!task) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.status(201).json({ task });
    }),
  );

  // --- memory (Obsidian vault, the first MemoryProvider) ------------------
  //
  // A memory entry's real content is written and read through its
  // provider (a markdown file in an Obsidian vault, for the "obsidian"
  // kind) — this API only ever persists/returns the reference
  // (crew_memory_refs): provider, external locator, title, provenance.
  // GET /memory/:id is the one exception, mirroring how POST /secrets/:id/test
  // resolves a secret value in memory without ever storing it here — content
  // is read live from the provider and returned, never cached in the DB.

  app.get(
    `${base}/memory-providers`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listMemoryProviderKinds();
      const providers = await Promise.all(
        kinds.map(async (kind) => ({ kind, registered: true, ...(await orchestrator.testMemoryProvider(kind)) })),
      );
      res.json({ providers });
    }),
  );

  app.get(
    `${base}/memory`,
    wrap((req, res) => {
      const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      if (kind && !(MEMORY_KINDS as readonly string[]).includes(kind)) {
        res.status(400).json({ error: "invalid_kind", allowed: MEMORY_KINDS });
        return;
      }
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      res.json({
        memories: orchestrator.memories.list(companyId, { kind: kind as never, taskId, projectId, agentId }),
      });
    }),
  );

  app.get(
    `${base}/memory/search`,
    wrap(async (req, res) => {
      const provider = typeof req.query.provider === "string" ? req.query.provider : "";
      const query = typeof req.query.q === "string" ? req.query.q : "";
      if (!provider || !query || query.length > 2000) {
        res.status(400).json({ error: "invalid_request", message: "provider and q query params are required." });
        return;
      }
      res.json({
        hits:
          req.query.semantic === "1"
            ? await orchestrator.searchSemanticMemory(provider, query)
            : await orchestrator.searchMemory(provider, query),
      });
    }),
  );

  app.post(
    `${base}/memory/sync`,
    ownerOnly,
    wrap(async (_req, res) => {
      await orchestrator.syncMemoryProviders();
      broadcast("crew_memory_changed", {});
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/memory`,
    wrap(async (req, res) => {
      const input = createMemorySchema.parse(req.body ?? {});
      const ref = await orchestrator.recordMemory(companyId, input.provider, input, {
        ...actorOf(req),
      });
      broadcast("crew_memory_changed", { memoryId: ref.id });
      res.status(201).json({ memory: ref });
    }),
  );

  app.get(
    `${base}/memory/:id`,
    wrap(async (req, res) => {
      const result = await orchestrator.readMemoryContent(companyId, param(req, "id"));
      if (!result) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ memory: result.ref, content: result.content });
    }),
  );

  app.delete(
    `${base}/memory/:id`,
    wrap(async (req, res) => {
      const deleted = await orchestrator.deleteMemory(companyId, param(req, "id"), {
        ...actorOf(req),
      });
      if (!deleted) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_memory_changed", { memoryId: param(req, "id"), deleted: true });
      res.json({ ok: true });
    }),
  );

  // --- mailboxes (IMAP, JMAP, Microsoft 365, Gmail) ------------------------
  //
  // A mailbox row never carries its credentials (see mailbox-store.ts), so
  // no response here can leak them — the write endpoints accept them, and
  // nothing reads them back out. Messages are not stored: the list and read
  // endpoints go to the mail server live, so this API is a window onto the
  // mailbox rather than a copy of it.

  app.get(
    `${base}/mail-providers`,
    wrap((_req, res) => {
      const registered = orchestrator.listMailProviderKinds();
      res.json({
        providers: MAILBOX_KINDS.map((kind) => ({ kind, registered: registered.includes(kind) })),
      });
    }),
  );

  app.get(
    `${base}/mailboxes`,
    wrap((_req, res) => {
      const mailboxes = orchestrator.mailboxes.list(companyId).map((mailbox) => ({
        ...mailbox,
        agents: orchestrator.mailboxes.agentsFor(mailbox.id),
      }));
      res.json({ mailboxes });
    }),
  );

  app.post(
    `${base}/mailboxes`,
    wrap((req, res) => {
      const input = createMailboxSchema.parse(req.body ?? {});
      const mailbox = orchestrator.mailboxes.create({
        companyId,
        ...input,
        ...actorOf(req),
      });
      broadcast("crew_mailbox_changed", { mailboxId: mailbox.id });
      res.status(201).json({ mailbox });
    }),
  );

  app.get(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const mailbox = orchestrator.mailboxes.get(param(req, "id"));
      if (!mailbox || mailbox.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        mailbox,
        agents: orchestrator.mailboxes.agentsFor(mailbox.id),
        messages: orchestrator.mailboxes.messages(mailbox.id, 50),
      });
    }),
  );

  app.patch(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { credentials, ...patch } = updateMailboxSchema.parse(req.body ?? {});
      const mailbox = orchestrator.mailboxes.update(existing.id, patch, actorOf(req));
      // Credentials are replaced wholesale rather than merged: a partial
      // update of a secret is how stale halves of a credential survive.
      if (credentials) orchestrator.mailboxes.writeCredentials(existing.id, credentials);
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.json({ mailbox });
    }),
  );

  app.delete(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.mailboxes.delete(existing.id, actorOf(req));
      broadcast("crew_mailbox_changed", { mailboxId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/test`,
    wrap(async (req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await orchestrator.testMailbox(companyId, existing.id));
    }),
  );

  // --- who may work this mailbox (the n:n grants) --------------------------

  app.post(
    `${base}/mailboxes/:id/agents`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { agentId, access } = grantMailboxAgentSchema.parse(req.body ?? {});
      const agents = orchestrator.mailboxes.grantAgent(existing.id, agentId, access ?? "read", {
        ...actorOf(req),
      });
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.status(201).json({ agents });
    }),
  );

  app.delete(
    `${base}/mailboxes/:id/agents/:agentId`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const revoked = orchestrator.mailboxes.revokeAgent(existing.id, param(req, "agentId"), {
        ...actorOf(req),
      });
      if (!revoked) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.json({ agents: orchestrator.mailboxes.agentsFor(existing.id) });
    }),
  );

  // --- live mail -----------------------------------------------------------

  app.get(
    `${base}/mailboxes/:id/messages`,
    wrap(async (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      res.json({
        messages: await orchestrator.listMailboxMessages(companyId, param(req, "id"), { limit, agentId }),
      });
    }),
  );

  app.get(
    `${base}/mailboxes/:id/messages/:externalId`,
    wrap(async (req, res) => {
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      const message = await orchestrator.readMailboxMessage(companyId, param(req, "id"), param(req, "externalId"), {
        agentId,
      });
      if (!message) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ message });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/send`,
    wrap(async (req, res) => {
      const { agentId, ...mail } = sendMailSchema.parse(req.body ?? {});
      await orchestrator.sendFromMailbox(companyId, param(req, "id"), mail, { agentId });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/poll`,
    wrap(async (req, res) => {
      const result = await orchestrator.pollMailbox(companyId, param(req, "id"));
      broadcast("crew_mailbox_changed", { mailboxId: result.mailbox.id });
      for (const task of result.tasksCreated) {
        broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      }
      res.json({
        mailbox: result.mailbox,
        seen: result.seen,
        newMessages: result.newMessages,
        tasksCreated: result.tasksCreated.length,
      });
    }),
  );

  app.post(
    `${base}/mailboxes/poll-due`,
    wrap(async (_req, res) => {
      const results = await orchestrator.pollDueMailboxes(companyId);
      if (results.length > 0) broadcast("crew_mailbox_changed", { polled: results.length });
      res.json({ results });
    }),
  );

  // --- notification channels (Discord, Telegram, email) -------------------
  //
  // Fan-out targets for the decision inbox — see company.ts#fanOutNotification.
  // Registering a channel happens at server startup (server-main.ts), from
  // env vars; this surface only ever reports status and lets an operator
  // prove a channel actually works, the same "testConnection() vs. really
  // send" split /secrets/:id/test uses.

  app.get(
    `${base}/notification-channels`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listNotificationChannelKinds();
      const channels = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          registered: true,
          ...(await orchestrator.testNotificationChannel(kind)),
        })),
      );
      res.json({ channels });
    }),
  );

  app.post(
    `${base}/notification-channels/:kind/test`,
    wrap(async (req, res) => {
      res.json(await orchestrator.testNotificationChannel(param(req, "kind")));
    }),
  );

  app.post(
    `${base}/notification-channels/:kind/send-test`,
    wrap(async (req, res) => {
      res.json(await orchestrator.sendTestNotification(param(req, "kind")));
    }),
  );

  // --- messenger ingress (Telegram, Discord) -------------------------------
  //
  // The receiving half of the chat integrations. Everything here exists
  // because inbound chat is an ingress with no identity of its own: a bot
  // token is not a secret, so anyone who finds the bot can write to it.
  //
  // The interesting endpoint is /accept. Granting role "owner" is granting
  // the ability to act as the CEO from a chat app — handleCeoMessage() can
  // delegate work immediately — which is why it is a deliberate act by the
  // owner in the Command Center, where they can see who is asking, and not
  // something a first message can earn by itself.

  app.get(
    `${base}/messenger-channels`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listMessengerChannelKinds();
      const channels = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          registered: true,
          ...(await orchestrator.testMessengerChannel(kind)),
        })),
      );
      res.json({ channels });
    }),
  );

  // Polling is pulled, not pushed: there is no background loop, the same way
  // mailboxes are polled by /mailboxes/poll-due. A poll consumes the
  // channel's cursor, so this is the only endpoint that advances it.
  app.post(
    `${base}/messenger-channels/:kind/poll`,
    wrap(async (req, res) => {
      const kind = param(req, "kind");
      // An unconfigured channel is a missing thing, not a broken one: the
      // operator never set TELEGRAM_BOT_TOKEN, and a 500 would send them
      // looking for a fault in the server instead.
      if (!orchestrator.listMessengerChannelKinds().includes(kind)) {
        res.status(404).json({ error: "not_found", message: `No "${kind}" messenger channel is registered.` });
        return;
      }
      const result = await orchestrator.pollMessengerChannel(companyId, kind);
      if (result.received > 0) broadcast("crew_messenger_changed", { kind, ...result });
      // A message that became a task has to reach the board without a reload,
      // the same way /mailboxes/:id/poll announces what it created.
      for (const taskId of result.taskIds) broadcast("crew_task_changed", { taskId });
      res.json(result);
    }),
  );

  app.get(
    `${base}/messenger-pairings`,
    wrap((_req, res) => {
      res.json({ pairings: orchestrator.messengerPairings.list(companyId) });
    }),
  );

  app.post(
    `${base}/messenger-pairings/:id/accept`,
    ownerOnly,
    wrap((req, res) => {
      const { role } = acceptPairingSchema.parse(req.body ?? {});
      const pairing = orchestrator.acceptMessengerPairing(companyId, param(req, "id"), role, actorOf(req));
      if (!pairing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_messenger_changed", { pairingId: pairing.id, role });
      res.json({ pairing });
    }),
  );

  // block / revoke / unblock are three different acts and stay three
  // endpoints: "I do not want to hear from this person" is not the same as
  // "this person should no longer speak for me", and an operator reading the
  // audit log has to be able to tell them apart.
  for (const action of ["block", "revoke", "unblock"] as const) {
    app.post(
      `${base}/messenger-pairings/:id/${action}`,
      ownerOnly,
      wrap((req, res) => {
        const existing = orchestrator.messengerPairings.get(param(req, "id"));
        if (!existing || existing.company_id !== companyId) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const pairing = orchestrator.messengerPairings[action](existing.id, actorOf(req));
        broadcast("crew_messenger_changed", { pairingId: existing.id, action });
        res.json({ pairing });
      }),
    );
  }

  // --- change proposals: file edits an owner sees before they happen -------
  //
  // The write endpoint here is /apply, and it is the only way an approved
  // proposal reaches the disk. There is deliberately no force flag and no
  // "apply anyway" parameter: a gate with a bypass is not a gate. A refusal
  // comes back as 409 with the reason, and nothing was written — not even
  // the files that would have applied cleanly.

  app.get(
    `${base}/change-proposals`,
    wrap((req, res) => {
      const query = listChangeProposalsSchema.parse(req.query ?? {});
      // file_count is a projection, not a column: a list says how much a
      // proposal touches without shipping the contents of everything it
      // touches to draw one line.
      const counts = orchestrator.changeProposals.fileCounts(companyId);
      const proposals = orchestrator.changeProposals
        .list(companyId, query)
        .map((proposal) => ({ ...proposal, file_count: counts[proposal.id] ?? 0 }));
      res.json({ proposals });
    }),
  );

  app.get(
    `${base}/change-proposals/:id`,
    wrap((req, res) => {
      const proposal = orchestrator.changeProposals.get(param(req, "id"));
      if (!proposal || proposal.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ proposal, files: orchestrator.changeProposals.files(proposal.id) });
    }),
  );

  app.post(
    `${base}/change-proposals/:id/decision`,
    ownerOnly,
    wrap((req, res) => {
      const { decision, reason } = changeProposalDecisionSchema.parse(req.body ?? {});
      const outcome = orchestrator.decideChangeProposal(companyId, param(req, "id"), decision, {
        reason,
        ...actorOf(req),
      });
      if (!outcome) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { proposal, tally } = outcome;
      if (!outcome.decided) {
        // 202, as on the approvals route and for the same reason: the vote is
        // recorded, the proposal is still pending, and nothing has been
        // written. A 200 here would let the panel report a deploy script as
        // approved while it waits for a second human.
        broadcast("crew_approval_reviewed", {
          approvalId: proposal.approval_id,
          approvals: tally?.approvals ?? 0,
          required: tally?.required ?? 1,
        });
        res.status(202).json({ proposal, tally });
        return;
      }
      broadcast("crew_change_proposal_changed", { proposalId: proposal.id, status: proposal.status });
      broadcast("crew_approval_changed", { approvalId: proposal.approval_id });
      res.json({ proposal, tally });
    }),
  );

  app.post(
    `${base}/change-proposals/:id/apply`,
    ownerOnly,
    wrap((req, res) => {
      const result = orchestrator.applyChangeProposal(companyId, param(req, "id"), actorOf(req));
      broadcast("crew_change_proposal_changed", { proposalId: result.proposal.id, status: result.proposal.status });
      res.json(result);
    }),
  );

  // --- external events: what arrived from outside, once ---------------------
  //
  // The dedupe log behind mail and messenger polling. It is read-only here
  // apart from /replay, which clears the handled marker so the next poll
  // acts on the event again. Replay never rewrites the recorded payload:
  // replaying an event has to mean "do this again with what actually
  // arrived", not "do this with what someone typed later".

  app.get(
    `${base}/external-events`,
    wrap((req, res) => {
      const { unhandled, sourceKind, limit } = listExternalEventsSchema.parse(req.query ?? {});
      const events =
        unhandled === "true"
          ? orchestrator.externalEvents.unhandled(companyId, limit ?? 100)
          : orchestrator.externalEvents.list(companyId, { sourceKind, limit });
      res.json({ events });
    }),
  );

  app.post(
    `${base}/external-events/:id/replay`,
    wrap((req, res) => {
      const existing = orchestrator.externalEvents.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const event = orchestrator.externalEvents.replay(existing.id);
      broadcast("crew_external_event_changed", { eventId: existing.id, replayed: true });
      res.json({ event });
    }),
  );

  // --- vessels and talents: the two halves of an agent ---------------------
  //
  // A vessel is the execution container (which runtime, which model, how long,
  // how often, how many at once); a talent is the capability package (role,
  // policy, persona, skills). Splitting them is what makes a role portable
  // across runtimes.
  //
  // Note what the vessel surface does NOT accept: no permission mode, no
  // sandbox, no tool allowlist. That is not an oversight to fill in later —
  // elevation comes only from a SandboxGrant minted from an approved request
  // and capped at four hours (docs/THREAT_MODEL.md T-01), and a vessel field
  // saying "elevated" would be a second route to it that no approval ever
  // authorised. The store's patch allowlist enforces the same thing one layer
  // down, so a body carrying such a key changes nothing either way.

  app.get(
    `${base}/vessels`,
    wrap((_req, res) => {
      const vessels = orchestrator.vessels.list(companyId).map((vessel) => ({
        ...vessel,
        agents: orchestrator.vessels.agentsFor(vessel.id),
      }));
      res.json({ vessels });
    }),
  );

  app.post(
    `${base}/vessels`,
    wrap((req, res) => {
      const input = createVesselSchema.parse(req.body ?? {});
      const vessel = orchestrator.vessels.create({ companyId, ...input }, actorOf(req));
      broadcast("crew_vessel_changed", { vesselId: vessel.id });
      res.status(201).json({ vessel });
    }),
  );

  app.patch(
    `${base}/vessels/:id`,
    wrap((req, res) => {
      const existing = orchestrator.vessels.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch = updateVesselSchema.parse(req.body ?? {});
      const vessel = orchestrator.vessels.update(existing.id, patch, actorOf(req));
      broadcast("crew_vessel_changed", { vesselId: existing.id });
      res.json({ vessel });
    }),
  );

  app.delete(
    `${base}/vessels/:id`,
    wrap((req, res) => {
      const existing = orchestrator.vessels.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // A vessel still bound to agents refuses to go, and the store's message
      // names them — which is the whole value of the refusal, so it reaches
      // the client as a 409 rather than being flattened into "delete failed".
      orchestrator.vessels.delete(existing.id, actorOf(req));
      broadcast("crew_vessel_changed", { vesselId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.get(
    `${base}/talents`,
    wrap((_req, res) => {
      const talents = orchestrator.talents.list(companyId).map((talent) => ({
        ...talent,
        agents: orchestrator.talents.agentsFor(talent.id),
      }));
      res.json({ talents });
    }),
  );

  // Served rather than hardcoded in the UI: one list, one place to change it.
  app.get(
    `${base}/talents/seniorities`,
    wrap((_req, res) => {
      res.json({ seniorities: SENIORITY_LEVELS });
    }),
  );

  app.post(
    `${base}/talents`,
    wrap((req, res) => {
      const input = createTalentSchema.parse(req.body ?? {});
      const talent = orchestrator.talents.create({ companyId, ...input }, actorOf(req));
      broadcast("crew_talent_changed", { talentId: talent.id });
      res.status(201).json({ talent });
    }),
  );

  app.patch(
    `${base}/talents/:id`,
    wrap((req, res) => {
      const existing = orchestrator.talents.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch = updateTalentSchema.parse(req.body ?? {});
      const talent = orchestrator.talents.update(existing.id, patch, actorOf(req));
      broadcast("crew_talent_changed", { talentId: existing.id });
      res.json({ talent });
    }),
  );

  app.delete(
    `${base}/talents/:id`,
    wrap((req, res) => {
      const existing = orchestrator.talents.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.talents.delete(existing.id, actorOf(req));
      broadcast("crew_talent_changed", { talentId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  /** Rebinds an agent. Omitting a field leaves that half of the pairing alone. */
  app.post(
    `${base}/agents/:id/pairing`,
    wrap((req, res) => {
      const pairing = agentPairingSchema.parse(req.body ?? {});
      const agent = orchestrator.setAgentPairing(companyId, param(req, "id"), pairing, actorOf(req));
      if (!agent) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_agent_changed", { agentId: agent.id });
      res.json({ agent: presentAgent(agent) });
    }),
  );

  // --- the run queue and the loop that drains it ---------------------------
  //
  // Read-mostly. The queue is filled by whatever delegated the work and
  // emptied by the scheduler; the endpoints here exist so an operator can see
  // what is waiting, push it along by hand, and withdraw something that should
  // not run after all.

  app.get(
    `${base}/run-queue`,
    wrap((req, res) => {
      const { status, limit } = listRunQueueSchema.parse(req.query ?? {});
      const requests = orchestrator.runRequests.list(companyId, { status, limit }).map((request) => ({
        ...request,
        // The title is what an operator recognises; the task id is not.
        task_title: orchestrator.tasks.get(request.task_id)?.title ?? null,
      }));
      res.json({ requests });
    }),
  );

  app.post(
    `${base}/run-queue/:id/cancel`,
    wrap((req, res) => {
      const existing = orchestrator.runRequests.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const request = orchestrator.runRequests.cancel(existing.id, { reason: "vom Chef zurückgezogen" });
      broadcast("crew_run_queue_changed", { requestId: existing.id, cancelled: true });
      res.json({ request });
    }),
  );

  /** The "do it now" button. Same drain the scheduler runs, same limits. */
  app.post(
    `${base}/run-queue/drain`,
    wrap(async (req, res) => {
      const { limit } = drainRunQueueSchema.parse(req.body ?? {});
      const result = await orchestrator.drainRunQueue(companyId, {
        limit,
        onEvent: (event: RunEvent) => broadcast("crew_run_event", event),
      });
      if (result.claimed > 0) {
        broadcast("crew_run_queue_changed", result);
        broadcast("crew_task_changed", {});
      }
      res.json(result);
    }),
  );

  app.get(
    `${base}/scheduler`,
    wrap((_req, res) => {
      const scheduler = opts.scheduler?.();
      // Absent is a real answer, not an error: IRONCREW_SCHEDULER=off is a
      // supported configuration, and the UI has to be able to say so rather
      // than showing an empty list that looks like a broken page.
      res.json({ enabled: Boolean(scheduler), jobs: scheduler?.status() ?? [] });
    }),
  );

  app.post(
    `${base}/scheduler/:name/run`,
    wrap(async (req, res) => {
      const scheduler = opts.scheduler?.();
      if (!scheduler) {
        res.status(409).json({ error: "scheduler_disabled", message: "Der Hintergrund-Scheduler ist abgeschaltet." });
        return;
      }
      const name = param(req, "name");
      if (!scheduler.status().some((job) => job.name === name)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ job: await scheduler.runNow(name) });
    }),
  );

  // --- tools: what an agent may reach for ---------------------------------
  //
  // Registering a tool and granting it are separate endpoints because they are
  // separate acts: the registry says what this server can perform, the grants
  // say who may. Everything installed is visible here; nothing installed is
  // usable until someone says so.

  app.get(
    `${base}/tools`,
    wrap((_req, res) => {
      const tools = orchestrator.tools.list(companyId).map((tool) => ({
        ...tool,
        grants: orchestrator.tools.grantsFor(tool.id),
      }));
      res.json({ tools });
    }),
  );

  app.get(
    `${base}/agents/:id/tools`,
    wrap((req, res) => {
      const { projectId } = agentToolsQuerySchema.parse(req.query ?? {});
      // Answered per project because a project grant is contextual: the same
      // agent has the customer's tools inside the customer's project and not
      // outside it (migration 0019).
      res.json({ tools: orchestrator.tools.listForAgent(companyId, param(req, "id"), { projectId }) });
    }),
  );

  app.post(
    `${base}/tools/:id/grants`,
    ownerOnly,
    wrap((req, res) => {
      const existing = orchestrator.tools.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const input = grantToolSchema.parse(req.body ?? {});
      const grant = orchestrator.tools.grant({ toolId: existing.id, ...input }, actorOf(req));
      broadcast("crew_tool_changed", { toolId: existing.id });
      res.status(201).json({ grant });
    }),
  );

  app.delete(
    `${base}/tool-grants/:id`,
    wrap((req, res) => {
      const grant = orchestrator.tools.grantById(param(req, "id"));
      const tool = grant ? orchestrator.tools.get(grant.tool_id) : null;
      if (!grant || !tool || tool.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.tools.revoke(grant.id, actorOf(req));
      broadcast("crew_tool_changed", { toolId: tool.id });
      res.json({ ok: true });
    }),
  );

  // Owner only. Disabling a tool is how an owner takes a capability away —
  // pack uninstall disables the pack's tools and deliberately keeps the
  // grants, so that an owner who reinstalls does not have to re-grant
  // everything. The consequence is that re-enabling restores every surviving
  // grant at a stroke, which makes this the same kind of act as granting one:
  // an operator flipping it back would undo an owner's decision without ever
  // touching a grant.
  app.post(
    `${base}/tools/:id/enabled`,
    ownerOnly,
    wrap((req, res) => {
      const existing = orchestrator.tools.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { enabled } = toolEnabledSchema.parse(req.body ?? {});
      const tool = orchestrator.tools.setEnabled(existing.id, enabled, actorOf(req));
      broadcast("crew_tool_changed", { toolId: existing.id, enabled });
      res.json({ tool });
    }),
  );

  // --- web search ---------------------------------------------------------
  //
  // The search endpoint takes an agent id and goes through the tool gate, so
  // the API cannot be the way around a grant an operator did not give.

  app.get(
    `${base}/search-providers`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listSearchProviderKinds();
      const providers = await Promise.all(
        kinds.map(async (kind) => ({ kind, registered: true, ...(await orchestrator.testSearchProvider(kind)) })),
      );
      res.json({ providers });
    }),
  );

  app.post(
    `${base}/search`,
    wrap(async (req, res) => {
      const input = searchSchema.parse(req.body ?? {});
      const result = await orchestrator.searchWeb(
        companyId,
        input.agentId,
        { query: input.query, limit: input.limit, language: input.language, safeSearch: input.safeSearch },
        { kind: input.kind, projectId: input.projectId, taskId: input.taskId },
      );

      if (result.outcome === "denied") {
        res.status(403).json({ error: "tool_denied", message: "Dieser Agent darf die Websuche nicht verwenden." });
        return;
      }
      if (result.outcome === "approval_required") {
        broadcast("crew_approval_changed", { approvalId: result.approvalId });
        res.status(202).json({ approvalRequired: true, approvalId: result.approvalId });
        return;
      }
      res.json({ provider: result.provider, results: result.results, prompt: result.prompt });
    }),
  );

  // --- routines: recurring work that leaves a trace -------------------------
  //
  // Firing a routine is not an action endpoint. It creates a task, so the
  // owner sees on the board exactly what a timer asked for — the alternative,
  // a scheduler that quietly does things, is invisible to the board, the
  // approval gates, the budget engine and the audit log alike.

  app.get(
    `${base}/routines`,
    wrap((_req, res) => {
      res.json({ routines: orchestrator.routines.list(companyId) });
    }),
  );

  app.post(
    `${base}/routines`,
    wrap((req, res) => {
      const input = createRoutineSchema.parse(req.body ?? {});
      const routine = orchestrator.routines.create({ companyId, ...input }, actorOf(req));
      broadcast("crew_routine_changed", { routineId: routine.id });
      res.status(201).json({ routine });
    }),
  );

  app.patch(
    `${base}/routines/:id`,
    wrap((req, res) => {
      const existing = orchestrator.routines.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch = updateRoutineSchema.parse(req.body ?? {});
      const routine = orchestrator.routines.update(existing.id, patch, actorOf(req));
      broadcast("crew_routine_changed", { routineId: existing.id });
      res.json({ routine });
    }),
  );

  app.post(
    `${base}/routines/:id/enabled`,
    wrap((req, res) => {
      const existing = orchestrator.routines.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { enabled } = toolEnabledSchema.parse(req.body ?? {});
      const routine = orchestrator.routines.setEnabled(existing.id, enabled, actorOf(req));
      broadcast("crew_routine_changed", { routineId: existing.id, enabled });
      res.json({ routine });
    }),
  );

  app.delete(
    `${base}/routines/:id`,
    wrap((req, res) => {
      const existing = orchestrator.routines.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.routines.delete(existing.id, actorOf(req));
      broadcast("crew_routine_changed", { routineId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  /** The operator's "do it now". Produces the same visible task the timer would. */
  app.post(
    `${base}/routines/:id/run`,
    wrap((req, res) => {
      const task = orchestrator.runRoutineNow(companyId, param(req, "id"));
      if (!task) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      broadcast("crew_routine_changed", { routineId: param(req, "id") });
      res.status(201).json({ task });
    }),
  );

  // --- business packs -----------------------------------------------------
  //
  // Installing a pack hires posts, registers tools and changes the org chart,
  // so it is an owner's decision, not an operator's — the same line the rest
  // of this file draws around anything that hands out authority.
  //
  // The listing is deliberately answerable before anything is installed: an
  // operator has to be able to see what a pack would add, and which of its
  // integrations this installation actually has, *before* deciding. That is
  // what "no fake buttons" means in practice — a switch appears configured
  // only when its adapter was registered at boot, which happens only when its
  // environment variables are set.

  const presentPack = (pack: BusinessPack) => {
    const installed = orchestrator.packs.store.byKey(companyId, pack.key);
    return {
      key: pack.key,
      label: pack.label,
      summary: pack.summary,
      version: pack.version,
      installed: installed !== null,
      installedAt: installed?.installed_at ?? null,
      installedVersion: installed?.version ?? null,
      counts: {
        departments: pack.departments.length,
        agents: pack.agents.length,
        tools: pack.tools.length,
        routines: pack.routines.length,
      },
      integrations: pack.integrations.map((integration) => ({
        key: integration.key,
        label: integration.label,
        summary: integration.summary,
        // Registered at boot from the environment, or not there at all.
        configured: orchestrator.hasPackIntegration(integration.key),
        env: integration.env,
        docsUrl: integration.docs_url ?? null,
      })),
    };
  };

  app.get(
    `${base}/packs`,
    wrap((_req, res) => {
      res.json({ packs: BUSINESS_PACKS.map(presentPack) });
    }),
  );

  app.get(
    `${base}/packs/:key`,
    wrap((req, res) => {
      const pack = findPack(param(req, "key"));
      if (!pack) {
        res.status(404).json({ error: "pack_not_found" });
        return;
      }
      // The full definition, so an operator can read what they are about to
      // hire before they hire it.
      res.json({
        pack: presentPack(pack),
        departments: pack.departments,
        agents: pack.agents.map((agent) => ({
          key: agent.key,
          department: agent.department,
          displayName: agent.skin.display_name,
          professionalRole: agent.professional_role,
          roleSummary: agent.role_summary,
          seniority: agent.seniority,
          maxRiskLevel: agent.policy.max_risk_level,
        })),
        tools: pack.tools,
        routines: pack.routines,
      });
    }),
  );

  app.post(
    `${base}/packs/:key/install`,
    ownerOnly,
    wrap((req, res) => {
      const pack = findPack(param(req, "key"));
      if (!pack) {
        res.status(404).json({ error: "pack_not_found" });
        return;
      }
      const result = orchestrator.packs.install(companyId, pack, actorOf(req));
      broadcast("crew_pack_changed", { packKey: pack.key, installed: true });
      res.status(201).json({ ok: true, pack: presentPack(pack), created: result.created, reused: result.reused });
    }),
  );

  app.post(
    `${base}/packs/:key/uninstall`,
    ownerOnly,
    wrap((req, res) => {
      const pack = findPack(param(req, "key"));
      if (!pack) {
        res.status(404).json({ error: "pack_not_found" });
        return;
      }
      const result = orchestrator.packs.uninstall(companyId, pack.key, actorOf(req));
      broadcast("crew_pack_changed", { packKey: pack.key, installed: false });
      // `kept` is part of the answer, not an afterthought: a remover that
      // silently leaves things behind is worse than one that says so.
      res.json({ ok: true, pack: presentPack(pack), ...result });
    }),
  );

  app.post(
    `${base}/packs/:key/integrations/:integration/test`,
    wrap(async (req, res) => {
      const pack = findPack(param(req, "key"));
      const integrationKey = param(req, "integration");
      if (!pack || !pack.integrations.some((i) => i.key === integrationKey)) {
        res.status(404).json({ error: "integration_not_found" });
        return;
      }
      res.json(await orchestrator.testPackIntegration(integrationKey));
    }),
  );

  // --- budgets and costs --------------------------------------------------

  app.get(
    `${base}/budgets`,
    wrap((_req, res) => {
      res.json({ budgets: orchestrator.budgets.status(companyId) });
    }),
  );

  app.put(
    `${base}/budgets`,
    wrap((req, res) => {
      const parsed = budgetSchema.parse(req.body ?? {});
      res.json({ budget: orchestrator.budgets.setBudget({ companyId, ...parsed }) });
    }),
  );

  // --- governance surfaces ------------------------------------------------

  /**
   * The last chain verification, and when it was taken.
   *
   * `verifyAuditChain()` recomputes every hash in `crew_audit_events` for the
   * company — necessarily, since a chain is only sound end to end. That is
   * fine for a deliberate act and ruinous for a poll: the load test measured
   * the dashboard at 8 ms with 820 audit rows and 39 ms with 5,420, linear in
   * a table that only ever grows, while an open Command Center asks for the
   * dashboard on every refresh. A year-old installation would re-hash
   * hundreds of thousands of rows several times a minute, for a number nobody
   * is watching change.
   *
   * So the dashboard reads a cached answer no older than this TTL, and says
   * how old it is instead of pretending it is live. `GET /audit` still
   * verifies for real on every call, because that request *is* somebody
   * asking the question.
   *
   * Worth being clear about what a full verification is even worth: it
   * catches an edit that did not fix the hashes. An attacker who owns the box
   * can recompute the whole chain, and no amount of local verification would
   * notice. That is what the off-box copy is for (docs/AUDIT_SHIPPING.md) —
   * which makes re-hashing on a timer a poor trade at any interval.
   */
  const CHAIN_CACHE_TTL_MS = 60_000;
  let chainCache: { at: number; result: ReturnType<typeof verifyAuditChain> } | null = null;

  function cachedChainCheck(): { at: number; result: ReturnType<typeof verifyAuditChain> } {
    const now = Date.now();
    if (!chainCache || now - chainCache.at >= CHAIN_CACHE_TTL_MS) {
      chainCache = { at: now, result: verifyAuditChain(db, companyId) };
    }
    return chainCache;
  }

  app.get(
    `${base}/audit`,
    wrap((req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 1000);
      // Verified for real, and the cache refreshed from it: somebody asking
      // this question directly should not then see a stale answer on the
      // dashboard beside it.
      chainCache = { at: Date.now(), result: verifyAuditChain(db, companyId) };
      res.json({
        events: listAuditEvents(db, companyId, { limit }),
        chain: chainCache.result,
      });
    }),
  );

  /**
   * Where the off-box copy of the audit chain stands.
   *
   * Reports "not configured" rather than 404 when no sink was registered: an
   * operator looking at this page is asking "is my audit log leaving this
   * machine?", and a 404 answers a different question. Readable by any
   * signed-in user — how far behind the archive is, is not a secret, and the
   * one thing that *is* (the collector's token) never appears here.
   */
  app.get(
    `${base}/audit/shipping`,
    wrap((_req, res) => {
      const shipper = orchestrator.auditShipper;
      if (!shipper) {
        res.json({
          configured: false,
          message:
            "Kein Ziel konfiguriert. Ohne Kopie ausser Haus kann eine Übernahme dieses Rechners die eigene Spur löschen.",
        });
        return;
      }
      res.json({
        configured: true,
        sink: shipper.sinkKind,
        cursor: shipper.cursor(companyId),
        pending: shipper.pending(companyId),
        // Reported here, not only after a drain. A gap means rows below the
        // next unshipped entry are gone from the table, which is what a
        // deletion looks like — and it was previously visible only to
        // whoever pressed "übertragen".
        gapDetected: shipper.gapAhead(companyId),
        // How the last attempt went. Without this the panel can say "17
        // waiting" but not "and nothing has left since 06:00" — and a backlog
        // looks identical whether it is a minute or a week old. The message
        // is already redacted by the shipper; the collector's token has never
        // been in it.
        health: shipper.health(companyId),
      });
    }),
  );

  app.post(
    `${base}/audit/shipping/test`,
    ownerOnly,
    wrap(async (_req, res) => {
      const shipper = orchestrator.auditShipper;
      if (!shipper) {
        res.status(409).json({ error: "not_configured", message: "Kein Audit-Ziel konfiguriert." });
        return;
      }
      // 200 with ok:false, like the secret-provider probe: "the collector is
      // unreachable right now" is a status a page displays, not a failure of
      // the request that asked.
      res.json(await shipper.testConnection());
    }),
  );

  app.post(
    `${base}/audit/shipping/run`,
    ownerOnly,
    wrap(async (_req, res) => {
      const shipper = orchestrator.auditShipper;
      if (!shipper) {
        res.status(409).json({ error: "not_configured", message: "Kein Audit-Ziel konfiguriert." });
        return;
      }
      // The scheduler ships on its own; this is for the operator who has just
      // fixed the collector and wants to watch the backlog drain rather than
      // wonder whether the next tick will work.
      const result = await shipper.drain(companyId);
      broadcast("crew_audit_shipped", { shipped: result.shipped, pending: result.pending });
      res.json(result);
    }),
  );

  app.get(
    `${base}/vendor-policy`,
    wrap((_req, res) => {
      const policy = getVendorPolicy();
      res.json({
        version: policy.version,
        policyName: policy.policy_name,
        allowedFamilies: policy.allowed_families,
        blockedFamilies: policy.blocked_families.map((f) => ({ id: f.id, reason: f.reason })),
        openrouter: policy.openrouter,
        telemetry: policy.telemetry,
      });
    }),
  );

  /**
   * Model admission check. This is the same call the execution path makes, so
   * the UI cannot show a model as usable that the backend would refuse.
   */
  app.post(
    `${base}/vendor-policy/check`,
    wrap((req, res) => {
      const { model, provider } = modelCheckSchema.parse(req.body ?? {});
      const decision = evaluateModel(getVendorPolicy(), model, provider);
      res.status(decision.allowed ? 200 : 403).json({ model, provider: provider ?? null, decision });
    }),
  );

  app.post(
    `${base}/vendor-policy/filter`,
    wrap((req, res) => {
      const models = z
        .array(z.object({ id: z.string(), provider: z.string().optional() }))
        .parse((req.body ?? {}).models ?? []);
      res.json(filterModelCatalogue(getVendorPolicy(), models));
    }),
  );

  // --- dashboard ----------------------------------------------------------

  app.get(
    `${base}/dashboard`,
    wrap((_req, res) => {
      const counts = db
        .prepare("SELECT status, COUNT(*) AS n FROM crew_tasks WHERE company_id = ? GROUP BY status")
        .all(companyId) as unknown as Array<{ status: string; n: number }>;
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
      const agents = orchestrator.listAgents(companyId);
      const agentStates = agents.map((a) => orchestrator.agentStatus(companyId, a.id));

      res.json({
        // Every figure names its source and the moment it was read, so the UI
        // never shows a number without provenance.
        generatedAt: Date.now(),
        source: "crew_tasks / crew_agents / crew_approvals / crew_cost_events (live)",
        tasks: {
          running: byStatus.running ?? 0,
          blocked: byStatus.blocked ?? 0,
          review: byStatus.review ?? 0,
          approvalRequired: byStatus.approval_required ?? 0,
          done: byStatus.done ?? 0,
          failed: byStatus.failed ?? 0,
          total: counts.reduce((sum, c) => sum + c.n, 0),
        },
        agents: {
          total: agents.length,
          working: agentStates.filter((s) => s === "working").length,
          rateLimited: agentStates.filter((s) => s === "rate_limited").length,
          waitingForApproval: agentStates.filter((s) => s === "waiting_for_approval").length,
        },
        approvalsPending: orchestrator.approvals.listPending(companyId).length,
        budgets: orchestrator.budgets.status(companyId),
        // Cached, deliberately — see `cachedChainCheck`. `auditChainCheckedAt`
        // travels with it so the panel can say how old the answer is instead
        // of implying it was taken just now.
        auditChainValid: cachedChainCheck().result.valid,
        auditChainCheckedAt: cachedChainCheck().at,
      });
    }),
  );

  // --- marketplaces: skills and MCP servers from outside this machine -----
  //
  // Browsing and installing are separate on purpose. A catalog is somebody
  // else's JSON that can change between two page loads, so entries are read
  // live (GET .../entries) and never cached as installable commands; only
  // what was actually installed is stored, with its provenance.
  //
  // Install takes an entry *id*, never an entry body: the server re-fetches
  // it from the source, so what lands is what that source offers now rather
  // than a payload a caller composed.

  app.get(
    `${base}/marketplace-kinds`,
    wrap(async (_req, res) => {
      const registered = new Set(orchestrator.listMarketplaceKinds());
      res.json({ kinds: MARKETPLACE_KINDS.map((kind) => ({ kind, registered: registered.has(kind) })) });
    }),
  );

  app.get(
    `${base}/marketplaces`,
    wrap(async (_req, res) => {
      res.json({
        marketplaces: orchestrator.marketplaces.list(companyId),
        installs: orchestrator.marketplaceInstalls(companyId),
      });
    }),
  );

  app.post(
    `${base}/marketplaces`,
    wrap(async (req, res) => {
      const input = createMarketplaceSchema.parse(req.body ?? {});
      const marketplace = orchestrator.marketplaces.create({ companyId, ...input, ...actorOf(req) });
      broadcast("crew_marketplace_changed", { marketplaceId: marketplace.id });
      res.status(201).json({ marketplace });
    }),
  );

  app.patch(
    `${base}/marketplaces/:id`,
    wrap(async (req, res) => {
      const existing = orchestrator.marketplaces.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found", message: "Marketplace not found" });
        return;
      }
      const patch = updateMarketplaceSchema.parse(req.body ?? {});
      const marketplace = orchestrator.marketplaces.update(existing.id, patch, {
        ...actorOf(req),
      });
      broadcast("crew_marketplace_changed", { marketplaceId: existing.id });
      res.json({ marketplace });
    }),
  );

  app.delete(
    `${base}/marketplaces/:id`,
    wrap(async (req, res) => {
      const existing = orchestrator.marketplaces.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found", message: "Marketplace not found" });
        return;
      }
      orchestrator.marketplaces.delete(existing.id, actorOf(req));
      broadcast("crew_marketplace_changed", { marketplaceId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.get(
    `${base}/marketplaces/:id/entries`,
    wrap(async (req, res) => {
      const entries = await orchestrator.browseMarketplace(companyId, param(req, "id"));
      res.json({ entries, marketplace: orchestrator.marketplaces.get(param(req, "id")) });
    }),
  );

  app.post(
    `${base}/marketplaces/:id/install`,
    wrap(async (req, res) => {
      const input = installEntrySchema.parse(req.body ?? {});
      const { install, result } = await orchestrator.installFromMarketplace(
        companyId,
        param(req, "id"),
        input.entryId,
        { env: input.env, headers: input.headers, nameOverride: input.name },
        actorOf(req),
      );
      broadcast("crew_marketplace_changed", { marketplaceId: param(req, "id"), installed: result.name });
      res.status(201).json({ install, result });
    }),
  );

  app.delete(
    `${base}/marketplace-installs/:entryType/:name`,
    wrap(async (req, res) => {
      const entryType = param(req, "entryType");
      if (entryType !== "mcp" && entryType !== "skill") {
        res.status(400).json({ error: "invalid_request", message: 'entryType must be "mcp" or "skill"' });
        return;
      }
      const removed = await orchestrator.uninstallFromMarketplace(companyId, entryType, param(req, "name"), {
        ...actorOf(req),
      });
      if (!removed) {
        res.status(404).json({ error: "not_found", message: "Nothing installed under that name" });
        return;
      }
      broadcast("crew_marketplace_changed", { uninstalled: param(req, "name") });
      res.json({ ok: true });
    }),
  );

  return { orchestrator, companyId, auth, broadcast };
}
