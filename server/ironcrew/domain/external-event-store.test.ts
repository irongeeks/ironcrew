import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { ExternalEventStore } from "./external-event-store.ts";

let db: DatabaseSync;
let companyId: string;
let events: ExternalEventStore;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  events = new ExternalEventStore(db);
});

afterEach(() => db.close());

function arrive(over: Partial<Parameters<ExternalEventStore["record"]>[0]> = {}) {
  return events.record({
    companyId,
    sourceKind: "discord",
    sourceId: "chan_1",
    externalId: "msg_1",
    eventType: "message",
    payload: { text: "Status zum Deployment?" },
    ...over,
  });
}

describe("ExternalEventStore", () => {
  describe("dedupe — the whole point", () => {
    it("records a first arrival as new", () => {
      const { event, isNew } = arrive();
      expect(isNew).toBe(true);
      expect(event.external_id).toBe("msg_1");
      expect(event.delivery_count).toBe(1);
    });

    it("recognises the same event arriving again", () => {
      arrive();
      const second = arrive();

      expect(second.isNew).toBe(false);
      // A caller acting only on isNew gets at-most-once for free.
      expect(second.event.delivery_count).toBe(2);
      expect(events.list(companyId)).toHaveLength(1);
    });

    it("keeps the payload of the delivery that was acted on", () => {
      arrive({ payload: { text: "original" } });
      const second = arrive({ payload: { text: "changed" } });

      // Overwriting would make the record disagree with what happened.
      expect(events.payloadOf(second.event)).toEqual({ text: "original" });
    });

    it("separates two sources of the same kind", () => {
      arrive({ sourceId: "chan_1" });
      const other = arrive({ sourceId: "chan_2" });

      expect(other.isNew).toBe(true);
      expect(events.list(companyId)).toHaveLength(2);
    });

    it("separates the same id from different source kinds", () => {
      arrive({ sourceKind: "discord" });
      expect(arrive({ sourceKind: "telegram" }).isNew).toBe(true);
    });

    it("separates companies", () => {
      const other = seedCompany(db, "Other");
      arrive();
      expect(arrive({ companyId: other }).isNew).toBe(true);
      expect(events.list(companyId)).toHaveLength(1);
      expect(events.list(other)).toHaveLength(1);
    });

    it("makes a redelivery storm visible rather than silent", () => {
      for (let i = 0; i < 12; i++) arrive();
      expect(events.list(companyId)[0].delivery_count).toBe(12);
    });
  });

  describe("seen and handled are different states", () => {
    it("starts seen but unhandled", () => {
      const { event } = arrive();
      expect(event.handled_at).toBeNull();
      expect(events.unhandled(companyId).map((e) => e.id)).toEqual([event.id]);
    });

    it("records what acted on it and what it produced", () => {
      const { event } = arrive();
      const handled = events.markHandled(event.id, "mail-triage", { taskId: null });

      expect(handled?.handled_at).not.toBeNull();
      expect(handled?.handler).toBe("mail-triage");
      expect(events.unhandled(companyId)).toHaveLength(0);
    });

    it("does not rewrite history when marked twice", () => {
      const { event } = arrive();
      const first = events.markHandled(event.id, "first-handler", { now: 1_000 });
      const second = events.markHandled(event.id, "second-handler", { now: 9_999 });

      // A retry that eventually succeeded should not claim it was always fine.
      expect(second?.handler).toBe("first-handler");
      expect(second?.handled_at).toBe(first?.handled_at);
    });

    it("finds exactly what a crash between recording and handling leaves", () => {
      const a = arrive({ externalId: "msg_a" });
      arrive({ externalId: "msg_b" });
      events.markHandled(a.event.id, "handler");

      expect(events.unhandled(companyId).map((e) => e.external_id)).toEqual(["msg_b"]);
    });

    it("returns unhandled events oldest first, so nothing starves", () => {
      const a = arrive({ externalId: "a" });
      const b = arrive({ externalId: "b" });
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(5000, a.event.id);
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(1000, b.event.id);

      expect(events.unhandled(companyId).map((e) => e.external_id)).toEqual(["b", "a"]);
    });

    it("returns null for an event that does not exist", () => {
      expect(events.markHandled("xevt_nope", "h")).toBeNull();
    });
  });

  describe("replay", () => {
    it("reopens a handled event without touching what arrived", () => {
      const { event } = arrive({ payload: { text: "was da war" } });
      events.markHandled(event.id, "triage");

      const replayed = events.replay(event.id)!;
      expect(replayed.handled_at).toBeNull();
      expect(replayed.handler).toBe("");
      // Replay runs the current handler against the real input. Altering the
      // payload would be rewriting the input to get a wanted output.
      expect(events.payloadOf(replayed)).toEqual({ text: "was da war" });
      expect(events.unhandled(companyId)).toHaveLength(1);
    });

    it("unlinks the earlier task rather than deleting it", () => {
      const { event } = arrive();
      events.markHandled(event.id, "triage", { taskId: null });

      const replayed = events.replay(event.id)!;
      // The first attempt's task may carry work, comments or decisions; it is
      // left to be dealt with deliberately.
      expect(replayed.task_id).toBeNull();
    });

    it("does not resurrect the delivery count", () => {
      arrive();
      arrive();
      const { event } = arrive();
      events.markHandled(event.id, "h");

      expect(events.replay(event.id)?.delivery_count).toBe(3);
    });

    it("returns null for an unknown event", () => {
      expect(events.replay("xevt_nope")).toBeNull();
    });
  });

  describe("listing and pruning", () => {
    it("narrows to one source kind, and to one source", () => {
      arrive({ sourceKind: "discord", sourceId: "chan_1", externalId: "1" });
      arrive({ sourceKind: "discord", sourceId: "chan_2", externalId: "2" });
      arrive({ sourceKind: "telegram", sourceId: "chat_1", externalId: "3" });

      expect(events.list(companyId)).toHaveLength(3);
      expect(events.list(companyId, { sourceKind: "discord" })).toHaveLength(2);
      expect(events.list(companyId, { sourceKind: "discord", sourceId: "chan_2" })).toHaveLength(1);
    });

    it("lists newest first", () => {
      const a = arrive({ externalId: "old" });
      const b = arrive({ externalId: "new" });
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(1000, a.event.id);
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(9000, b.event.id);

      expect(events.list(companyId).map((e) => e.external_id)).toEqual(["new", "old"]);
    });

    it("prunes old handled events", () => {
      const { event } = arrive();
      events.markHandled(event.id, "h");
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(1000, event.id);

      expect(events.prune(companyId, 500, 10_000)).toBe(1);
      expect(events.list(companyId)).toHaveLength(0);
    });

    it("never prunes an unhandled event", () => {
      const { event } = arrive();
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(1000, event.id);

      // Outstanding work. Pruning it would lose an arrival nobody acted on.
      expect(events.prune(companyId, 500, 10_000)).toBe(0);
      expect(events.list(companyId)).toHaveLength(1);
    });

    it("does not prune across companies", () => {
      const other = seedCompany(db, "Other");
      const { event } = arrive({ companyId: other });
      events.markHandled(event.id, "h");
      db.prepare("UPDATE crew_external_events SET received_at = ? WHERE id = ?").run(1000, event.id);

      expect(events.prune(companyId, 500, 10_000)).toBe(0);
      expect(events.list(other)).toHaveLength(1);
    });
  });

  describe("payloadOf", () => {
    it("returns an object for a stored payload", () => {
      const { event } = arrive({ payload: { a: 1, b: "zwei" } });
      expect(events.payloadOf(event)).toEqual({ a: 1, b: "zwei" });
    });

    it("returns an empty object rather than throwing on anything unreadable", () => {
      const { event } = arrive();
      db.prepare("UPDATE crew_external_events SET payload_json = ? WHERE id = ?").run("not json", event.id);
      expect(events.payloadOf(events.get(event.id)!)).toEqual({});

      db.prepare("UPDATE crew_external_events SET payload_json = ? WHERE id = ?").run("[1,2]", event.id);
      expect(events.payloadOf(events.get(event.id)!)).toEqual({});
    });
  });
});
