import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { MailboxStore, MailboxMutationError } from "./mailbox-store.ts";
import { createTestCredentialCipher } from "../mail/mail-credentials.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: MailboxStore;
let companyId: string;
let agentA: string;
let agentB: string;

beforeEach(() => {
  db = createTestDb();
  store = new MailboxStore(db, createTestCredentialCipher());
  companyId = seedCompany(db);
  agentA = seedAgent(db, companyId, "cto");
  agentB = seedAgent(db, companyId, "ciso");
});

afterEach(() => db.close());

function imapInput(overrides: Partial<Parameters<MailboxStore["create"]>[0]> = {}) {
  return {
    companyId,
    label: "Support",
    kind: "imap" as const,
    emailAddress: "support@example.com",
    host: "imap.example.com",
    port: 993,
    username: "support@example.com",
    credentials: { password: "hunter2" },
    ...overrides,
  };
}

describe("create", () => {
  it("connects an IMAP mailbox with sensible defaults", () => {
    const m = store.create(imapInput());
    expect(m.kind).toBe("imap");
    expect(m.use_tls).toBe(1);
    expect(m.poll_enabled).toBe(0);
    expect(m.auto_triage).toBe(0);
    expect(m.poll_interval_seconds).toBe(300);
  });

  it("never exposes credentials on the row it returns", () => {
    const m = store.create(imapInput());
    expect(JSON.stringify(m)).not.toMatch(/hunter2/);
    expect(m).not.toHaveProperty("credentials_encrypted");
  });

  it("stores credentials encrypted, reachable only through readCredentials()", () => {
    const m = store.create(imapInput());
    expect(store.readCredentials(m.id).password).toBe("hunter2");

    const raw = db.prepare("SELECT credentials_encrypted FROM crew_mailboxes WHERE id = ?").get(m.id) as {
      credentials_encrypted: string;
    };
    expect(raw.credentials_encrypted).not.toMatch(/hunter2/);
  });

  it("rejects a duplicate label within one company", () => {
    store.create(imapInput());
    expect(() => store.create(imapInput())).toThrow(MailboxMutationError);
  });

  it("rejects an unknown kind, an empty label and a missing address", () => {
    expect(() => store.create(imapInput({ kind: "pop3" as never }))).toThrow(MailboxMutationError);
    expect(() => store.create(imapInput({ label: "  " }))).toThrow(MailboxMutationError);
    expect(() => store.create(imapInput({ emailAddress: "" }))).toThrow(MailboxMutationError);
  });

  it("enforces the fields each kind actually needs to connect", () => {
    expect(() => store.create(imapInput({ host: "" }))).toThrow(/host/);
    expect(() => store.create(imapInput({ username: "" }))).toThrow(/username/);
    expect(() => store.create(imapInput({ label: "J", kind: "jmap", host: "", username: "" }))).toThrow(/sessionUrl/);
    expect(() => store.create(imapInput({ label: "M", kind: "m365", host: "", username: "" }))).toThrow(/tenantId/);
    expect(() => store.create(imapInput({ label: "G", kind: "gmail", host: "", username: "" }))).toThrow(/clientId/);
  });

  it("accepts a JMAP, M365 and Gmail mailbox when their own fields are present", () => {
    expect(
      store.create({
        companyId,
        label: "JMAP",
        kind: "jmap",
        emailAddress: "a@example.com",
        sessionUrl: "https://jmap.example.com/.well-known/jmap",
      }).kind,
    ).toBe("jmap");
    expect(
      store.create({
        companyId,
        label: "M365",
        kind: "m365",
        emailAddress: "b@example.com",
        tenantId: "tenant",
        clientId: "client",
      }).kind,
    ).toBe("m365");
    expect(
      store.create({ companyId, label: "Gmail", kind: "gmail", emailAddress: "c@example.com", clientId: "client" })
        .kind,
    ).toBe("gmail");
  });

  it("refuses auto-triage without polling, rather than silently doing nothing", () => {
    expect(() => store.create(imapInput({ autoTriage: true }))).toThrow(/polling/i);
    const ok = store.create(imapInput({ pollEnabled: true, autoTriage: true }));
    expect(ok.auto_triage).toBe(1);
  });

  it("clamps a too-short poll interval", () => {
    const m = store.create(imapInput({ pollEnabled: true, pollIntervalSeconds: 1 }));
    expect(m.poll_interval_seconds).toBe(30);
  });
});

describe("update and delete", () => {
  it("updates connection details and the per-mailbox switches", () => {
    const m = store.create(imapInput());
    const updated = store.update(m.id, { label: "Support DE", pollEnabled: true, autoTriage: true })!;
    expect(updated.label).toBe("Support DE");
    expect(updated.poll_enabled).toBe(1);
    expect(updated.auto_triage).toBe(1);
  });

  it("refuses an update that would leave the mailbox unable to connect", () => {
    const m = store.create(imapInput());
    expect(() => store.update(m.id, { host: "" })).toThrow(/host/);
  });

  it("refuses turning polling off while auto-triage stays on", () => {
    const m = store.create(imapInput({ pollEnabled: true, autoTriage: true }));
    expect(() => store.update(m.id, { pollEnabled: false })).toThrow(/polling/i);
  });

  it("rejects renaming onto an existing label", () => {
    store.create(imapInput());
    const other = store.create(imapInput({ label: "Sales" }));
    expect(() => store.update(other.id, { label: "Support" })).toThrow(MailboxMutationError);
  });

  it("deletes a mailbox and returns false for a missing one", () => {
    const m = store.create(imapInput());
    expect(store.delete(m.id)).toBe(true);
    expect(store.get(m.id)).toBeNull();
    expect(store.delete("mbx_nope")).toBe(false);
  });

  it("returns null when updating a mailbox that does not exist", () => {
    expect(store.update("mbx_nope", { label: "x" })).toBeNull();
  });
});

describe("credentials", () => {
  it("writeCredentials replaces the blob, e.g. after an OAuth token refresh", () => {
    const m = store.create({
      companyId,
      label: "M365",
      kind: "m365",
      emailAddress: "b@example.com",
      tenantId: "t",
      clientId: "c",
      credentials: { refreshToken: "r1" },
    });
    store.writeCredentials(m.id, { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    const creds = store.readCredentials(m.id);
    expect(creds.accessToken).toBe("a1");
    expect(creds.refreshToken).toBe("r1");
  });

  it("a mailbox created without credentials reads back an empty object", () => {
    const m = store.create(imapInput({ credentials: undefined }));
    expect(store.readCredentials(m.id)).toEqual({});
  });

  it("readCredentials throws for a mailbox that does not exist", () => {
    expect(() => store.readCredentials("mbx_nope")).toThrow(MailboxMutationError);
  });
});

describe("agent grants — the n:n relationship", () => {
  it("gives one agent several mailboxes and one mailbox several agents", () => {
    const support = store.create(imapInput({ label: "Support" }));
    const sales = store.create(imapInput({ label: "Sales" }));

    store.grantAgent(support.id, agentA);
    store.grantAgent(support.id, agentB, "send");
    store.grantAgent(sales.id, agentA);

    expect(
      store
        .agentsFor(support.id)
        .map((a) => a.agent_id)
        .sort(),
    ).toEqual([agentA, agentB].sort());
    expect(
      store
        .mailboxesForAgent(agentA)
        .map((m) => m.label)
        .sort(),
    ).toEqual(["Sales", "Support"]);
    expect(store.mailboxesForAgent(agentB).map((m) => m.label)).toEqual(["Support"]);
  });

  it("denies by default and reports the granted level", () => {
    const m = store.create(imapInput());
    expect(store.access(m.id, agentA)).toBeNull();
    store.grantAgent(m.id, agentA, "read");
    expect(store.access(m.id, agentA)).toBe("read");
    store.grantAgent(m.id, agentA, "send");
    expect(store.access(m.id, agentA)).toBe("send");
  });

  it("re-granting updates the level instead of duplicating the row", () => {
    const m = store.create(imapInput());
    store.grantAgent(m.id, agentA, "read");
    store.grantAgent(m.id, agentA, "send");
    expect(store.agentsFor(m.id)).toHaveLength(1);
  });

  it("revokes a grant and reports whether there was one", () => {
    const m = store.create(imapInput());
    store.grantAgent(m.id, agentA);
    expect(store.revokeAgent(m.id, agentA)).toBe(true);
    expect(store.access(m.id, agentA)).toBeNull();
    expect(store.revokeAgent(m.id, agentA)).toBe(false);
  });

  it("rejects granting to a nonexistent, cross-company agent or unknown level", () => {
    const m = store.create(imapInput());
    const otherCompany = seedCompany(db, "Other");
    const foreignAgent = seedAgent(db, otherCompany, "cto");
    expect(() => store.grantAgent(m.id, "agt_nope")).toThrow(MailboxMutationError);
    expect(() => store.grantAgent(m.id, foreignAgent)).toThrow(/same company/);
    expect(() => store.grantAgent(m.id, agentA, "admin" as never)).toThrow(MailboxMutationError);
  });

  it("drops grants with the mailbox", () => {
    const m = store.create(imapInput());
    store.grantAgent(m.id, agentA);
    store.delete(m.id);
    expect(store.mailboxesForAgent(agentA)).toEqual([]);
  });
});

describe("seen-message index", () => {
  it("records a message once and reports the second sighting as not new", () => {
    const m = store.create(imapInput());
    const first = store.recordSeenMessage({ mailboxId: m.id, externalId: "uid-1", subject: "Angebot" });
    expect(first.isNew).toBe(true);
    const second = store.recordSeenMessage({ mailboxId: m.id, externalId: "uid-1", subject: "Angebot" });
    expect(second.isNew).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(store.messages(m.id)).toHaveLength(1);
  });

  it("keeps the same external id apart across mailboxes", () => {
    const a = store.create(imapInput({ label: "A" }));
    const b = store.create(imapInput({ label: "B" }));
    expect(store.recordSeenMessage({ mailboxId: a.id, externalId: "uid-1" }).isNew).toBe(true);
    expect(store.recordSeenMessage({ mailboxId: b.id, externalId: "uid-1" }).isNew).toBe(true);
  });

  it("links a message to the task triage created from it", () => {
    const m = store.create(imapInput());
    const seen = store.recordSeenMessage({ mailboxId: m.id, externalId: "uid-9" });
    const linked = store.linkMessageToTask(seen.row.id, "task_1")!;
    expect(linked.task_id).toBe("task_1");
    expect(linked.triaged_at).not.toBeNull();
  });

  it("stores no message body — only metadata", () => {
    const m = store.create(imapInput());
    store.recordSeenMessage({ mailboxId: m.id, externalId: "uid-1", subject: "Betreff" });
    const columns = (db.prepare("PRAGMA table_info(crew_mailbox_messages)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("body_text");
    expect(columns).not.toContain("content");
  });
});

describe("polling schedule", () => {
  it("lists only mailboxes whose own interval has elapsed", () => {
    const idle = store.create(imapInput({ label: "Idle" }));
    const due = store.create(imapInput({ label: "Due", pollEnabled: true, pollIntervalSeconds: 60 }));
    const fresh = store.create(imapInput({ label: "Fresh", pollEnabled: true, pollIntervalSeconds: 600 }));

    const now = Date.now();
    store.recordPollResult(fresh.id, {}, now);
    store.recordPollResult(due.id, {}, now - 120_000);

    const pollable = store.listPollable(companyId, now).map((m) => m.label);
    expect(pollable).toContain("Due");
    expect(pollable).not.toContain("Fresh");
    expect(pollable).not.toContain("Idle");
    expect(idle.poll_enabled).toBe(0);
  });

  it("records the last error from a failed poll", () => {
    const m = store.create(imapInput({ pollEnabled: true }));
    store.recordPollResult(m.id, { error: "auth failed" });
    expect(store.get(m.id)!.last_error).toBe("auth failed");
    store.recordPollResult(m.id, {});
    expect(store.get(m.id)!.last_error).toBe("");
  });
});

describe("audit trail", () => {
  it("audits connect, grant, revoke and disconnect without leaking credentials", () => {
    const m = store.create(imapInput());
    store.grantAgent(m.id, agentA);
    store.revokeAgent(m.id, agentA);
    store.delete(m.id);

    const rows = db
      .prepare("SELECT action, details_json FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC")
      .all(companyId) as Array<{ action: string; details_json: string }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual([
      "mailbox.connected",
      "mailbox.agent_granted",
      "mailbox.agent_revoked",
      "mailbox.disconnected",
    ]);
    expect(rows.map((r) => r.details_json).join("")).not.toMatch(/hunter2/);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
