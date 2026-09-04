/**
 * The one status vocabulary the office animates against.
 *
 * Two status types reach this view from different halves of the app: the
 * upstream office model (`idle | working | break | offline`) and IronCrew's
 * own richer agent state (`thinking`, `in_meeting`, `waiting_for_approval`,
 * `rate_limited`, …). Rather than teach the motion code both, each is mapped
 * onto one union here, so `character-motion.ts` deals with a single set of
 * cases and an unknown status can never silently animate as something else.
 */

export const MOTION_STATUSES = [
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

export type AgentStatus = (typeof MOTION_STATUSES)[number];

/**
 * Maps whatever a caller has onto the motion vocabulary.
 *
 * IronCrew's statuses are already the target set and pass through. The
 * upstream office adds `break`, which has no IronCrew equivalent — a figure on
 * a break is idle and wandering, so that is what it animates as. Anything
 * unrecognised becomes `idle`: a figure that stands and breathes is the right
 * answer to "we do not know what this one is doing".
 */
export function toMotionStatus(status: string | null | undefined): AgentStatus {
  if (status && (MOTION_STATUSES as readonly string[]).includes(status)) {
    return status as AgentStatus;
  }
  if (status === "break") return "idle";
  return "idle";
}

/**
 * Whether a figure in this status should be walking around the office.
 *
 * Deliberately narrow: a working agent sits at its desk, and only genuinely
 * unoccupied ones wander. An office where everyone drifts constantly reads as
 * a screensaver rather than as a company at work.
 */
export function wandersWhenIdle(status: AgentStatus): boolean {
  return status === "idle";
}
