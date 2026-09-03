import type { Router } from "express";
import type { DatabaseSync } from "node:sqlite";

// ---- Row shapes returned from SQLite ----

type LogRow = {
  id: number;
  level: number;
  module: string | null;
  message: string;
  data: string | null;
  logged_at: number;
};

type SpanRow = {
  id: string;
  trace_id: string;
  task_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  start_time: number;
  end_time: number | null;
  attributes: string | null;
  events: string | null;
};

type TraceRow = SpanRow & { span_count: number };

type MetricRow = {
  id: number;
  name: string;
  type: string;
  value: number;
  labels: string | null;
  recorded_at: number;
};

type MetricHourlyRow = {
  id: number;
  name: string;
  type: string;
  labels: string | null;
  hour: number;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
};

type CountRow = { cnt: number };

// ---- Helpers ----

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function optionalEpoch(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Escape LIKE meta-characters so user input is treated as literal text. */
function escapeLike(raw: string): string {
  return raw.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// ---- Route registration ----

export function registerObservabilityRoutes(router: Router, db: DatabaseSync): void {
  // ===========================================================================
  // 1. GET /api/ops/observability/logs — Paginated, filtered log query
  // ===========================================================================
  router.get("/api/ops/observability/logs", (req, res) => {
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const levelFilter = req.query.level !== undefined ? clampInt(req.query.level, 0, 60, 0) : undefined;
    const moduleFilter =
      typeof req.query.module === "string" && req.query.module.length > 0 ? req.query.module : undefined;
    const searchFilter =
      typeof req.query.search === "string" && req.query.search.length > 0 ? req.query.search : undefined;
    const since = optionalEpoch(req.query.since);
    const until = optionalEpoch(req.query.until);

    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (levelFilter !== undefined) {
      conditions.push("level >= ?");
      params.push(levelFilter);
    }
    if (moduleFilter) {
      conditions.push("module = ?");
      params.push(moduleFilter);
    }
    if (searchFilter) {
      conditions.push("message LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(searchFilter)}%`);
    }
    if (since !== undefined) {
      conditions.push("logged_at >= ?");
      params.push(since);
    }
    if (until !== undefined) {
      conditions.push("logged_at <= ?");
      params.push(until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params) as CountRow;
    const total = countRow?.cnt ?? 0;

    const rows = db
      .prepare(
        `SELECT id, level, module, message, data, logged_at FROM logs ${where} ORDER BY logged_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as LogRow[];

    res.json({ logs: rows, total, limit, offset });
  });

  // ===========================================================================
  // 2. GET /api/ops/observability/traces — Trace list (root spans)
  // ===========================================================================
  router.get("/api/ops/observability/traces", (req, res) => {
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const rows = db
      .prepare(
        `SELECT ws.*,
                (SELECT COUNT(*) FROM workflow_spans sub WHERE sub.trace_id = ws.trace_id) AS span_count
         FROM workflow_spans ws
         WHERE ws.kind = 'system' AND ws.parent_span_id IS NULL
         ORDER BY ws.start_time DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as TraceRow[];

    res.json({ traces: rows, limit, offset });
  });

  // ===========================================================================
  // 3. GET /api/ops/observability/traces/:traceId — Full span tree
  // ===========================================================================
  router.get("/api/ops/observability/traces/:traceId", (req, res) => {
    const { traceId } = req.params;

    const spans = db
      .prepare(
        `SELECT id, trace_id, task_id, parent_span_id, name, kind, status,
                start_time, end_time, attributes, events
         FROM workflow_spans
         WHERE trace_id = ?
         ORDER BY start_time ASC`,
      )
      .all(traceId) as SpanRow[];

    if (spans.length === 0) {
      return res.status(404).json({ ok: false, error: "trace_not_found" });
    }

    res.json({ trace_id: traceId, spans });
  });

  // ===========================================================================
  // 4. GET /api/ops/observability/traces/:traceId/logs — Correlated logs
  // ===========================================================================
  router.get("/api/ops/observability/traces/:traceId/logs", (req, res) => {
    const { traceId } = req.params;

    // Find root span to get task_id and time bounds
    const rootSpan = db
      .prepare(
        `SELECT task_id, start_time, end_time
         FROM workflow_spans
         WHERE trace_id = ? AND kind = 'system' AND parent_span_id IS NULL
         LIMIT 1`,
      )
      .get(traceId) as Pick<SpanRow, "task_id" | "start_time" | "end_time"> | undefined;

    if (!rootSpan) {
      return res.status(404).json({ ok: false, error: "trace_not_found" });
    }

    // Get time bounds across all spans in this trace
    const bounds = db
      .prepare(
        `SELECT MIN(start_time) as min_start, MAX(COALESCE(end_time, start_time)) as max_end
         FROM workflow_spans
         WHERE trace_id = ?`,
      )
      .get(traceId) as { min_start: number; max_end: number } | undefined;

    if (!bounds) {
      return res.json({ trace_id: traceId, logs: [] });
    }

    const conditions: string[] = ["logged_at >= ?", "logged_at <= ?"];
    const params: (string | number | null)[] = [bounds.min_start, bounds.max_end];

    // Use json_extract for safe taskId matching (NOT LIKE — prevents SQL injection)
    if (rootSpan.task_id) {
      conditions.push("json_extract(data, '$.taskId') = ?");
      params.push(rootSpan.task_id);
    }

    const where = conditions.join(" AND ");

    const logs = db
      .prepare(
        `SELECT id, level, module, message, data, logged_at
         FROM logs
         WHERE ${where}
         ORDER BY logged_at ASC`,
      )
      .all(...params) as LogRow[];

    res.json({ trace_id: traceId, logs });
  });

  // ===========================================================================
  // 5. GET /api/ops/observability/metrics/summary — Dashboard overview
  //    MUST be registered BEFORE :name to avoid "summary" matching as a param
  // ===========================================================================
  router.get("/api/ops/observability/metrics/summary", (req, res) => {
    const since = optionalEpoch(req.query.since) ?? Date.now() - 24 * 60 * 60 * 1000;

    const metricNames = ["workflow.started", "workflow.completed", "agent.spawn"];
    const summary: Record<string, number> = {};

    for (const name of metricNames) {
      const row = db
        .prepare("SELECT COALESCE(SUM(value), 0) as total FROM metrics WHERE name = ? AND recorded_at >= ?")
        .get(name, since) as { total: number };
      summary[name] = row?.total ?? 0;
    }

    res.json({ since, summary });
  });

  // ===========================================================================
  // 6. GET /api/ops/observability/metrics/:name — Time series
  // ===========================================================================
  router.get("/api/ops/observability/metrics/:name", (req, res) => {
    const { name } = req.params;
    const now = Date.now();
    const since = optionalEpoch(req.query.since) ?? now - 24 * 60 * 60 * 1000;
    const until = optionalEpoch(req.query.until) ?? now;

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const rangeMs = until - since;

    if (rangeMs <= SEVEN_DAYS_MS) {
      // Raw data for short ranges
      const rows = db
        .prepare(
          `SELECT id, name, type, value, labels, recorded_at
           FROM metrics
           WHERE name = ? AND recorded_at >= ? AND recorded_at <= ?
           ORDER BY recorded_at ASC`,
        )
        .all(name, since, until) as MetricRow[];

      res.json({ name, since, until, resolution: "raw", data: rows });
    } else {
      // Hourly aggregates for longer ranges
      // hour column stores epoch SECONDS truncated to hour boundary: Math.floor(ms / 1000 / 3600) * 3600
      const sinceHour = Math.floor(since / 1000 / 3600) * 3600;
      const untilHour = Math.floor(until / 1000 / 3600) * 3600;

      const rows = db
        .prepare(
          `SELECT id, name, type, labels, hour, count, sum, min, max, avg
           FROM metrics_hourly
           WHERE name = ? AND hour >= ? AND hour <= ?
           ORDER BY hour ASC`,
        )
        .all(name, sinceHour, untilHour) as MetricHourlyRow[];

      res.json({ name, since, until, resolution: "hourly", data: rows });
    }
  });
}
