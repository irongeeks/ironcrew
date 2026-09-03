import pino, { type DestinationStream, type Logger, type Level } from "pino";
import { requestContext } from "./request-context.js";

const isDev = process.env.NODE_ENV !== "production";

interface LogEntry {
  level: number;
  module?: string;
  msg: string;
  data: string;
  logged_at: number;
}

// In-memory buffer for pre-DB log entries
const sqliteBuffer: LogEntry[] = [];
let dbWriter: ((entries: LogEntry[]) => void) | null = null;
let flushInterval: ReturnType<typeof setInterval> | null = null;

function parseLogEntry(chunk: string): LogEntry | null {
  try {
    const obj = JSON.parse(chunk);
    return {
      level: obj.level ?? 30,
      module: obj.module ?? undefined,
      msg: obj.msg ?? "",
      data: chunk,
      logged_at: obj.time ?? Date.now(),
    };
  } catch {
    return null;
  }
}

// Switchable SQLite destination — buffers pre-DB, writes post-DB
const sqliteStream: DestinationStream = {
  write(chunk: string): boolean {
    const entry = parseLogEntry(chunk);
    if (!entry) return true;
    sqliteBuffer.push(entry);
    if (dbWriter && sqliteBuffer.length >= 100) {
      flushSqliteBuffer();
    }
    // Forward to subscribed WS clients
    if (wsBroadcast) {
      wsBroadcast("log_stream", {
        level: entry.level,
        module: entry.module,
        msg: entry.msg,
        logged_at: entry.logged_at,
      });
    }
    return true;
  },
};

function flushSqliteBuffer(): void {
  if (!dbWriter || sqliteBuffer.length === 0) return;
  const entries = sqliteBuffer.splice(0);
  dbWriter(entries);
}

/**
 * Call after DB init to start persisting logs to SQLite.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachSqliteDestination(db: { prepare: (sql: string) => { run: (...params: any[]) => any } }): void {
  const stmt = db.prepare("INSERT INTO logs (level, module, message, data, logged_at) VALUES (?, ?, ?, ?, ?)");

  dbWriter = (entries: LogEntry[]) => {
    for (const e of entries) {
      stmt.run(e.level, e.module ?? null, e.msg, e.data, e.logged_at);
    }
  };

  // Flush any buffered entries from before DB was ready
  flushSqliteBuffer();

  // Periodic flush every 5 seconds
  flushInterval = setInterval(flushSqliteBuffer, 5_000).unref();
}

/** Flush pending logs and stop the flush interval. */
export function shutdownLogger(): void {
  flushSqliteBuffer();
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

// ---------------------------------------------------------------------------
// WS broadcast — forward log entries to subscribed WebSocket clients
// ---------------------------------------------------------------------------
let wsBroadcast: ((type: string, payload: unknown) => void) | null = null;

/**
 * Attach a WS broadcast function so log entries are forwarded as `log_stream`
 * events to subscribed clients.
 */
export function attachWsBroadcast(broadcast: (type: string, payload: unknown) => void): void {
  wsBroadcast = broadcast;
}

/** Expose buffer for testing. */
export function getSqliteBuffer(): readonly LogEntry[] {
  return sqliteBuffer;
}

// Build the logger — always use multistream so SQLite + WS streams work in all modes.
const logLevel = process.env.LOG_LEVEL || (isDev ? "debug" : "info");

// In dev: pino-pretty to stdout + sqliteStream. In prod: raw JSON to stdout + sqliteStream.
const stdoutStream = isDev
  ? pino.transport({ target: "pino-pretty", options: { colorize: true } })
  : pino.destination({ dest: 1, sync: false });

export const logger: Logger = pino(
  {
    level: logLevel,
    mixin() {
      const ctx = requestContext.getStore();
      return ctx ? { requestId: ctx.requestId } : {};
    },
  },
  pino.multistream([
    { stream: stdoutStream, level: logLevel as Level },
    { stream: sqliteStream, level: "info" as Level },
  ]),
);
