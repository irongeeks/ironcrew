import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { MessengerPairingError, MessengerPairingStore, PAIRING_CODE_TTL_MS } from "./messenger-pairing-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let companyId: string;
let pairings: MessengerPairingStore;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  pairings = new MessengerPairingStore(db);
});

afterEach(() => db.close());

function inbound(over: Partial<Parameters<MessengerPairingStore["resolve"]>[0]> = {}) {
  return pairings.resolve({
    companyId,
    channelKind: "telegram",
    chatId: "chat_1",
    senderId: "user_42",
    displayName: "Robert",
    ...over,
  });
}

describe("MessengerPairingStore", () => {
  describe("deny by default", () => {
    it("lets an unknown sender do nothing but ask to be paired", () => {
      const decision = inbound();

      expect(decision.allow).toBe("none");
      expect(decision.pairing?.status).toBe("pending");
      expect(decision.pairing?.role).toBe("guest");
      expect(decision.pairing?.pairing_code).toMatch(/^\d{6}$/);
    });

    it("keeps a blocked sender out", () => {
      const first = inbound();
      pairings.block(first.pairing!.id);

      const decision = inbound();
      expect(decision.allow).toBe("none");
      expect(decision.allow === "none" && decision.reason).toBe("blocked");
    });

    it("still refuses a pending sender who keeps writing", () => {
      inbound();
      const again = inbound();
      expect(again.allow).toBe("none");
      expect(again.allow === "none" && again.reason).toBe("pending");
    });

    it("does not create a second row for the same sender", () => {
      inbound();
      inbound();
      expect(pairings.list(companyId)).toHaveLength(1);
    });

    it("treats the same id on a different channel as a different person", () => {
      inbound({ channelKind: "telegram" });
      inbound({ channelKind: "discord" });
      expect(pairings.list(companyId)).toHaveLength(2);
    });

    it("sanitises a display name before the owner ever sees it next to a decision", () => {
      const zwsp = String.fromCodePoint(0x200b);
      const decision = inbound({ displayName: `<|im_start|>Chef${zwsp}` });

      expect(decision.pairing?.display_name).not.toContain("<|im_start|>");
      expect([...(decision.pairing?.display_name ?? "")].some((c) => c.codePointAt(0) === 0x200b)).toBe(false);
    });
  });

  describe("the owner decides what authority a pairing carries", () => {
    it("grants CEO authority only when the owner says owner", () => {
      const { pairing } = inbound();
      pairings.accept(pairing!.id, "owner");

      const decision = inbound();
      // This is the whole point: Robert talking to his own EA.
      expect(decision.allow).toBe("ceo");
    });

    it("routes a guest like incoming mail instead", () => {
      const { pairing } = inbound();
      pairings.accept(pairing!.id, "guest");

      expect(inbound().allow).toBe("guest");
    });

    it("clears the code once accepted, so it cannot be reused", () => {
      const { pairing } = inbound();
      const accepted = pairings.accept(pairing!.id, "owner")!;

      expect(accepted.pairing_code).toBe("");
      expect(accepted.code_expires_at).toBeNull();
      expect(accepted.paired_at).not.toBeNull();
    });

    it("refuses to pair a blocked sender without unblocking first", () => {
      const { pairing } = inbound();
      pairings.block(pairing!.id);

      expect(() => pairings.accept(pairing!.id, "owner")).toThrow(MessengerPairingError);
    });

    it("is idempotent — accepting twice does not change the role", () => {
      const { pairing } = inbound();
      pairings.accept(pairing!.id, "guest");
      const again = pairings.accept(pairing!.id, "owner");

      // A second accept must not quietly escalate an existing pairing.
      expect(again?.role).toBe("guest");
    });
  });

  describe("revoking and blocking are different acts", () => {
    it("revoke takes CEO authority away and returns to pending", () => {
      const { pairing } = inbound();
      pairings.accept(pairing!.id, "owner");
      expect(inbound().allow).toBe("ceo");

      const revoked = pairings.revoke(pairing!.id)!;
      expect(revoked.status).toBe("pending");
      expect(revoked.role).toBe("guest");
      expect(inbound().allow).toBe("none");
    });

    it("unblock returns to pending rather than restoring what was granted", () => {
      const { pairing } = inbound();
      pairings.accept(pairing!.id, "owner");
      pairings.block(pairing!.id);

      const unblocked = pairings.unblock(pairing!.id)!;
      // Unblocking is not re-granting: the decision has to be made again.
      expect(unblocked.status).toBe("pending");
      expect(unblocked.role).toBe("guest");
    });

    it("audits the two as different actions", () => {
      const a = inbound({ senderId: "u1" }).pairing!;
      const b = inbound({ senderId: "u2" }).pairing!;
      pairings.accept(a.id, "owner");
      pairings.revoke(a.id);
      pairings.block(b.id);

      const actions = (
        db.prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq").all(companyId) as Array<{
          action: string;
        }>
      ).map((r) => r.action);

      expect(actions).toContain("messenger.owner_granted");
      expect(actions).toContain("messenger.pairing_revoked");
      expect(actions).toContain("messenger.pairing_blocked");
      expect(verifyAuditChain(db, companyId).valid).toBe(true);
    });

    it("never writes the pairing code into the audit log", () => {
      const { pairing } = inbound();
      const rows = db
        .prepare("SELECT details_json FROM crew_audit_events WHERE company_id = ?")
        .all(companyId) as Array<{ details_json: string }>;

      // A log that carries the code hands it to anyone who can read the log.
      for (const row of rows) {
        expect(row.details_json).not.toContain(pairing!.pairing_code);
      }
    });
  });

  describe("the code expires", () => {
    it("issues a fresh code once the old one has lapsed", () => {
      const t0 = 1_000_000;
      const first = inbound({ now: t0 }).pairing!;

      const later = inbound({ now: t0 + PAIRING_CODE_TTL_MS + 1 }).pairing!;
      expect(later.pairing_code).not.toBe(first.pairing_code);
      expect(later.code_expires_at).toBeGreaterThan(t0 + PAIRING_CODE_TTL_MS);
    });

    it("keeps the same code while it is still valid", () => {
      const t0 = 1_000_000;
      const first = inbound({ now: t0 }).pairing!;
      const soon = inbound({ now: t0 + 1000 }).pairing!;
      expect(soon.pairing_code).toBe(first.pairing_code);
    });
  });

  it("follows the sender when they write from a new chat", () => {
    const { pairing } = inbound({ chatId: "chat_1" });
    pairings.accept(pairing!.id, "owner");

    const moved = inbound({ chatId: "chat_2" });
    // Replies must go where the message came from, not where it first did.
    expect(moved.pairing?.chat_id).toBe("chat_2");
  });

  it("returns null for a pairing that does not exist", () => {
    expect(pairings.get("pair_nope")).toBeNull();
    expect(pairings.accept("pair_nope", "owner")).toBeNull();
    expect(pairings.block("pair_nope")).toBeNull();
    expect(pairings.revoke("pair_nope")).toBeNull();
  });
});
