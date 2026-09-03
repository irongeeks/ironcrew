import type { DatabaseSync } from "node:sqlite";

interface MetricEntry {
  name: string;
  type: "counter" | "histogram" | "gauge";
  value: number;
  labels: string | null;
  recorded_at: number;
}

export interface MetricsCollector {
  incCounter(name: string, labels?: Record<string, string>): void;
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  shutdown(): void;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 100;

export function createMetricsCollector(db: DatabaseSync): MetricsCollector {
  const buffer: MetricEntry[] = [];

  const insertStmt = db.prepare("INSERT INTO metrics (name, type, value, labels, recorded_at) VALUES (?, ?, ?, ?, ?)");

  function flush(): void {
    if (buffer.length === 0) return;
    const entries = buffer.splice(0);
    for (const e of entries) {
      insertStmt.run(e.name, e.type, e.value, e.labels, e.recorded_at);
    }
  }

  function maybeFlush(): void {
    if (buffer.length >= FLUSH_THRESHOLD) {
      flush();
    }
  }

  const interval = setInterval(flush, FLUSH_INTERVAL_MS).unref();

  function serializeLabels(labels?: Record<string, string>): string | null {
    return labels && Object.keys(labels).length > 0 ? JSON.stringify(labels) : null;
  }

  return {
    incCounter(name: string, labels?: Record<string, string>): void {
      buffer.push({ name, type: "counter", value: 1, labels: serializeLabels(labels), recorded_at: Date.now() });
      maybeFlush();
    },

    recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
      buffer.push({ name, type: "histogram", value, labels: serializeLabels(labels), recorded_at: Date.now() });
      maybeFlush();
    },

    setGauge(name: string, value: number, labels?: Record<string, string>): void {
      buffer.push({ name, type: "gauge", value, labels: serializeLabels(labels), recorded_at: Date.now() });
      maybeFlush();
    },

    shutdown(): void {
      clearInterval(interval);
      flush();
    },
  };
}
