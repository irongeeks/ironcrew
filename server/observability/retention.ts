import type { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.ts";

const log = logger.child({ module: "retention" });

export interface RetentionConfig {
  metricsRetentionDays: number;
  aggregateRetentionDays: number;
  spanRetentionDays: number;
  logRetentionDays: number;
  maxLogRows: number;
}

export function runRetention(db: DatabaseSync, config: RetentionConfig): void {
  const now = Date.now();

  // 1. Aggregate old metrics into hourly buckets
  const metricsThreshold = now - config.metricsRetentionDays * 24 * 60 * 60 * 1000;
  const oldMetrics = db
    .prepare(
      "SELECT name, type, labels, value, recorded_at FROM metrics WHERE recorded_at < ? AND exported_at IS NOT NULL",
    )
    .all(metricsThreshold) as any[];

  const buckets = new Map<
    string,
    { name: string; type: string; labels: string | null; hour: number; values: number[] }
  >();
  for (const m of oldMetrics) {
    const hour = Math.floor(m.recorded_at / 1000 / 3600) * 3600;
    const key = `${m.name}|${m.labels ?? ""}|${hour}`;
    if (!buckets.has(key)) {
      buckets.set(key, { name: m.name, type: m.type, labels: m.labels, hour, values: [] });
    }
    buckets.get(key)!.values.push(m.value);
  }

  const upsertAgg = db.prepare(`
    INSERT INTO metrics_hourly (name, type, labels, hour, count, sum, min, max, avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name, labels, hour) DO UPDATE SET
      count = count + excluded.count,
      sum = sum + excluded.sum,
      min = MIN(min, excluded.min),
      max = MAX(max, excluded.max),
      avg = (sum + excluded.sum) / (count + excluded.count)
  `);

  for (const b of buckets.values()) {
    const sum = b.values.reduce((a, v) => a + v, 0);
    const min = Math.min(...b.values);
    const max = Math.max(...b.values);
    const avg = sum / b.values.length;
    upsertAgg.run(b.name, b.type, b.labels, b.hour, b.values.length, sum, min, max, avg);
  }

  // 2. Purge raw metrics
  db.prepare("DELETE FROM metrics WHERE recorded_at < ? AND exported_at IS NOT NULL").run(metricsThreshold);

  // 3. Purge old aggregates
  const aggThreshold = Math.floor((now - config.aggregateRetentionDays * 24 * 60 * 60 * 1000) / 1000 / 3600) * 3600;
  db.prepare("DELETE FROM metrics_hourly WHERE hour < ?").run(aggThreshold);

  // 4. Purge old spans (exported + ended)
  const spanThreshold = now - config.spanRetentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM workflow_spans WHERE end_time IS NOT NULL AND end_time < ? AND exported_at IS NOT NULL").run(
    spanThreshold,
  );

  // 5. Abandon orphaned spans (no endSpan after 24h)
  const orphanThreshold = now - 24 * 60 * 60 * 1000;
  db.prepare(
    "UPDATE workflow_spans SET status = 'abandoned', end_time = ? WHERE end_time IS NULL AND start_time < ?",
  ).run(now, orphanThreshold);

  // 6. Purge old logs (exported)
  const logThreshold = now - config.logRetentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM logs WHERE logged_at < ? AND exported_at IS NOT NULL").run(logThreshold);

  // 7. Emergency log purge if over max rows
  const logCount = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as any).c;
  if (logCount > config.maxLogRows) {
    const purgeCount = Math.floor(config.maxLogRows * 0.1);
    db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY logged_at ASC LIMIT ?)").run(purgeCount);
    log.warn({ purged: purgeCount, total: logCount }, "emergency log purge triggered");
  }

  // 8. Try incremental vacuum
  try {
    db.exec("PRAGMA incremental_vacuum(1000)");
  } catch {
    // auto_vacuum not set to INCREMENTAL — skip
  }
}
