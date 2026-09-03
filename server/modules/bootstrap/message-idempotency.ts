import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "bootstrap" });

type DbLike = Pick<DatabaseSync, "prepare">;

type MessageIdempotencyDeps = {
  db: DbLike;
  nowMs: () => number;
  sleepMs: (ms: number) => Promise<void>;
  SQLITE_BUSY_RETRY_BASE_DELAY_MS: number;
  SQLITE_BUSY_RETRY_JITTER_MS: number;
  SQLITE_BUSY_RETRY_MAX_ATTEMPTS: number;
  SQLITE_BUSY_RETRY_MAX_DELAY_MS: number;
};

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export type StoredMessage = {
  id: string;
  sender_type: string;
  sender_id: string | null;
  receiver_type: string;
  receiver_id: string | null;
  content: string;
  message_type: string;
  task_id: string | null;
  idempotency_key: string | null;
  created_at: number;
};

export type MessageInsertInput = {
  senderType: string;
  senderId: string | null;
  receiverType: string;
  receiverId: string | null;
  content: string;
  messageType: string;
  taskId?: string | null;
  idempotencyKey?: string | null;
};

export class IdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super("idempotency_conflict");
    this.name = "IdempotencyConflictError";
  }
}

export class StorageBusyError extends Error {
  constructor(
    public readonly operation: string,
    public readonly attempts: number,
  ) {
    super("storage_busy");
    this.name = "StorageBusyError";
  }
}

function isSameMessagePayload(existing: StoredMessage, input: MessageInsertInput, taskId: string | null): boolean {
  return (
    existing.sender_type === input.senderType &&
    existing.sender_id === input.senderId &&
    existing.receiver_type === input.receiverType &&
    existing.receiver_id === input.receiverId &&
    existing.content === input.content &&
    existing.message_type === input.messageType &&
    existing.task_id === taskId
  );
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= IDEMPOTENCY_KEY_MAX_LENGTH) return trimmed;
  return `sha256:${createHash("sha256").update(trimmed, "utf8").digest("hex")}`;
}

function resolveMessageIdempotencyKey(
  req: { get(name: string): string | undefined },
  body: Record<string, unknown>,
  scope: string,
): string | null {
  const normalizedScope = scope.trim().toLowerCase() || "api.messages";
  const candidates: unknown[] = [
    body.idempotency_key,
    body.idempotencyKey,
    body.request_id,
    body.requestId,
    req.get("x-idempotency-key"),
    req.get("idempotency-key"),
    req.get("x-request-id"),
  ];
  for (const candidate of candidates) {
    const key = normalizeIdempotencyKey(candidate);
    if (key) {
      const digest = createHash("sha256").update(`${normalizedScope}:${key}`, "utf8").digest("hex");
      return `${normalizedScope}:${digest}`;
    }
  }
  return null;
}

function findMessageByIdempotencyKey(db: DbLike, idempotencyKey: string): StoredMessage | null {
  const row = db
    .prepare(
      `
    SELECT id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at
    FROM messages
    WHERE idempotency_key = ?
    LIMIT 1
  `,
    )
    .get(idempotencyKey) as StoredMessage | undefined;
  return row ?? null;
}

function isIdempotencyUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  if (!message.includes("unique constraint failed")) return false;
  return message.includes("messages.idempotency_key") || message.includes("idx_messages_idempotency_key");
}

function isSqliteBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = err.message.toLowerCase();
  return (
    message.includes("sqlite_busy") ||
    message.includes("sqlite_locked") ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

export function createMessageIdempotencyTools(deps: MessageIdempotencyDeps) {
  const {
    db,
    nowMs,
    sleepMs,
    SQLITE_BUSY_RETRY_BASE_DELAY_MS,
    SQLITE_BUSY_RETRY_JITTER_MS,
    SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
    SQLITE_BUSY_RETRY_MAX_DELAY_MS,
  } = deps;

  function sqliteBusyBackoffDelayMs(attempt: number): number {
    const expo = SQLITE_BUSY_RETRY_BASE_DELAY_MS * 2 ** attempt;
    const capped = Math.min(expo, SQLITE_BUSY_RETRY_MAX_DELAY_MS);
    if (SQLITE_BUSY_RETRY_JITTER_MS <= 0) return Math.floor(capped);
    const jitter = Math.floor(Math.random() * (SQLITE_BUSY_RETRY_JITTER_MS + 1));
    return Math.floor(capped + jitter);
  }

  async function withSqliteBusyRetry<T>(operation: string, fn: () => T): Promise<T> {
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const result = fn();
        if (attempt > 0) {
          log.warn({ operation, retries: attempt }, "SQLite busy recovered");
        }
        return result;
      } catch (err) {
        if (!isSqliteBusyError(err)) throw err;
        if (attempt >= SQLITE_BUSY_RETRY_MAX_ATTEMPTS) {
          throw new StorageBusyError(operation, attempt + 1);
        }
        const waitMs = sqliteBusyBackoffDelayMs(attempt);
        log.warn(
          { operation, attempt: attempt + 1, maxAttempts: SQLITE_BUSY_RETRY_MAX_ATTEMPTS + 1, retryInMs: waitMs },
          "SQLite busy, retrying",
        );
        if (waitMs > 0) await sleepMs(waitMs);
      }
    }

    throw new StorageBusyError(operation, SQLITE_BUSY_RETRY_MAX_ATTEMPTS + 1);
  }

  function insertMessageWithIdempotencyOnce(input: MessageInsertInput): { message: StoredMessage; created: boolean } {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const taskId = input.taskId ?? null;
    if (idempotencyKey) {
      const existing = findMessageByIdempotencyKey(db, idempotencyKey);
      if (existing) {
        if (!isSameMessagePayload(existing, input, taskId)) {
          throw new IdempotencyConflictError(idempotencyKey);
        }
        return { message: existing, created: false };
      }
    }

    const id = randomUUID();
    const createdAt = nowMs();
    try {
      db.prepare(
        `
      INSERT INTO messages (
        id, sender_type, sender_id, receiver_type, receiver_id,
        content, message_type, task_id, idempotency_key, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(
        id,
        input.senderType,
        input.senderId,
        input.receiverType,
        input.receiverId,
        input.content,
        input.messageType,
        taskId,
        idempotencyKey,
        createdAt,
      );
    } catch (err) {
      if (idempotencyKey && isIdempotencyUniqueViolation(err)) {
        const existing = findMessageByIdempotencyKey(db, idempotencyKey);
        if (existing) {
          if (!isSameMessagePayload(existing, input, taskId)) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          return { message: existing, created: false };
        }
      }
      throw err;
    }

    return {
      message: {
        id,
        sender_type: input.senderType,
        sender_id: input.senderId,
        receiver_type: input.receiverType,
        receiver_id: input.receiverId,
        content: input.content,
        message_type: input.messageType,
        task_id: taskId,
        idempotency_key: idempotencyKey,
        created_at: createdAt,
      },
      created: true,
    };
  }

  async function insertMessageWithIdempotency(
    input: MessageInsertInput,
  ): Promise<{ message: StoredMessage; created: boolean }> {
    return withSqliteBusyRetry("messages.insert", () => insertMessageWithIdempotencyOnce(input));
  }

  return {
    insertMessageWithIdempotency,
    resolveMessageIdempotencyKey,
    withSqliteBusyRetry,
  };
}
