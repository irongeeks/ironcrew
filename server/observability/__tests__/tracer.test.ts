import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracer, type Tracer } from "../tracer.ts";

describe("tracer", () => {
  let db: DatabaseSync;
  let tracer: Tracer;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE workflow_spans (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        task_id TEXT,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT DEFAULT 'ok',
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        attributes TEXT,
        events TEXT,
        exported_at INTEGER
      )
    `);
    tracer = createTracer(db);
  });

  afterEach(() => {
    tracer.shutdown();
    db.close();
  });

  it("startTrace returns a unique traceId per call", () => {
    const id1 = tracer.startTrace("task-1", "video_preprod");
    const id2 = tracer.startTrace("task-1", "video_preprod");
    expect(id1).not.toBe(id2);
  });

  it("startSpan + endSpan writes a completed span to SQLite", () => {
    const traceId = tracer.startTrace("task-1", "test-pack");
    const spanId = tracer.startSpan(traceId, "phase:concept", "phase", undefined, { phaseId: "concept" });
    tracer.endSpan(spanId, "ok");

    const rows = db.prepare("SELECT * FROM workflow_spans WHERE id = ?").all(spanId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe(traceId);
    expect(rows[0].task_id).toBe("task-1");
    expect(rows[0].name).toBe("phase:concept");
    expect(rows[0].kind).toBe("phase");
    expect(rows[0].status).toBe("ok");
    expect(rows[0].end_time).toBeGreaterThan(0);
    const attrs = JSON.parse(rows[0].attributes);
    expect(attrs.phaseId).toBe("concept");
  });

  it("addEvent accumulates events, flushed on endSpan", () => {
    const traceId = tracer.startTrace("task-1", "test-pack");
    const spanId = tracer.startSpan(traceId, "connector:text2img", "connector");
    tracer.addEvent(spanId, "workflow_submitted", { promptId: "abc" });
    tracer.addEvent(spanId, "poll_attempt", { attempt: 1 });
    tracer.addEvent(spanId, "poll_attempt", { attempt: 2 });
    tracer.endSpan(spanId, "ok");

    const row = db.prepare("SELECT events FROM workflow_spans WHERE id = ?").get(spanId) as any;
    const events = JSON.parse(row.events);
    expect(events).toHaveLength(3);
    expect(events[0].name).toBe("workflow_submitted");
    expect(events[2].attributes.attempt).toBe(2);
  });

  it("does NOT write to SQLite until endSpan is called", () => {
    const traceId = tracer.startTrace("task-1", "test-pack");
    tracer.startSpan(traceId, "agent:Vision", "agent");
    const rows = db.prepare("SELECT * FROM workflow_spans").all();
    expect(rows).toHaveLength(0);
  });

  it("supports parent-child span hierarchy", () => {
    const traceId = tracer.startTrace("task-1", "test-pack");
    const rootSpan = tracer.startSpan(traceId, "workflow:test", "system");
    const childSpan = tracer.startSpan(traceId, "phase:concept", "phase", rootSpan);
    tracer.endSpan(childSpan, "ok");
    tracer.endSpan(rootSpan, "ok");

    const child = db.prepare("SELECT parent_span_id FROM workflow_spans WHERE id = ?").get(childSpan) as any;
    expect(child.parent_span_id).toBe(rootSpan);
  });

  it("shutdown flushes in-flight spans as abandoned", () => {
    const traceId = tracer.startTrace("task-1", "test-pack");
    tracer.startSpan(traceId, "agent:test", "agent");
    tracer.shutdown();

    const rows = db.prepare("SELECT status FROM workflow_spans").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("abandoned");
  });

  it("safety-net flushes orphaned spans after 4 hours as abandoned with real end_time", async () => {
    vi.useFakeTimers();
    const freshDb = new DatabaseSync(":memory:");
    freshDb.exec(
      `CREATE TABLE workflow_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, task_id TEXT, parent_span_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT DEFAULT 'ok', start_time INTEGER NOT NULL, end_time INTEGER, attributes TEXT, events TEXT, exported_at INTEGER)`,
    );
    const freshTracer = createTracer(freshDb);

    const traceId = freshTracer.startTrace("task-1", "test-pack");
    freshTracer.startSpan(traceId, "orphan:test", "system");

    // Should NOT flush after just 1 minute (safety interval runs every 60s)
    await vi.advanceTimersByTimeAsync(61_000);
    expect(freshDb.prepare("SELECT * FROM workflow_spans").all()).toHaveLength(0);

    // Advance past 4-hour timeout
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

    const rows = freshDb.prepare("SELECT * FROM workflow_spans").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("abandoned");
    expect(rows[0].end_time).toBeGreaterThan(0); // real end_time, not null

    freshTracer.shutdown();
    freshDb.close();
    vi.useRealTimers();
  });
});
