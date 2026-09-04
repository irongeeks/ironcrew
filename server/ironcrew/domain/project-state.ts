/**
 * IronCrew — project and milestone state machines.
 *
 * Two small, declared transition tables, kept in one file because they are
 * the same size and the same discipline as goal-state.ts: no execution
 * lock, no claiming — just a status a caller cannot silently misuse.
 */

export const PROJECT_STATUSES = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = Object.freeze({
  draft: ["active", "cancelled"],
  active: ["on_hold", "done", "cancelled"],
  on_hold: ["active", "cancelled"],
  done: [],
  cancelled: [],
});

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export class InvalidProjectTransitionError extends Error {
  readonly from: ProjectStatus;
  readonly to: ProjectStatus;
  constructor(from: ProjectStatus, to: ProjectStatus) {
    super(
      `Invalid project transition ${from} -> ${to}. Allowed from "${from}": ` +
        `${PROJECT_TRANSITIONS[from].join(", ") || "(none — terminal state)"}.`,
    );
    this.name = "InvalidProjectTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new InvalidProjectTransitionError(from, to);
}

export const MILESTONE_STATUSES = ["pending", "done", "missed", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const MILESTONE_TRANSITIONS: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = Object.freeze({
  pending: ["done", "missed", "cancelled"],
  // A missed milestone can be rescheduled (back to pending with a new due
  // date) rather than staying a permanent black mark.
  missed: ["pending", "cancelled"],
  done: [],
  cancelled: [],
});

export function isMilestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === "string" && (MILESTONE_STATUSES as readonly string[]).includes(value);
}

export function canTransitionMilestone(from: MilestoneStatus, to: MilestoneStatus): boolean {
  return MILESTONE_TRANSITIONS[from].includes(to);
}

export class InvalidMilestoneTransitionError extends Error {
  readonly from: MilestoneStatus;
  readonly to: MilestoneStatus;
  constructor(from: MilestoneStatus, to: MilestoneStatus) {
    super(
      `Invalid milestone transition ${from} -> ${to}. Allowed from "${from}": ` +
        `${MILESTONE_TRANSITIONS[from].join(", ") || "(none — terminal state)"}.`,
    );
    this.name = "InvalidMilestoneTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertMilestoneTransition(from: MilestoneStatus, to: MilestoneStatus): void {
  if (!canTransitionMilestone(from, to)) throw new InvalidMilestoneTransitionError(from, to);
}
