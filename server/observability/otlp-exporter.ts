import type { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.ts";

const log = logger.child({ module: "otlp-exporter" });

export interface OtlpExporterConfig {
  endpoint: string;
  intervalMs: number;
  headers?: Record<string, string>;
}

export interface OtlpExporter {
  start(): void;
  exportOnce(): Promise<void>;
  shutdown(): void;
}

function parseLabels(labels: string | null): Array<{ key: string; value: { stringValue: string } }> {
  if (!labels) return [];
  try {
    return Object.entries(JSON.parse(labels)).map(([k, v]) => ({
      key: k,
      value: { stringValue: String(v) },
    }));
  } catch {
    return [];
  }
}

export function createOtlpExporter(db: DatabaseSync, config: OtlpExporterConfig): OtlpExporter {
  let interval: ReturnType<typeof setInterval> | null = null;

  async function exportTraces(): Promise<void> {
    const spans = db
      .prepare(
        "SELECT id, trace_id, task_id, parent_span_id, name, kind, status, start_time, end_time, attributes, events FROM workflow_spans WHERE exported_at IS NULL AND end_time IS NOT NULL LIMIT 1000",
      )
      .all() as any[];

    if (spans.length === 0) return;

    const resourceSpans = [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "ironcrew" } }],
        },
        scopeSpans: [
          {
            scope: { name: "ironcrew.observability" },
            spans: spans.map((s: any) => ({
              traceId: s.trace_id.replace(/-/g, "").slice(0, 32).padStart(32, "0"),
              spanId: s.id.replace(/-/g, "").slice(0, 16).padStart(16, "0"),
              parentSpanId: s.parent_span_id ? s.parent_span_id.replace(/-/g, "").slice(0, 16).padStart(16, "0") : "",
              name: s.name,
              kind: 1, // INTERNAL
              startTimeUnixNano: String(BigInt(s.start_time) * 1_000_000n),
              endTimeUnixNano: String(BigInt(s.end_time || s.start_time) * 1_000_000n),
              status: { code: s.status === "ok" ? 1 : 2 },
              attributes: Object.entries(JSON.parse(s.attributes || "{}")).map(([k, v]) => ({
                key: k,
                value: { stringValue: String(v) },
              })),
              events: (JSON.parse(s.events || "[]") as any[]).map((e: any) => ({
                timeUnixNano: String(e.time * 1_000_000),
                name: e.name,
              })),
            })),
          },
        ],
      },
    ];

    const res = await fetch(`${config.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: JSON.stringify({ resourceSpans }),
    });

    if (res.ok) {
      const now = Date.now();
      const updateStmt = db.prepare("UPDATE workflow_spans SET exported_at = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const s of spans) updateStmt.run(now, s.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } else {
      log.warn({ status: res.status }, "OTLP traces export failed");
    }
  }

  async function exportMetrics(): Promise<void> {
    const rows = db
      .prepare("SELECT id, name, type, value, labels, recorded_at FROM metrics WHERE exported_at IS NULL LIMIT 1000")
      .all() as any[];

    if (rows.length === 0) return;

    const resourceMetrics = [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "ironcrew" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "ironcrew.observability" },
            metrics: rows.map((m: any) => ({
              name: m.name,
              sum:
                m.type === "counter"
                  ? {
                      dataPoints: [
                        {
                          asDouble: m.value,
                          timeUnixNano: String(BigInt(m.recorded_at) * 1_000_000n),
                          attributes: parseLabels(m.labels),
                        },
                      ],
                      aggregationTemporality: 2,
                      isMonotonic: true,
                    }
                  : undefined,
              gauge:
                m.type === "gauge"
                  ? {
                      dataPoints: [
                        {
                          asDouble: m.value,
                          timeUnixNano: String(BigInt(m.recorded_at) * 1_000_000n),
                          attributes: parseLabels(m.labels),
                        },
                      ],
                    }
                  : undefined,
              histogram:
                m.type === "histogram"
                  ? {
                      dataPoints: [
                        {
                          sum: m.value,
                          count: 1,
                          timeUnixNano: String(BigInt(m.recorded_at) * 1_000_000n),
                          attributes: parseLabels(m.labels),
                        },
                      ],
                      aggregationTemporality: 2,
                    }
                  : undefined,
            })),
          },
        ],
      },
    ];

    const res = await fetch(`${config.endpoint}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: JSON.stringify({ resourceMetrics }),
    });

    if (res.ok) {
      const now = Date.now();
      const updateStmt = db.prepare("UPDATE metrics SET exported_at = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const r of rows) updateStmt.run(now, r.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } else {
      log.warn({ status: res.status }, "OTLP metrics export failed");
    }
  }

  async function exportLogs(): Promise<void> {
    const rows = db
      .prepare("SELECT id, level, module, message, data, logged_at FROM logs WHERE exported_at IS NULL LIMIT 1000")
      .all() as any[];

    if (rows.length === 0) return;

    const severityMap: Record<number, { text: string; number: number }> = {
      10: { text: "TRACE", number: 1 },
      20: { text: "DEBUG", number: 5 },
      30: { text: "INFO", number: 9 },
      40: { text: "WARN", number: 13 },
      50: { text: "ERROR", number: 17 },
      60: { text: "FATAL", number: 21 },
    };

    const resourceLogs = [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "ironcrew" } }],
        },
        scopeLogs: [
          {
            scope: { name: "ironcrew.observability" },
            logRecords: rows.map((l: any) => {
              const sev = severityMap[l.level] ?? { text: "INFO", number: 9 };
              return {
                timeUnixNano: String(BigInt(l.logged_at) * 1_000_000n),
                severityText: sev.text,
                severityNumber: sev.number,
                body: { stringValue: l.message },
                attributes: [...(l.module ? [{ key: "module", value: { stringValue: l.module } }] : [])],
              };
            }),
          },
        ],
      },
    ];

    const res = await fetch(`${config.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: JSON.stringify({ resourceLogs }),
    });

    if (res.ok) {
      const now = Date.now();
      const updateStmt = db.prepare("UPDATE logs SET exported_at = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const r of rows) updateStmt.run(now, r.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } else {
      log.warn({ status: res.status }, "OTLP logs export failed");
    }
  }

  const exporter: OtlpExporter = {
    start(): void {
      interval = setInterval(async () => {
        try {
          await exporter.exportOnce();
        } catch (err) {
          log.warn({ err }, "OTLP export cycle failed");
        }
      }, config.intervalMs).unref();
      log.info({ endpoint: config.endpoint, intervalMs: config.intervalMs }, "OTLP exporter started");
    },

    async exportOnce(): Promise<void> {
      await exportTraces();
      await exportMetrics();
      await exportLogs();
    },

    shutdown(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };

  return exporter;
}
