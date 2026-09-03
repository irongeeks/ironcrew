/**
 * Iron Command OS — goal state machine.
 *
 * Deliberately smaller than task-state.ts: a goal is a strategic statement
 * ("grow revenue 20%"), not an execution pipeline, so it has no claiming, no
 * lock, no execution-run relationship. What it shares with tasks is the same
 * discipline — every transition is declared here and validated before any
 * write, so a caller cannot silently park a goal in a state nothing reaches.
 */

export const GOAL_STATUSES = ["active", "achieved", "abandoned", "on_hold"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Terminal: a goal that has been reached or given up on stays that way. */
export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = ["achieved", "abandoned"];

export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = Object.freeze({
  active: ["achieved", "abandoned", "on_hold"],
  on_hold: ["active", "abandoned"],
  achieved: [],
  abandoned: [],
});

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

export class InvalidGoalTransitionError extends Error {
  readonly from: GoalStatus;
  readonly to: GoalStatus;
  constructor(from: GoalStatus, to: GoalStatus) {
    super(
      `Invalid goal transition ${from} -> ${to}. Allowed from "${from}": ` +
        `${GOAL_TRANSITIONS[from].join(", ") || "(none — terminal state)"}.`,
    );
    this.name = "InvalidGoalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!canTransitionGoal(from, to)) throw new InvalidGoalTransitionError(from, to);
}
