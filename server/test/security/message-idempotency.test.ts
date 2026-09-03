import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdempotencyConflictError,
  StorageBusyError,
  createMessageIdempotencyTools,
  type MessageInsertInput,
} from "../../modules/bootstrap/message-idempotency.ts";

// ---------------------------------------------------------------------------
// These tests exercise the PUBLIC surface of message-idempotency.ts directly:
//
//   - createMessageIdempotencyTools(deps) factory, returning:
//       insertMessageWithIdempotency
//       resolveMessageIdempotencyKey
//       withSqliteBusyRetry
//   - IdempotencyConflictError
//   - StorageBusyError
//
// We back the factory with a real in-memory node:sqlite database to exercise
// the actual SQL paths (INSERT, SELECT, UNIQUE constraint), and we drive the
// retry/backoff branches with controllable fakes.
// ---------------------------------------------------------------------------

function createInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      receiver_type TEXT NOT NULL,
      receiver_id TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      task_id TEXT,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_messages_idempotency_key
      ON messages(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
  return db;
}

function makeTools(overrides: Partial<Parameters<typeof createMessageIdempotencyTools>[0]> = {}) {
  const db = overrides.db ?? createInMemoryDb();
  let now = 1_700_000_000_000;
  const sleepMs = vi.fn(async () => {});
  return {
    db,
    sleepMs,
    advance(ms: number) {
      now += ms;
    },
    tools: createMessageIdempotencyTools({
      db,
      nowMs: overrides.nowMs ?? (() => now),
      sleepMs: overrides.sleepMs ?? sleepMs,
      SQLITE_BUSY_RETRY_BASE_DELAY_MS: overrides.SQLITE_BUSY_RETRY_BASE_DELAY_MS ?? 5,
      SQLITE_BUSY_RETRY_JITTER_MS: overrides.SQLITE_BUSY_RETRY_JITTER_MS ?? 0,
      SQLITE_BUSY_RETRY_MAX_ATTEMPTS: overrides.SQLITE_BUSY_RETRY_MAX_ATTEMPTS ?? 3,
      SQLITE_BUSY_RETRY_MAX_DELAY_MS: overrides.SQLITE_BUSY_RETRY_MAX_DELAY_MS ?? 100,
    }),
  };
}

const baseInput: MessageInsertInput = {
  senderType: "user",
  senderId: "u1",
  receiverType: "agent",
  receiverId: "a1",
  content: "hello world",
  messageType: "task",
  taskId: "t1",
  idempotencyKey: "client-key-1",
};

function makeReq(headers: Record<string, string> = {}): { get(name: string): string | undefined } {
  return {
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

// ---------------------------------------------------------------------------
// insertMessageWithIdempotency
// ---------------------------------------------------------------------------
describe("insertMessageWithIdempotency", () => {
  it("inserts a new message and reports created=true", async () => {
    const { tools, db } = makeTools();
    const result = await tools.insertMessageWithIdempotency(baseInput);
    expect(result.created).toBe(true);
    expect(result.message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.message.content).toBe("hello world");
    expect(result.message.idempotency_key).toBe("client-key-1");

    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("dedupes on the same idempotency key with identical payload (created=false)", async () => {
    const { tools, db } = makeTools();
    const a = await tools.insertMessageWithIdempotency(baseInput);
    const b = await tools.insertMessageWithIdempotency(baseInput);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.message.id).toBe(a.message.id);
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("throws IdempotencyConflictError when key matches but payload differs", async () => {
    const { tools } = makeTools();
    await tools.insertMessageWithIdempotency(baseInput);
    await expect(
      tools.insertMessageWithIdempotency({ ...baseInput, content: "different content" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("treats different idempotency keys as distinct messages", async () => {
    const { tools, db } = makeTools();
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: "k1" });
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: "k2" });
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(row.n).toBe(2);
  });

  it("does not dedupe when idempotencyKey is missing/empty/whitespace", async () => {
    const { tools, db } = makeTools();
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: null });
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: undefined });
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: "" });
    await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: "   " });
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(row.n).toBe(4);
  });

  it("hashes idempotency keys longer than 200 chars and dedupes consistently", async () => {
    const { tools, db } = makeTools();
    const longKey = "x".repeat(500);
    const a = await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: longKey });
    const b = await tools.insertMessageWithIdempotency({ ...baseInput, idempotencyKey: longKey });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.message.idempotency_key).toMatch(/^sha256:[0-9a-f]{64}$/);
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("recovers on UNIQUE-violation race: returns existing row when payload matches", async () => {
    // Simulate a race where the pre-INSERT lookup misses but the INSERT
    // hits the unique index. We do this with a wrapping db that intercepts
    // the first SELECT (forces a miss) then lets the INSERT proceed.
    const real = createInMemoryDb();
    let selectsBeforeInsert = 0;
    const wrapping = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (sql.includes("SELECT") && sql.includes("FROM messages")) {
          return {
            get(...args: unknown[]) {
              selectsBeforeInsert++;
              if (selectsBeforeInsert === 1) return undefined; // force miss on first lookup
              return (stmt.get as (...a: unknown[]) => unknown)(...args);
            },
          } as unknown as ReturnType<DatabaseSync["prepare"]>;
        }
        return stmt;
      },
    } as unknown as DatabaseSync;

    // Pre-insert a row with the same key directly via the real db so the INSERT
    // we're about to perform via the wrapper hits a UNIQUE violation.
    real
      .prepare(
        `INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "preexisting-id",
        baseInput.senderType,
        baseInput.senderId,
        baseInput.receiverType,
        baseInput.receiverId,
        baseInput.content,
        baseInput.messageType,
        baseInput.taskId ?? null,
        baseInput.idempotencyKey ?? null,
        1_700_000_000_000,
      );

    const { tools } = makeTools({ db: wrapping });
    const result = await tools.insertMessageWithIdempotency(baseInput);
    expect(result.created).toBe(false);
    expect(result.message.id).toBe("preexisting-id");
  });

  it("recovers on UNIQUE-violation race and throws conflict when payload differs", async () => {
    const real = createInMemoryDb();
    let selects = 0;
    const wrapping = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (sql.includes("SELECT") && sql.includes("FROM messages")) {
          return {
            get(...args: unknown[]) {
              selects++;
              if (selects === 1) return undefined;
              return (stmt.get as (...a: unknown[]) => unknown)(...args);
            },
          } as unknown as ReturnType<DatabaseSync["prepare"]>;
        }
        return stmt;
      },
    } as unknown as DatabaseSync;

    real
      .prepare(
        `INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "preexisting-id",
        baseInput.senderType,
        baseInput.senderId,
        baseInput.receiverType,
        baseInput.receiverId,
        "DIFFERENT_CONTENT",
        baseInput.messageType,
        baseInput.taskId ?? null,
        baseInput.idempotencyKey ?? null,
        1_700_000_000_000,
      );

    const { tools } = makeTools({ db: wrapping });
    await expect(tools.insertMessageWithIdempotency(baseInput)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("retries on SQLITE_BUSY and eventually succeeds", async () => {
    const real = createInMemoryDb();
    let prepareCalls = 0;
    const wrapping = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (sql.includes("INSERT INTO messages")) {
          return {
            run(...args: unknown[]) {
              prepareCalls++;
              if (prepareCalls < 2) {
                const err = new Error("database is locked");
                (err as { code?: string }).code = "SQLITE_BUSY";
                throw err;
              }
              return (stmt.run as (...a: unknown[]) => unknown)(...args);
            },
          } as unknown as ReturnType<DatabaseSync["prepare"]>;
        }
        return stmt;
      },
    } as unknown as DatabaseSync;

    const sleepMs = vi.fn(async () => {});
    const { tools } = makeTools({ db: wrapping, sleepMs });
    const result = await tools.insertMessageWithIdempotency(baseInput);
    expect(result.created).toBe(true);
    expect(sleepMs).toHaveBeenCalled();
  });

  it("throws StorageBusyError after exhausting retries on persistent SQLITE_BUSY", async () => {
    const real = createInMemoryDb();
    const wrapping = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (sql.includes("INSERT INTO messages")) {
          return {
            run() {
              const err = new Error("database is locked");
              (err as { code?: string }).code = "SQLITE_BUSY";
              throw err;
            },
          } as unknown as ReturnType<DatabaseSync["prepare"]>;
        }
        return stmt;
      },
    } as unknown as DatabaseSync;

    const sleepMs = vi.fn(async () => {});
    const { tools } = makeTools({
      db: wrapping,
      sleepMs,
      SQLITE_BUSY_RETRY_MAX_ATTEMPTS: 2,
      SQLITE_BUSY_RETRY_BASE_DELAY_MS: 1,
    });
    await expect(tools.insertMessageWithIdempotency(baseInput)).rejects.toBeInstanceOf(StorageBusyError);
  });

  it("propagates non-busy, non-idempotency errors as-is", async () => {
    const wrapping = {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO messages")) {
          return {
            run() {
              throw new Error("disk I/O error");
            },
          } as unknown as ReturnType<DatabaseSync["prepare"]>;
        }
        // SELECT path: no row exists
        return { get: () => undefined } as unknown as ReturnType<DatabaseSync["prepare"]>;
      },
    } as unknown as DatabaseSync;

    const { tools } = makeTools({ db: wrapping });
    await expect(tools.insertMessageWithIdempotency(baseInput)).rejects.toThrow(/disk I\/O error/);
  });
});

// ---------------------------------------------------------------------------
// resolveMessageIdempotencyKey
// ---------------------------------------------------------------------------
describe("resolveMessageIdempotencyKey", () => {
  it("returns a scoped key when body.idempotency_key is provided", () => {
    const { tools } = makeTools();
    const result = tools.resolveMessageIdempotencyKey(makeReq(), { idempotency_key: "abc" }, "api.messages");
    expect(result).not.toBeNull();
    expect(result!.startsWith("api.messages:")).toBe(true);
  });

  it("falls through body and header candidates in order", () => {
    const { tools } = makeTools();
    expect(tools.resolveMessageIdempotencyKey(makeReq(), { idempotencyKey: "x" }, "s")).not.toBeNull();
    expect(tools.resolveMessageIdempotencyKey(makeReq(), { request_id: "x" }, "s")).not.toBeNull();
    expect(tools.resolveMessageIdempotencyKey(makeReq(), { requestId: "x" }, "s")).not.toBeNull();
    expect(tools.resolveMessageIdempotencyKey(makeReq({ "x-idempotency-key": "x" }), {}, "s")).not.toBeNull();
    expect(tools.resolveMessageIdempotencyKey(makeReq({ "idempotency-key": "x" }), {}, "s")).not.toBeNull();
    expect(tools.resolveMessageIdempotencyKey(makeReq({ "x-request-id": "x" }), {}, "s")).not.toBeNull();
  });

  it("returns null when no candidates resolve", () => {
    const { tools } = makeTools();
    expect(tools.resolveMessageIdempotencyKey(makeReq(), {}, "api.messages")).toBeNull();
    expect(
      tools.resolveMessageIdempotencyKey(makeReq(), { idempotency_key: "  ", request_id: "" }, "api.messages"),
    ).toBeNull();
  });

  it("normalizes scope to lowercase and defaults empty scope to api.messages", () => {
    const { tools } = makeTools();
    const upper = tools.resolveMessageIdempotencyKey(makeReq({ "x-idempotency-key": "k" }), {}, "API.Messages");
    const empty = tools.resolveMessageIdempotencyKey(makeReq({ "x-idempotency-key": "k" }), {}, "   ");
    expect(upper!.startsWith("api.messages:")).toBe(true);
    expect(empty!.startsWith("api.messages:")).toBe(true);
  });

  it("produces different scoped keys for different scopes (same source key)", () => {
    const { tools } = makeTools();
    const a = tools.resolveMessageIdempotencyKey(makeReq({ "x-idempotency-key": "same" }), {}, "api.messages");
    const b = tools.resolveMessageIdempotencyKey(makeReq({ "x-idempotency-key": "same" }), {}, "api.directives");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// withSqliteBusyRetry
// ---------------------------------------------------------------------------
describe("withSqliteBusyRetry", () => {
  it("returns the result on first success without sleeping", async () => {
    const { tools, sleepMs } = makeTools();
    const result = await tools.withSqliteBusyRetry("op", () => 42);
    expect(result).toBe(42);
    expect(sleepMs).not.toHaveBeenCalled();
  });

  it("retries on busy errors and uses jitter when configured", async () => {
    const sleepMs = vi.fn(async () => {});
    const { tools } = makeTools({
      sleepMs,
      SQLITE_BUSY_RETRY_BASE_DELAY_MS: 2,
      SQLITE_BUSY_RETRY_JITTER_MS: 5,
      SQLITE_BUSY_RETRY_MAX_ATTEMPTS: 5,
    });
    let calls = 0;
    const result = await tools.withSqliteBusyRetry("op", () => {
      calls++;
      if (calls < 3) {
        const err = new Error("SQLITE_BUSY: contention");
        throw err;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleepMs).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-busy errors immediately", async () => {
    const { tools, sleepMs } = makeTools();
    await expect(
      tools.withSqliteBusyRetry("op", () => {
        throw new Error("syntax error");
      }),
    ).rejects.toThrow(/syntax error/);
    expect(sleepMs).not.toHaveBeenCalled();
  });

  it("throws StorageBusyError with the operation name after exhausting attempts", async () => {
    const { tools } = makeTools({ SQLITE_BUSY_RETRY_MAX_ATTEMPTS: 1, SQLITE_BUSY_RETRY_BASE_DELAY_MS: 0 });
    let err: unknown;
    try {
      await tools.withSqliteBusyRetry("messages.insert", () => {
        const e = new Error("database is locked");
        (e as { code?: string }).code = "SQLITE_BUSY";
        throw e;
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StorageBusyError);
    expect((err as StorageBusyError).operation).toBe("messages.insert");
    expect((err as StorageBusyError).attempts).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------
describe("error classes", () => {
  beforeEach(() => {});

  it("IdempotencyConflictError carries the conflicting key and a stable name", () => {
    const e = new IdempotencyConflictError("scoped:abc");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("IdempotencyConflictError");
    expect(e.key).toBe("scoped:abc");
    expect(e.message).toBe("idempotency_conflict");
  });

  it("StorageBusyError carries operation and attempt count", () => {
    const e = new StorageBusyError("messages.insert", 4);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StorageBusyError");
    expect(e.operation).toBe("messages.insert");
    expect(e.attempts).toBe(4);
    expect(e.message).toBe("storage_busy");
  });
});
