import { useMemo } from "react";
import type { MeetingPresence } from "../types";

export function useActiveMeetingTaskId(meetingPresence: MeetingPresence[]): string | null {
  return useMemo(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    for (const row of meetingPresence) {
      if (row.until < now || !row.task_id) continue;
      counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
    }
    let picked: string | null = null;
    let maxCount = -1;
    for (const [taskId, count] of counts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        picked = taskId;
      }
    }
    return picked;
  }, [meetingPresence]);
}
