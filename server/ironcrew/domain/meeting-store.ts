/**
 * IronCrew — meeting repository.
 *
 * A meeting has a moderator and a bounded number of rounds — one round is
 * one participant's turn, not every participant every round, so total
 * turns are O(max_rounds) rather than O(participants x rounds); see the
 * migration's own comment and orchestrator.ts#runMeetingTurn for where the
 * rest of that discipline (a bounded recent-turns prompt window, a spend
 * cap) lives. This store only persists the outcome of each turn — the
 * actual runtime dispatch happens in the orchestrator, same division of
 * responsibility as task execution.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { assertMeetingTransition, type MeetingStatus } from "./meeting-state.ts";

export interface MeetingRow {
  id: string;
  company_id: string;
  project_id: string | null;
  topic: string;
  status: MeetingStatus;
  moderator_agent_id: string;
  max_rounds: number;
  budget_micros: number;
  spent_micros: number;
  current_round: number;
  minutes: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface MeetingParticipant {
  agent_id: string;
  key: string;
  display_name: string;
  professional_role: string;
}

export interface MeetingTurnRow {
  id: string;
  meeting_id: string;
  round: number;
  agent_id: string;
  contribution: string;
  cost_micros: number;
  created_at: number;
}

export interface MeetingActionItemRow {
  id: string;
  meeting_id: string;
  description: string;
  assigned_agent_id: string | null;
  task_id: string | null;
  created_at: number;
}

export interface CreateMeetingInput {
  companyId: string;
  projectId?: string | null;
  topic: string;
  moderatorAgentId: string;
  participantAgentIds: string[];
  maxRounds?: number;
  budgetMicros?: number;
  actorType?: ActorType;
  actorId?: string;
}

export class MeetingMutationError extends Error {}

export class MeetingStore {
  constructor(private readonly db: DatabaseSync) {}

  private assertAgent(companyId: string, agentId: string): void {
    const agent = oneRow<{ company_id: string }>(
      this.db.prepare("SELECT company_id FROM crew_agents WHERE id = ?"),
      agentId,
    );
    if (!agent) throw new MeetingMutationError(`Agent "${agentId}" does not exist.`);
    if (agent.company_id !== companyId) {
      throw new MeetingMutationError("A meeting's participants must belong to the same company.");
    }
  }

  create(input: CreateMeetingInput): MeetingRow {
    if (!input.topic.trim()) throw new MeetingMutationError("A meeting needs a topic.");
    this.assertAgent(input.companyId, input.moderatorAgentId);
    for (const agentId of input.participantAgentIds) this.assertAgent(input.companyId, agentId);

    // The moderator is always a participant, even if the caller didn't list them.
    const participantIds = [...new Set([input.moderatorAgentId, ...input.participantAgentIds])];
    if (participantIds.length < 2) {
      throw new MeetingMutationError("A meeting needs at least one participant besides the moderator.");
    }

    const id = newId("mtg");
    const maxRounds = Math.max(1, Math.min(input.maxRounds ?? 6, 50));
    this.db
      .prepare(
        `INSERT INTO crew_meetings (id, company_id, project_id, topic, moderator_agent_id, max_rounds, budget_micros)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.projectId ?? null,
        input.topic,
        input.moderatorAgentId,
        maxRounds,
        Math.max(0, input.budgetMicros ?? 0),
      );

    const insertParticipant = this.db.prepare(
      "INSERT INTO crew_meeting_participants (id, meeting_id, agent_id) VALUES (?,?,?)",
    );
    for (const agentId of participantIds) insertParticipant.run(newId("mtg"), id, agentId);

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "meeting.scheduled",
      entityType: "meeting",
      entityId: id,
      details: { topic: input.topic, maxRounds, participantCount: participantIds.length },
    });

    return this.get(id)!;
  }

  get(id: string): MeetingRow | null {
    return oneRow<MeetingRow>(this.db.prepare("SELECT * FROM crew_meetings WHERE id = ?"), id);
  }

  list(companyId: string, opts: { status?: MeetingStatus; projectId?: string } = {}): MeetingRow[] {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    return allRows<MeetingRow>(
      this.db.prepare(`SELECT * FROM crew_meetings WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC`),
      ...params,
    );
  }

  participants(meetingId: string): MeetingParticipant[] {
    return allRows<MeetingParticipant>(
      this.db.prepare(
        `SELECT a.id AS agent_id, a.key, a.display_name, a.professional_role
         FROM crew_meeting_participants p
         JOIN crew_agents a ON a.id = p.agent_id
         WHERE p.meeting_id = ?
         ORDER BY p.rowid ASC`,
      ),
      meetingId,
    );
  }

  start(meetingId: string, opts: { actorType?: ActorType; actorId?: string } = {}): MeetingRow | null {
    const meeting = this.get(meetingId);
    if (!meeting) return null;
    assertMeetingTransition(meeting.status, "in_progress");

    this.db
      .prepare("UPDATE crew_meetings SET status = 'in_progress', started_at = unixepoch()*1000 WHERE id = ?")
      .run(meetingId);

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "meeting.started",
      entityType: "meeting",
      entityId: meetingId,
      details: {},
    });
    return this.get(meetingId);
  }

  recordTurn(input: {
    meetingId: string;
    round: number;
    agentId: string;
    contribution: string;
    costMicros?: number;
    actorType?: ActorType;
    actorId?: string;
  }): MeetingTurnRow {
    const meeting = this.get(input.meetingId);
    if (!meeting) throw new MeetingMutationError(`Meeting "${input.meetingId}" does not exist.`);

    const id = newId("turn");
    const costMicros = Math.max(0, input.costMicros ?? 0);
    this.db
      .prepare(
        `INSERT INTO crew_meeting_turns (id, meeting_id, round, agent_id, contribution, cost_micros)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, input.meetingId, input.round, input.agentId, input.contribution, costMicros);

    this.db
      .prepare(
        `UPDATE crew_meetings SET current_round = ?, spent_micros = spent_micros + ? WHERE id = ?`,
      )
      .run(input.round, costMicros, input.meetingId);

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? input.agentId,
      action: "meeting.turn_recorded",
      entityType: "meeting",
      entityId: input.meetingId,
      details: { round: input.round, agentId: input.agentId, costMicros },
    });

    return oneRow<MeetingTurnRow>(this.db.prepare("SELECT * FROM crew_meeting_turns WHERE id = ?"), id)!;
  }

  turns(meetingId: string): MeetingTurnRow[] {
    return allRows<MeetingTurnRow>(
      this.db.prepare("SELECT * FROM crew_meeting_turns WHERE meeting_id = ? ORDER BY round ASC, rowid ASC"),
      meetingId,
    );
  }

  /** Bounded window of the most recent turns — never the whole transcript. */
  recentTurns(meetingId: string, limit: number): MeetingTurnRow[] {
    const rows = allRows<MeetingTurnRow>(
      this.db.prepare("SELECT * FROM crew_meeting_turns WHERE meeting_id = ? ORDER BY round DESC, rowid DESC LIMIT ?"),
      meetingId,
      Math.max(1, limit),
    );
    return rows.reverse();
  }

  end(
    meetingId: string,
    minutes: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): MeetingRow | null {
    const meeting = this.get(meetingId);
    if (!meeting) return null;
    assertMeetingTransition(meeting.status, "completed");

    this.db
      .prepare("UPDATE crew_meetings SET status = 'completed', ended_at = unixepoch()*1000, minutes = ? WHERE id = ?")
      .run(minutes, meetingId);

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "meeting.completed",
      entityType: "meeting",
      entityId: meetingId,
      details: { rounds: meeting.current_round, spentMicros: meeting.spent_micros },
    });
    return this.get(meetingId);
  }

  cancel(meetingId: string, opts: { actorType?: ActorType; actorId?: string } = {}): MeetingRow | null {
    const meeting = this.get(meetingId);
    if (!meeting) return null;
    assertMeetingTransition(meeting.status, "cancelled");

    this.db.prepare("UPDATE crew_meetings SET status = 'cancelled', ended_at = unixepoch()*1000 WHERE id = ?").run(
      meetingId,
    );

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "meeting.cancelled",
      entityType: "meeting",
      entityId: meetingId,
      details: {},
    });
    return this.get(meetingId);
  }

  addActionItem(input: {
    meetingId: string;
    description: string;
    assignedAgentId?: string | null;
    actorType?: ActorType;
    actorId?: string;
  }): MeetingActionItemRow {
    const meeting = this.get(input.meetingId);
    if (!meeting) throw new MeetingMutationError(`Meeting "${input.meetingId}" does not exist.`);
    if (!input.description.trim()) throw new MeetingMutationError("An action item needs a description.");
    if (input.assignedAgentId) this.assertAgent(meeting.company_id, input.assignedAgentId);

    const id = newId("action");
    this.db
      .prepare(
        `INSERT INTO crew_meeting_action_items (id, meeting_id, description, assigned_agent_id)
         VALUES (?,?,?,?)`,
      )
      .run(id, input.meetingId, input.description, input.assignedAgentId ?? null);

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "meeting.action_item_added",
      entityType: "meeting",
      entityId: input.meetingId,
      details: { description: input.description, assignedAgentId: input.assignedAgentId ?? null },
    });

    return oneRow<MeetingActionItemRow>(this.db.prepare("SELECT * FROM crew_meeting_action_items WHERE id = ?"), id)!;
  }

  actionItems(meetingId: string): MeetingActionItemRow[] {
    return allRows<MeetingActionItemRow>(
      this.db.prepare("SELECT * FROM crew_meeting_action_items WHERE meeting_id = ? ORDER BY rowid ASC"),
      meetingId,
    );
  }

  getActionItem(id: string): MeetingActionItemRow | null {
    return oneRow<MeetingActionItemRow>(this.db.prepare("SELECT * FROM crew_meeting_action_items WHERE id = ?"), id);
  }

  linkActionItemToTask(
    actionItemId: string,
    taskId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): MeetingActionItemRow | null {
    const item = this.getActionItem(actionItemId);
    if (!item) return null;
    const meeting = this.get(item.meeting_id)!;

    this.db.prepare("UPDATE crew_meeting_action_items SET task_id = ? WHERE id = ?").run(taskId, actionItemId);

    appendAuditEvent(this.db, {
      companyId: meeting.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "meeting.action_item_converted",
      entityType: "meeting",
      entityId: item.meeting_id,
      taskId,
      details: { actionItemId },
    });

    return this.getActionItem(actionItemId);
  }
}
