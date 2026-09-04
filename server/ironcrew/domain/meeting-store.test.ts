import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { MeetingStore, MeetingMutationError } from "./meeting-store.ts";
import { InvalidMeetingTransitionError } from "./meeting-state.ts";
import { TaskStore } from "./task-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: MeetingStore;
let companyId: string;
let moderatorId: string;
let participantId: string;

beforeEach(() => {
  db = createTestDb();
  store = new MeetingStore(db);
  companyId = seedCompany(db);
  moderatorId = seedAgent(db, companyId, "ea");
  participantId = seedAgent(db, companyId, "cto");
});

afterEach(() => db.close());

function input(overrides: Partial<Parameters<MeetingStore["create"]>[0]> = {}) {
  return {
    companyId,
    topic: "Q3 Roadmap",
    moderatorAgentId: moderatorId,
    participantAgentIds: [participantId],
    ...overrides,
  };
}

describe("create", () => {
  it("schedules a meeting and always includes the moderator as a participant", () => {
    const m = store.create(input());
    expect(m.status).toBe("scheduled");
    expect(m.current_round).toBe(0);
    expect(m.max_rounds).toBe(6);
    const participants = store.participants(m.id).map((p) => p.agent_id);
    expect(participants).toContain(moderatorId);
    expect(participants).toContain(participantId);
  });

  it("clamps max_rounds into [1, 50]", () => {
    expect(store.create(input({ maxRounds: 0 })).max_rounds).toBe(1);
    expect(store.create(input({ maxRounds: 999 })).max_rounds).toBe(50);
  });

  it("rejects an empty topic", () => {
    expect(() => store.create(input({ topic: "  " }))).toThrow(MeetingMutationError);
  });

  it("rejects a moderator or participant that doesn't exist", () => {
    expect(() => store.create(input({ moderatorAgentId: "agt_nope" }))).toThrow(MeetingMutationError);
    expect(() => store.create(input({ participantAgentIds: ["agt_nope"] }))).toThrow(MeetingMutationError);
  });

  it("rejects a participant from a different company", () => {
    const other = seedCompany(db, "Other Co");
    const foreignAgent = seedAgent(db, other, "foreign");
    expect(() => store.create(input({ participantAgentIds: [foreignAgent] }))).toThrow(MeetingMutationError);
  });

  it("rejects a meeting with no one besides the moderator", () => {
    expect(() => store.create(input({ participantAgentIds: [moderatorId] }))).toThrow(MeetingMutationError);
  });
});

describe("lifecycle", () => {
  it("moves scheduled -> in_progress -> completed", () => {
    const m = store.create(input());
    const started = store.start(m.id);
    expect(started?.status).toBe("in_progress");
    expect(started?.started_at).not.toBeNull();

    const ended = store.end(m.id, "Beschlossen: X.");
    expect(ended?.status).toBe("completed");
    expect(ended?.minutes).toBe("Beschlossen: X.");
    expect(ended?.ended_at).not.toBeNull();
  });

  it("rejects completing a meeting that hasn't started", () => {
    const m = store.create(input());
    expect(() => store.end(m.id, "x")).toThrow(InvalidMeetingTransitionError);
  });

  it("rejects any transition out of a terminal state", () => {
    const m = store.create(input());
    store.start(m.id);
    store.end(m.id, "done");
    expect(() => store.start(m.id)).toThrow(InvalidMeetingTransitionError);
    expect(() => store.cancel(m.id)).toThrow(InvalidMeetingTransitionError);
  });

  it("cancel works from scheduled or in_progress", () => {
    const scheduled = store.create(input());
    expect(store.cancel(scheduled.id)?.status).toBe("cancelled");

    const inProgress = store.create(input());
    store.start(inProgress.id);
    expect(store.cancel(inProgress.id)?.status).toBe("cancelled");
  });

  it("get/start/end/cancel return null for a missing id", () => {
    expect(store.get("mtg_nope")).toBeNull();
    expect(store.start("mtg_nope")).toBeNull();
    expect(store.end("mtg_nope", "x")).toBeNull();
    expect(store.cancel("mtg_nope")).toBeNull();
  });
});

describe("turns", () => {
  it("records a turn, advances current_round and accumulates spent_micros", () => {
    const m = store.create(input());
    store.start(m.id);
    store.recordTurn({
      meetingId: m.id,
      round: 1,
      agentId: participantId,
      contribution: "Ich schlage vor...",
      costMicros: 500,
    });
    store.recordTurn({
      meetingId: m.id,
      round: 2,
      agentId: moderatorId,
      contribution: "Einverstanden.",
      costMicros: 300,
    });

    const updated = store.get(m.id)!;
    expect(updated.current_round).toBe(2);
    expect(updated.spent_micros).toBe(800);

    const turns = store.turns(m.id);
    expect(turns.map((t) => t.contribution)).toEqual(["Ich schlage vor...", "Einverstanden."]);
  });

  it("recentTurns returns only the last N, oldest-of-the-window first", () => {
    const m = store.create(input());
    store.start(m.id);
    for (let round = 1; round <= 5; round++) {
      store.recordTurn({ meetingId: m.id, round, agentId: participantId, contribution: `turn ${round}` });
    }
    const recent = store.recentTurns(m.id, 2);
    expect(recent.map((t) => t.contribution)).toEqual(["turn 4", "turn 5"]);
  });

  it("recordTurn throws for a missing meeting", () => {
    expect(() =>
      store.recordTurn({ meetingId: "mtg_nope", round: 1, agentId: participantId, contribution: "x" }),
    ).toThrow(MeetingMutationError);
  });
});

describe("action items", () => {
  it("adds and lists action items, unassigned by default", () => {
    const m = store.create(input());
    const item = store.addActionItem({ meetingId: m.id, description: "Preisseite überarbeiten" });
    expect(item.assigned_agent_id).toBeNull();
    expect(item.task_id).toBeNull();
    expect(store.actionItems(m.id)).toHaveLength(1);
  });

  it("accepts an assigned agent from the same company", () => {
    const m = store.create(input());
    const item = store.addActionItem({ meetingId: m.id, description: "x", assignedAgentId: participantId });
    expect(item.assigned_agent_id).toBe(participantId);
  });

  it("rejects an empty description or an assignee from another company", () => {
    const m = store.create(input());
    expect(() => store.addActionItem({ meetingId: m.id, description: "  " })).toThrow(MeetingMutationError);
    const other = seedCompany(db, "Other Co");
    const foreignAgent = seedAgent(db, other, "foreign");
    expect(() => store.addActionItem({ meetingId: m.id, description: "x", assignedAgentId: foreignAgent })).toThrow(
      MeetingMutationError,
    );
  });

  it("linkActionItemToTask sets task_id", () => {
    const m = store.create(input());
    const item = store.addActionItem({ meetingId: m.id, description: "x" });
    const task = new TaskStore(db).create({ companyId, title: "Preisseite überarbeiten" });
    const linked = store.linkActionItemToTask(item.id, task.id);
    expect(linked?.task_id).toBe(task.id);
  });

  it("linkActionItemToTask returns null for a missing action item", () => {
    expect(store.linkActionItemToTask("action_nope", "task_1")).toBeNull();
  });
});

describe("audit trail", () => {
  it("audits the full lifecycle and the chain stays valid", () => {
    const m = store.create(input());
    store.start(m.id);
    store.recordTurn({ meetingId: m.id, round: 1, agentId: participantId, contribution: "x", costMicros: 10 });
    store.addActionItem({ meetingId: m.id, description: "y" });
    store.end(m.id, "done");

    const result = verifyAuditChain(db, companyId);
    expect(result.valid).toBe(true);

    const actions = db
      .prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC")
      .all(companyId) as Array<{ action: string }>;
    expect(actions.map((a) => a.action)).toEqual([
      "meeting.scheduled",
      "meeting.started",
      "meeting.turn_recorded",
      "meeting.action_item_added",
      "meeting.completed",
    ]);
  });
});
