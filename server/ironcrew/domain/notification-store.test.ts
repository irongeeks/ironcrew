import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { NotificationStore } from "./notification-store.ts";

let db: DatabaseSync;
let store: NotificationStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new NotificationStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

describe("create / read", () => {
  it("persists a notification with defaults", () => {
    const n = store.create({ companyId, kind: "approval_required", title: "Freigabe nötig" });
    expect(n.company_id).toBe(companyId);
    expect(n.severity).toBe("info");
    expect(n.read_at).toBeNull();
  });

  it("carries an approval reference", () => {
    const n = store.create({ companyId, kind: "approval_required", title: "x", approvalId: "apr_1" });
    expect(n.approval_id).toBe("apr_1");
  });
});

describe("list", () => {
  it("orders newest first", () => {
    const a = store.create({ companyId, kind: "x", title: "A" });
    const b = store.create({ companyId, kind: "x", title: "B" });
    expect(store.list(companyId).map((n) => n.id)).toEqual([b.id, a.id]);
  });

  it("filters to unread only", () => {
    const a = store.create({ companyId, kind: "x", title: "A" });
    const b = store.create({ companyId, kind: "x", title: "B" });
    store.markRead(a.id);
    expect(store.list(companyId, { unreadOnly: true }).map((n) => n.id)).toEqual([b.id]);
  });

  it("is scoped to the company", () => {
    const other = seedCompany(db, "Other Co");
    store.create({ companyId: other, kind: "x", title: "foreign" });
    expect(store.list(companyId)).toEqual([]);
  });
});

describe("countUnread", () => {
  it("counts only unread notifications", () => {
    const a = store.create({ companyId, kind: "x", title: "A" });
    store.create({ companyId, kind: "x", title: "B" });
    expect(store.countUnread(companyId)).toBe(2);
    store.markRead(a.id);
    expect(store.countUnread(companyId)).toBe(1);
  });
});

describe("markRead", () => {
  it("is idempotent — the first read time sticks", () => {
    const n = store.create({ companyId, kind: "x", title: "A" });
    const first = store.markRead(n.id, 1000);
    const second = store.markRead(n.id, 2000);
    expect(first!.read_at).toBe(1000);
    expect(second!.read_at).toBe(1000);
  });

  it("returns null for a notification that does not exist", () => {
    expect(store.markRead("ntf_nope")).toBeNull();
  });
});

describe("markReadByApproval", () => {
  it("marks every notification referencing that approval as read", () => {
    const n = store.create({ companyId, kind: "approval_required", title: "x", approvalId: "apr_1" });
    store.markReadByApproval(companyId, "apr_1", 5000);
    expect(store.get(n.id)!.read_at).toBe(5000);
  });

  it("is a no-op when nothing references the approval", () => {
    expect(() => store.markReadByApproval(companyId, "apr_nope")).not.toThrow();
  });
});
