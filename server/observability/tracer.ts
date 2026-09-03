import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SpanKind = "phase" | "agent" | "connector" | "system";
export type SpanStatus = "ok" | "error" | "timeout" | "abandoned" | "cancelled";

interface SpanEvent {
  time: number;
  name: string;
  attributes?: Record<string, unknown>;
}

interface InFlightSpan {
  id: string;
  traceId: string;
  taskId: string | null;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTime: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface Tracer {
  startTrace(taskId: string, packKey: string): string;
  startSpan(
    traceId: string,
    name: string,
    kind: SpanKind,
    parentSpanId?: string,
    attributes?: Record<string, unknown>,
  ): string;
  endSpan(spanId: string, status?: SpanStatus): void;
  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void;
  shutdown(): void;
}

export function createTracer(db: DatabaseSync): Tracer {
  const inFlight = new Map<string, InFlightSpan>();
  const traceTaskMap = new Map<string, string>();

  const insertStmt = db.prepare(`
    INSERT INTO workflow_spans (id, trace_id, task_id, parent_span_id, name, kind, status, start_time, end_time, attributes, events)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Safety-net: flush spans that have been in-flight for over 4 hours as "abandoned".
  // Uses a real end_time so the OTLP exporter can pick them up (end_time IS NOT NULL).
  // 4 hours is generous enough for long-running workflow phases while still catching
  // leaked spans from crashed processes.
  const SAFETY_NET_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  const safetyInterval = setInterval(() => {
    const cutoff = Date.now() - SAFETY_NET_TIMEOUT_MS;
    for (const [id, span] of inFlight) {
      if (span.startTime <= cutoff) {
        flushSpan(id, "abandoned", Date.now());
      }
    }
  }, 60_000).unref();

  function flushSpan(spanId: string, status: SpanStatus, endTime: number | null): void {
    const span = inFlight.get(spanId);
    if (!span) return;
    inFlight.delete(spanId);

    insertStmt.run(
      span.id,
      span.traceId,
      span.taskId,
      span.parentSpanId,
      span.name,
      span.kind,
      status,
      span.startTime,
      endTime,
      JSON.stringify(span.attributes),
      JSON.stringify(span.events),
    );
  }

  return {
    startTrace(taskId: string, _packKey: string): string {
      const traceId = randomUUID();
      traceTaskMap.set(traceId, taskId);
      return traceId;
    },

    startSpan(
      traceId: string,
      name: string,
      kind: SpanKind,
      parentSpanId?: string,
      attributes?: Record<string, unknown>,
    ): string {
      const id = randomUUID();
      inFlight.set(id, {
        id,
        traceId,
        taskId: traceTaskMap.get(traceId) ?? null,
        parentSpanId: parentSpanId ?? null,
        name,
        kind,
        startTime: Date.now(),
        attributes: attributes ?? {},
        events: [],
      });
      return id;
    },

    endSpan(spanId: string, status: SpanStatus = "ok"): void {
      flushSpan(spanId, status, Date.now());
    },

    addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
      const span = inFlight.get(spanId);
      if (!span) return;
      span.events.push({ time: Date.now(), name, attributes });
    },

    shutdown(): void {
      clearInterval(safetyInterval);
      for (const id of [...inFlight.keys()]) {
        flushSpan(id, "abandoned", Date.now());
      }
    },
  };
}
