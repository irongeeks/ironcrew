/**
 * IronCrew — meeting state machine.
 *
 * Mirrors task-state.ts's discipline for a much lighter-weight entity: no
 * execution lock, just a small, honest transition table.
 */

export const MEETING_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export class InvalidMeetingTransitionError extends Error {}

export function canTransitionMeeting(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_TRANSITIONS[from].includes(to);
}

export function assertMeetingTransition(from: MeetingStatus, to: MeetingStatus): void {
  if (!canTransitionMeeting(from, to)) {
    throw new InvalidMeetingTransitionError(`Cannot move a meeting from "${from}" to "${to}".`);
  }
}
