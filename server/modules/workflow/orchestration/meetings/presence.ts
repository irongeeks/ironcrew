import type { DbLike } from "../../../../types/db-like.ts";
import type { Lang } from "../../../../types/lang.ts";

interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
}

type PresenceDeps = {
  db: DbLike;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  meetingPresenceUntil: Map<string, number>;
  meetingSeatIndexByAgent: Map<string, number>;
  meetingPhaseByAgent: Map<string, "kickoff" | "review">;
  meetingTaskIdByAgent: Map<string, string>;
  meetingReviewDecisionByAgent: Map<string, string>;
  summarizeForMeetingBubble: (text: string, maxChars: number, lang?: Lang) => string;
  classifyMeetingReviewDecision: (text: string) => string | null;
};

export function createMeetingPresenceTools(deps: PresenceDeps) {
  const {
    db,
    nowMs,
    broadcast,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
    summarizeForMeetingBubble,
    classifyMeetingReviewDecision,
  } = deps;

  function markAgentInMeeting(
    agentId: string,
    holdMs = 90_000,
    seatIndex?: number,
    phase?: "kickoff" | "review",
    taskId?: string,
  ): void {
    meetingPresenceUntil.set(agentId, nowMs() + holdMs);
    if (typeof seatIndex === "number") {
      meetingSeatIndexByAgent.set(agentId, seatIndex);
    }
    if (phase) {
      meetingPhaseByAgent.set(agentId, phase);
      if (phase === "review") {
        meetingReviewDecisionByAgent.set(agentId, "reviewing");
      } else {
        meetingReviewDecisionByAgent.delete(agentId);
      }
    }
    if (taskId) {
      meetingTaskIdByAgent.set(agentId, taskId);
    }
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    if (row?.status === "break") {
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agentId);
      const updated = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("agent_status", updated);
    }
  }

  function isAgentInMeeting(agentId: string): boolean {
    const until = meetingPresenceUntil.get(agentId);
    if (!until) return false;
    if (until < nowMs()) {
      meetingPresenceUntil.delete(agentId);
      meetingSeatIndexByAgent.delete(agentId);
      meetingPhaseByAgent.delete(agentId);
      meetingTaskIdByAgent.delete(agentId);
      meetingReviewDecisionByAgent.delete(agentId);
      return false;
    }
    return true;
  }

  function callLeadersToCeoOffice(taskId: string, leaders: AgentRow[], phase: "kickoff" | "review"): void {
    leaders.slice(0, 6).forEach((leader, seatIndex) => {
      markAgentInMeeting(leader.id, 600_000, seatIndex, phase, taskId);
      broadcast("ceo_office_call", {
        from_agent_id: leader.id,
        seat_index: seatIndex,
        phase,
        task_id: taskId,
        action: "arrive",
        decision: phase === "review" ? (meetingReviewDecisionByAgent.get(leader.id) ?? "reviewing") : undefined,
      });
    });
  }

  function dismissLeadersFromCeoOffice(taskId: string, leaders: AgentRow[]): void {
    leaders.slice(0, 6).forEach((leader) => {
      meetingPresenceUntil.delete(leader.id);
      meetingSeatIndexByAgent.delete(leader.id);
      meetingPhaseByAgent.delete(leader.id);
      meetingTaskIdByAgent.delete(leader.id);
      meetingReviewDecisionByAgent.delete(leader.id);
      broadcast("ceo_office_call", {
        from_agent_id: leader.id,
        task_id: taskId,
        action: "dismiss",
      });
    });
  }

  function emitMeetingSpeech(
    agentId: string,
    seatIndex: number,
    phase: "kickoff" | "review",
    taskId: string,
    line: string,
    lang?: string,
  ): void {
    const preview = summarizeForMeetingBubble(line, 96, lang as Lang | undefined);
    const decision = phase === "review" ? classifyMeetingReviewDecision(preview) : undefined;
    if (decision) {
      meetingReviewDecisionByAgent.set(agentId, decision);
    } else {
      meetingReviewDecisionByAgent.delete(agentId);
    }
    broadcast("ceo_office_call", {
      from_agent_id: agentId,
      seat_index: seatIndex,
      phase,
      task_id: taskId,
      action: "speak",
      line: preview,
      decision,
    });
  }

  return {
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
  };
}
