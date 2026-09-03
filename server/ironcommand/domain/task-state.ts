/**
 * Iron Command OS — task state machine.
 *
 * A real machine, not a status string: every transition is declared here and
 * validated before any write. Illegal transitions are rejected at the store
 * boundary, so a buggy caller cannot park a task in an inconsistent state.
 */

export const TASK_STATUSES = [
  "inbox",
  "planned",
  "ready",
  "assigned",
  "running",
  "waiting",
  "blocked",
  "review",
  "approval_required",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** States that mean "an agent is actively holding this task". */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["assigned", "running"];

/**
 * Allowed transitions.
 *
 * Notes on the less obvious edges:
 *  - `failed` is not terminal: the CEO may request a revision, which sends the
 *    task back to `ready` for another attempt.
 *  - `review` -> `ready` is the revision path (CEO rejected the result).
 *  - Nearly everything may be cancelled, because the CEO can always stop work.
 *  - `running` -> `blocked` covers a dependency discovered mid-run.
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  inbox: ["planned", "ready", "blocked", "cancelled"],
  planned: ["ready", "blocked", "cancelled"],
  ready: ["assigned", "blocked", "approval_required", "cancelled"],
  assigned: ["running", "ready", "blocked", "waiting", "failed", "cancelled"],
  running: ["waiting", "blocked", "review", "approval_required", "done", "failed", "cancelled"],
  waiting: ["running", "ready", "blocked", "failed", "cancelled"],
  blocked: ["ready", "planned", "cancelled", "failed"],
  review: ["done", "ready", "failed", "approval_required", "cancelled"],
  approval_required: ["ready", "running", "review", "done", "failed", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
});

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(from: TaskStatus, to: TaskStatus) {
    super(
      `Invalid task transition ${from} -> ${to}. Allowed from "${from}": ` +
        `${TRANSITIONS[from].join(", ") || "(none — terminal state)"}.`,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Every status reachable from `from` in one step. */
export function nextStates(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

/**
 * Agent status is derived from the work an agent holds, never set by the agent
 * itself. Keeping this a pure function means the UI figure can never disagree
 * with the backend: both read the same derivation.
 */
export const AGENT_STATUSES = [
  "offline",
  "idle",
  "thinking",
  "working",
  "in_meeting",
  "waiting_for_input",
  "waiting_for_approval",
  "rate_limited",
  "paused",
  "error",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface AgentStatusInput {
  online: boolean;
  paused?: boolean;
  rateLimited?: boolean;
  inMeeting?: boolean;
  /** Statuses of the tasks currently assigned to this agent. */
  taskStatuses: readonly TaskStatus[];
  /** True when the agent's most recent run failed. */
  lastRunFailed?: boolean;
}

export function deriveAgentStatus(input: AgentStatusInput): AgentStatus {
  if (!input.online) return "offline";
  if (input.paused) return "paused";
  if (input.rateLimited) return "rate_limited";
  if (input.inMeeting) return "in_meeting";

  const t = input.taskStatuses;
  if (t.includes("approval_required")) return "waiting_for_approval";
  if (t.includes("running")) return "working";
  if (t.includes("waiting")) return "waiting_for_input";
  if (t.includes("assigned")) return "thinking";
  if (input.lastRunFailed) return "error";
  return "idle";
}
