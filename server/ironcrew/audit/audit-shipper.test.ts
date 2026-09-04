/**
 * The property under test is not "entries were sent". It is "the off-box copy
 * has no holes" — because a hole is exactly what an attacker who owns the box
 * would put there, and a shipper that skips past a failure manufactures one
 * for free.
 *
 * So every failure case here checks the cursor, not just the call count: a
 * cursor that moved past an entry the sink never accepted is the bug this
 * suite exists to catch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { appendAuditEvent, computeEntryHash } from "../domain/audit.ts";
import {
  AuditShipper,
  FileAuditSink,
  HttpAuditSink,
  auditShipperCursorKey,
  type AuditShipOutcome,
  type AuditSink,
  type ShippedAuditEntry,
  type SinkConnectionStatus,
} from "./audit-shipper.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Records every batch it is handed, and can be told to fail. */
class RecordingSink implements AuditSink {
  readonly kind = "recording";
  readonly batches: ShippedAuditEntry[][] = [];
  /** Return value for the next ship() call; a function so it can vary. */
  behaviour: (entries: readonly ShippedAuditEntry[]) => AuditShipOutcome | Promise<never> = (e) => ({
    accepted: e.length,
  });
  connection: SinkConnectionStatus | (() => never) = { ok: true, message: "ok" };

  /** Only the entries the sink actually took — the off-box copy. */
  readonly acceptedEntries: ShippedAuditEntry[] = [];

  async ship(entries: readonly ShippedAuditEntry[]): Promise<AuditShipOutcome> {
    this.batches.push([...entries]);
    const outcome = await this.behaviour(entries);
    // A partial acceptance takes a prefix, never a subset: the contract is
    // that entry N+1 is not stored unless N was. Recording it that way is
    // what lets a test tell "handed to the sink" from "landed off-box", and
    // the second is the only one that matters.
    this.acceptedEntries.push(...entries.slice(0, Math.max(0, Math.min(outcome.accepted, entries.length))));
    return outcome;
  }

  async testConnection(): Promise<SinkConnectionStatus> {
    if (typeof this.connection === "function") return this.connection();
    return this.connection;
  }

  /** Every entry the sink was handed, in order — accepted or not. */
  get seen(): ShippedAuditEntry[] {
    return this.batches.flat();
  }

  /** Every entry the sink kept, in order. This is the off-box copy. */
  get accepted(): ShippedAuditEntry[] {
    return this.acceptedEntries;
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: string }): {
  impl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body = "" } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body || "{}"),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function appendN(db: DatabaseSync, companyId: string, count: number, prefix = "action"): void {
  for (let i = 1; i <= count; i++) {
    appendAuditEvent(db, {
      companyId,
      actorType: "owner",
      actorId: "ceo",
      action: `${prefix}.${i}`,
      entityType: "task",
      entityId: `t${i}`,
      details: { index: i },
    });
  }
}

let db: DatabaseSync;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
});

// ---------------------------------------------------------------------------
// Cursor behaviour
// ---------------------------------------------------------------------------

describe("AuditShipper cursor", () => {
  it("ships everything from seq 1 on the very first run", async () => {
    appendN(db, companyId, 5);
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink });

    expect(shipper.cursor(companyId)).toBe(0);
    const result = await shipper.shipNewEntries(companyId);

    expect(result.ok).toBe(true);
    expect(result.shipped).toBe(5);
    expect(result.fromSeq).toBe(0);
    expect(result.gapDetected).toBe(false);
    expect(sink.seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("advances the cursor so a second run ships only what is new", async () => {
    appendN(db, companyId, 3);
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink });

    await shipper.shipNewEntries(companyId);
    expect(shipper.cursor(companyId)).toBe(3);

    // A run with nothing new must be a no-op, not a re-ship.
    const idle = await shipper.shipNewEntries(companyId);
    expect(idle.shipped).toBe(0);
    expect(sink.batches).toHaveLength(1);

    appendN(db, companyId, 2, "later");
    const second = await shipper.shipNewEntries(companyId);
    expect(second.shipped).toBe(2);
    expect(second.fromSeq).toBe(3);
    expect(shipper.cursor(companyId)).toBe(5);
    expect(sink.batches[1].map((e) => e.seq)).toEqual([4, 5]);
  });

  it("survives a restart: a fresh shipper resumes from the stored cursor", async () => {
    appendN(db, companyId, 4);
    await new AuditShipper({ db, sink: new RecordingSink() }).shipNewEntries(companyId);

    const sink = new RecordingSink();
    const restarted = new AuditShipper({ db, sink });
    appendN(db, companyId, 1, "after-restart");

    const result = await restarted.shipNewEntries(companyId);
    expect(result.shipped).toBe(1);
    expect(sink.seen.map((e) => e.seq)).toEqual([5]);
  });

  it("stores the cursor under the documented settings key", async () => {
    appendN(db, companyId, 2);
    await new AuditShipper({ db, sink: new RecordingSink() }).shipNewEntries(companyId);

    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(auditShipperCursorKey(companyId)) as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("2");
  });

  it("keeps a separate cursor per company", async () => {
    const other = seedCompany(db, "Zweite Firma");
    appendN(db, companyId, 3);
    appendN(db, other, 2, "other");

    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink });

    await shipper.shipNewEntries(companyId);
    expect(shipper.cursor(companyId)).toBe(3);
    // Shipping company A must not mark company B's entries as done.
    expect(shipper.cursor(other)).toBe(0);

    await shipper.shipNewEntries(other);
    expect(shipper.cursor(other)).toBe(2);
    expect(sink.batches[1].every((e) => e.company_id === other)).toBe(true);
  });

  it("keeps separate cursors per namespace, so two sinks never split the stream", async () => {
    appendN(db, companyId, 3);
    const primary = new RecordingSink();
    const archive = new RecordingSink();

    await new AuditShipper({ db, sink: primary, cursorNamespace: "primary" }).shipNewEntries(companyId);
    await new AuditShipper({ db, sink: archive, cursorNamespace: "archive" }).shipNewEntries(companyId);

    // Both copies are complete. A shared cursor would have given each half.
    expect(primary.seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(archive.seen.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// No holes
// ---------------------------------------------------------------------------

describe("AuditShipper never leaves a hole", () => {
  it("does not advance the cursor when the sink fails, and retries the same entries", async () => {
    appendN(db, companyId, 3);
    const sink = new RecordingSink();
    sink.behaviour = () => ({ accepted: 0, error: "collector down" });
    const shipper = new AuditShipper({ db, sink });

    const failed = await shipper.shipNewEntries(companyId);
    expect(failed.ok).toBe(false);
    expect(failed.shipped).toBe(0);
    expect(failed.error).toContain("collector down");
    expect(shipper.cursor(companyId)).toBe(0);
    expect(failed.pending).toBe(3);

    sink.behaviour = (e) => ({ accepted: e.length });
    const retried = await shipper.shipNewEntries(companyId);
    expect(retried.shipped).toBe(3);
    expect(sink.batches[1].map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("treats a throwing sink as zero accepted rather than propagating", async () => {
    appendN(db, companyId, 2);
    const sink = new RecordingSink();
    sink.behaviour = () => Promise.reject(new Error("ECONNREFUSED")) as Promise<never>;
    const shipper = new AuditShipper({ db, sink });

    const result = await shipper.shipNewEntries(companyId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(shipper.cursor(companyId)).toBe(0);
  });

  it("leaves the cursor at the last SUCCESSFULLY shipped entry on a mid-batch failure", async () => {
    appendN(db, companyId, 5);
    const sink = new RecordingSink();
    // Entries 1..3 land, entry 4 dies. The cursor must stop at 3 — not at 5,
    // and not roll back to 0.
    sink.behaviour = () => ({ accepted: 3, error: "disk full at entry 4" });
    const shipper = new AuditShipper({ db, sink });

    const partial = await shipper.shipNewEntries(companyId);
    expect(partial.ok).toBe(false);
    expect(partial.shipped).toBe(3);
    expect(partial.cursorSeq).toBe(3);
    expect(shipper.cursor(companyId)).toBe(3);
    expect(partial.pending).toBe(2);

    // The next run must start at 4 — the entry that failed — not at 5.
    sink.behaviour = (e) => ({ accepted: e.length });
    await shipper.shipNewEntries(companyId);
    expect(sink.batches[1].map((e) => e.seq)).toEqual([4, 5]);

    // End state of the off-box copy: every seq exactly once, in order,
    // nothing missing. `seen` would also carry the four and five that were
    // handed over and refused — which is precisely the distinction this
    // suite is about.
    expect(sink.accepted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("clamps a sink that over-reports acceptance", async () => {
    appendN(db, companyId, 2);
    const sink = new RecordingSink();
    // A buggy sink claiming more than it was given must not push the cursor
    // past entries that do not exist yet.
    sink.behaviour = () => ({ accepted: 99 });
    const shipper = new AuditShipper({ db, sink });

    await shipper.shipNewEntries(companyId);
    expect(shipper.cursor(companyId)).toBe(2);
  });

  it("stops draining at the first failed batch instead of skipping ahead", async () => {
    appendN(db, companyId, 6);
    const sink = new RecordingSink();
    let call = 0;
    sink.behaviour = (e) => {
      call++;
      return call === 2 ? { accepted: 0, error: "sink refused" } : { accepted: e.length };
    };
    const shipper = new AuditShipper({ db, sink, batchSize: 2 });

    const result = await shipper.drain(companyId);
    expect(result.ok).toBe(false);
    expect(result.shipped).toBe(2);
    expect(shipper.cursor(companyId)).toBe(2);
    // Two attempts: the good batch and the refused one. Nothing after it.
    expect(sink.batches).toHaveLength(2);
    expect(sink.batches[1].map((e) => e.seq)).toEqual([3, 4]);
  });

  it("reports a gap below the cursor without refusing to ship what remains", async () => {
    appendN(db, companyId, 4);
    // Simulate the tampering this module exists for: the low rows are gone.
    db.prepare("DELETE FROM crew_audit_events WHERE company_id = ? AND seq <= 2").run(companyId);

    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink });
    const result = await shipper.shipNewEntries(companyId);

    expect(result.gapDetected).toBe(true);
    // Still shipped: refusing would let one deletion stop preservation of
    // everything after it.
    expect(result.shipped).toBe(2);
    expect(sink.seen.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("re-ships rather than skips when the stored cursor is corrupt", async () => {
    appendN(db, companyId, 3);

    // The shipper's constructor is what guarantees the settings table exists
    // (a domain-only database has no base schema), so the corrupt value goes
    // in after it, exactly as a corrupt value would arrive in production:
    // written by an earlier run, read by a later one.
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink });
    db.prepare("INSERT INTO settings (key, value) VALUES (?,?)").run(auditShipperCursorKey(companyId), "not-a-number");
    expect(shipper.cursor(companyId)).toBe(0);

    const result = await shipper.shipNewEntries(companyId);
    expect(result.shipped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Batching, ordering and payload
// ---------------------------------------------------------------------------

describe("AuditShipper batching and payload", () => {
  it("bounds each batch and needs several runs to clear the backlog", async () => {
    appendN(db, companyId, 7);
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink, batchSize: 3 });

    const first = await shipper.shipNewEntries(companyId);
    expect(first.shipped).toBe(3);
    expect(first.pending).toBe(4);
    await shipper.shipNewEntries(companyId);
    const third = await shipper.shipNewEntries(companyId);

    expect(sink.batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(third.pending).toBe(0);
  });

  it("clamps an absurd batch size instead of trusting it", async () => {
    appendN(db, companyId, 4);
    const sink = new RecordingSink();
    await new AuditShipper({ db, sink, batchSize: 0 }).shipNewEntries(companyId);
    expect(sink.batches[0]).toHaveLength(1);
  });

  it("drains multiple bounded batches in one call, still in order", async () => {
    appendN(db, companyId, 10);
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink, batchSize: 4 });

    const result = await shipper.drain(companyId);
    expect(result.ok).toBe(true);
    expect(result.shipped).toBe(10);
    expect(result.fromSeq).toBe(0);
    expect(sink.batches.map((b) => b.length)).toEqual([4, 4, 2]);
    expect(sink.seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("ships in ascending seq order regardless of batch boundaries", async () => {
    appendN(db, companyId, 9);
    const sink = new RecordingSink();
    const shipper = new AuditShipper({ db, sink, batchSize: 2 });
    await shipper.drain(companyId);

    const seqs = sink.seen.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("carries both hashes, so the off-box copy verifies on its own", async () => {
    const appended = appendAuditEvent(db, {
      companyId,
      actorType: "owner",
      actorId: "ceo",
      action: "approval.decided",
      entityType: "approval",
      entityId: "apr_1",
      outcome: "ok",
      details: { amount: 4500 },
      correlationId: "corr-1",
    });

    const sink = new RecordingSink();
    await new AuditShipper({ db, sink }).shipNewEntries(companyId);
    const shipped = sink.seen[0];

    expect(shipped.prev_hash).toBe(appended.prevHash);
    expect(shipped.entry_hash).toBe(appended.entryHash);
    expect(shipped.correlation_id).toBe("corr-1");

    // The real test: recompute the hash from the shipped fields alone, the way
    // an off-box verifier would, with no access to this database.
    const recomputed = computeEntryHash({
      companyId: shipped.company_id,
      seq: shipped.seq,
      actorType: shipped.actor_type,
      actorId: shipped.actor_id,
      action: shipped.action,
      entityType: shipped.entity_type,
      entityId: shipped.entity_id,
      outcome: shipped.outcome,
      detailsJson: shipped.details_json,
      createdAt: shipped.created_at,
      prevHash: shipped.prev_hash,
    });
    expect(recomputed).toBe(shipped.entry_hash);
  });

  it("ships details verbatim rather than re-redacting, which would void the hash", async () => {
    appendAuditEvent(db, {
      companyId,
      actorType: "system",
      actorId: "runner",
      action: "tool.invoked",
      details: { note: "harmless", api_key: "sk-ant-abcdefghijklmnop0123456789" },
    });

    const sink = new RecordingSink();
    await new AuditShipper({ db, sink }).shipNewEntries(companyId);
    const shipped = sink.seen[0];

    // Already redacted on the way IN by appendAuditEvent — so no secret leaves
    // the box — and byte-identical to what the hash was taken over.
    expect(shipped.details_json).toContain("[REDACTED]");
    expect(shipped.details_json).not.toContain("sk-ant-abcdefghijklmnop0123456789");

    const stored = db
      .prepare("SELECT details_json FROM crew_audit_events WHERE company_id = ? AND seq = 1")
      .get(companyId) as { details_json: string };
    expect(shipped.details_json).toBe(stored.details_json);
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe("AuditShipper.testConnection", () => {
  it("reports the sink's status rather than throwing", async () => {
    const sink = new RecordingSink();
    sink.connection = { ok: false, message: "Audit-Ziel antwortet mit HTTP 503." };
    const status = await new AuditShipper({ db, sink }).testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("503");
  });

  it("turns a throwing sink into a reported failure, not an exception", async () => {
    const sink = new RecordingSink();
    sink.connection = () => {
      throw new Error("getaddrinfo ENOTFOUND archive.local");
    };
    const status = await new AuditShipper({ db, sink }).testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("ENOTFOUND");
  });
});

// ---------------------------------------------------------------------------
// HttpAuditSink
// ---------------------------------------------------------------------------

describe("HttpAuditSink", () => {
  it("POSTs one NDJSON line per entry and accepts the whole batch on 2xx", async () => {
    appendN(db, companyId, 3);
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const shipper = new AuditShipper({
      db,
      sink: new HttpAuditSink({ url: "https://archive.example/audit", fetchImpl: impl }),
    });

    const result = await shipper.shipNewEntries(companyId);
    expect(result.shipped).toBe(3);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://archive.example/audit");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-ndjson");

    const lines = String(calls[0].init?.body).trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as ShippedAuditEntry);
    expect(parsed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(parsed[0].entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed[0].prev_hash).toBe("");
  });

  it("sends the bearer token as a header and never in the URL or the body", async () => {
    appendN(db, companyId, 1);
    const token = "shipper-secret-token-value";
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    await new AuditShipper({
      db,
      sink: new HttpAuditSink({ url: "https://archive.example/audit", bearerToken: token, fetchImpl: impl }),
    }).shipNewEntries(companyId);

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${token}`);
    expect(calls[0].url).not.toContain(token);
    expect(String(calls[0].init?.body)).not.toContain(token);
  });

  it("treats a non-2xx as a total failure that does not advance the cursor", async () => {
    appendN(db, companyId, 2);
    const { impl } = fakeFetch(() => ({ status: 500, body: "upstream unavailable" }));
    const shipper = new AuditShipper({
      db,
      sink: new HttpAuditSink({ url: "https://archive.example/audit", fetchImpl: impl }),
    });

    const result = await shipper.shipNewEntries(companyId);
    expect(result.ok).toBe(false);
    expect(result.shipped).toBe(0);
    expect(result.error).toContain("HTTP 500");
    expect(shipper.cursor(companyId)).toBe(0);
  });

  it("keeps a token out of an error message that echoes it back", async () => {
    appendN(db, companyId, 1);
    const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { impl } = fakeFetch(() => ({ status: 401, body: `rejected Bearer ${token}` }));
    const result = await new AuditShipper({
      db,
      sink: new HttpAuditSink({ url: "https://archive.example/audit", bearerToken: token, fetchImpl: impl }),
    }).shipNewEntries(companyId);

    expect(result.error).toContain("HTTP 401");
    expect(result.error).not.toContain(token);
  });

  it("testConnection probes with an empty body so no test row enters the archive", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204 }));
    const status = await new HttpAuditSink({ url: "https://archive.example/audit", fetchImpl: impl }).testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("erreichbar");
    expect(calls[0].init?.body).toBe("");
  });

  it("testConnection reports a network failure in German instead of throwing", async () => {
    const impl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const status = await new HttpAuditSink({ url: "https://archive.example/audit", fetchImpl: impl }).testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("nicht erreichbar");
  });
});

// ---------------------------------------------------------------------------
// FileAuditSink
// ---------------------------------------------------------------------------

describe("FileAuditSink", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-audit-ship-"));
  });
  afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

  it("appends NDJSON, creating the directory, and appends again on the next run", async () => {
    appendN(db, companyId, 2);
    const target = path.join(workdir, "nested", "audit.ndjson");
    const shipper = new AuditShipper({ db, sink: new FileAuditSink({ filePath: target }) });

    await shipper.shipNewEntries(companyId);
    appendN(db, companyId, 2, "later");
    await shipper.shipNewEntries(companyId);

    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l) as ShippedAuditEntry);
    expect(parsed.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    // Append mode, not truncate: the first run's entries are still there.
    expect(parsed[0].action).toBe("action.1");
  });

  it("writes an independently verifiable copy", async () => {
    appendN(db, companyId, 3);
    const target = path.join(workdir, "audit.ndjson");
    await new AuditShipper({ db, sink: new FileAuditSink({ filePath: target }) }).shipNewEntries(companyId);

    const parsed = fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ShippedAuditEntry);

    // Walk the chain using only the file — no database involved.
    let expectedPrev = "";
    for (const entry of parsed) {
      expect(entry.prev_hash).toBe(expectedPrev);
      expect(
        computeEntryHash({
          companyId: entry.company_id,
          seq: entry.seq,
          actorType: entry.actor_type,
          actorId: entry.actor_id,
          action: entry.action,
          entityType: entry.entity_type,
          entityId: entry.entity_id,
          outcome: entry.outcome,
          detailsJson: entry.details_json,
          createdAt: entry.created_at,
          prevHash: entry.prev_hash,
        }),
      ).toBe(entry.entry_hash);
      expectedPrev = entry.entry_hash;
    }
  });

  it("does not advance the cursor when the target cannot be written", async () => {
    appendN(db, companyId, 2);
    // The parent exists as a FILE, so opening a file "inside" it must fail.
    const blocker = path.join(workdir, "blocked");
    fs.writeFileSync(blocker, "not a directory");
    const shipper = new AuditShipper({ db, sink: new FileAuditSink({ filePath: path.join(blocker, "audit.ndjson") }) });

    const result = await shipper.shipNewEntries(companyId);
    expect(result.ok).toBe(false);
    expect(result.shipped).toBe(0);
    expect(shipper.cursor(companyId)).toBe(0);
  });

  it("testConnection reports writability without adding a line", async () => {
    const target = path.join(workdir, "probe.ndjson");
    const status = await new FileAuditSink({ filePath: target }).testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("beschreibbar");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("testConnection reports an unwritable target instead of throwing", async () => {
    const blocker = path.join(workdir, "blocked");
    fs.writeFileSync(blocker, "not a directory");
    const status = await new FileAuditSink({ filePath: path.join(blocker, "audit.ndjson") }).testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("nicht beschreibbar");
  });
});
