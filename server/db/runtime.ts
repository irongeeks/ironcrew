import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_DB_PATH } from "../config/runtime.ts";
import { logger } from "../observability/logger.ts";

export function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export const SQLITE_BUSY_TIMEOUT_MS = readNonNegativeIntEnv("SQLITE_BUSY_TIMEOUT_MS", 5000);
export const SQLITE_BUSY_RETRY_MAX_ATTEMPTS = Math.min(readNonNegativeIntEnv("SQLITE_BUSY_RETRY_MAX_ATTEMPTS", 4), 20);
export const SQLITE_BUSY_RETRY_BASE_DELAY_MS = readNonNegativeIntEnv("SQLITE_BUSY_RETRY_BASE_DELAY_MS", 40);
export const SQLITE_BUSY_RETRY_MAX_DELAY_MS = Math.max(
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  readNonNegativeIntEnv("SQLITE_BUSY_RETRY_MAX_DELAY_MS", 400),
);
export const SQLITE_BUSY_RETRY_JITTER_MS = readNonNegativeIntEnv("SQLITE_BUSY_RETRY_JITTER_MS", 20);
export const REVIEW_FINAL_DECISION_ROUND = 3;
export const REVIEW_MAX_ROUNDS = Math.max(
  REVIEW_FINAL_DECISION_ROUND,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_ROUNDS", REVIEW_FINAL_DECISION_ROUND), 6),
);
export const REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND = Math.max(
  1,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND", 2), 10),
);
export const REVIEW_MAX_REVISION_SIGNALS_PER_ROUND = Math.max(
  REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_REVISION_SIGNALS_PER_ROUND", 6), 30),
);
export const REVIEW_MAX_MEMO_ITEMS_PER_DEPT = Math.max(
  1,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_MEMO_ITEMS_PER_DEPT", 2), 8),
);
export const REVIEW_MAX_MEMO_ITEMS_PER_ROUND = Math.max(
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_MEMO_ITEMS_PER_ROUND", 8), 24),
);
export const REVIEW_MAX_REMEDIATION_REQUESTS = 1;
export const IN_PROGRESS_ORPHAN_GRACE_MS = Math.max(
  30_000,
  readNonNegativeIntEnv("IN_PROGRESS_ORPHAN_GRACE_MS", 600_000),
);
export const IN_PROGRESS_ORPHAN_SWEEP_MS = Math.max(
  10_000,
  readNonNegativeIntEnv("IN_PROGRESS_ORPHAN_SWEEP_MS", 30_000),
);
export const SUBTASK_DELEGATION_SWEEP_MS = Math.max(
  5_000,
  readNonNegativeIntEnv("SUBTASK_DELEGATION_SWEEP_MS", 15_000),
);
export const CLI_OUTPUT_DEDUP_WINDOW_MS = Math.max(0, readNonNegativeIntEnv("CLI_OUTPUT_DEDUP_WINDOW_MS", 1500));

export function initializeDatabaseRuntime(): {
  dbPath: string;
  db: DatabaseSync;
  logsDir: string;
} {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = new DatabaseSync(dbPath);
  const autoVacuum = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | undefined;
  if (autoVacuum && autoVacuum.auto_vacuum === 0) {
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    } catch {
      console.warn("[db] auto_vacuum=INCREMENTAL not set (existing DB). Retention will use periodic VACUUM.");
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  logger.info(
    {
      module: "db-runtime",
      busy_timeout_ms: SQLITE_BUSY_TIMEOUT_MS,
      retries: SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
      backoff_min_ms: SQLITE_BUSY_RETRY_BASE_DELAY_MS,
      backoff_max_ms: SQLITE_BUSY_RETRY_MAX_DELAY_MS,
      jitter_max_ms: SQLITE_BUSY_RETRY_JITTER_MS,
    },
    "sqlite write resilience configured",
  );
  logger.info(
    {
      module: "db-runtime",
      max_rounds: REVIEW_MAX_ROUNDS,
      final_round: REVIEW_FINAL_DECISION_ROUND,
      remediation_requests_per_task: REVIEW_MAX_REMEDIATION_REQUESTS,
      hold_cap_per_round: REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
      hold_cap_per_dept_per_round: REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
      memo_cap_per_round: REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
      memo_cap_per_dept: REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    },
    "review guardrails configured",
  );
  logger.info(
    { module: "db-runtime", grace_ms: IN_PROGRESS_ORPHAN_GRACE_MS, sweep_ms: IN_PROGRESS_ORPHAN_SWEEP_MS },
    "in-progress watchdog configured",
  );
  logger.info(
    { module: "db-runtime", interval_ms: SUBTASK_DELEGATION_SWEEP_MS },
    "subtask delegation sweep configured",
  );

  const logsDir = process.env.LOGS_DIR ?? path.join(process.cwd(), "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // ignore
  }

  return { dbPath, db, logsDir };
}
