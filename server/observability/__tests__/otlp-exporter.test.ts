import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtlpExporter } from "../otlp-exporter.ts";

describe("otlp-exporter", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level INTEGER, module TEXT, message TEXT, data TEXT, logged_at INTEGER, exported_at INTEGER)`,
    );
    db.exec(
      `CREATE TABLE workflow_spans (id TEXT PRIMARY KEY, trace_id TEXT, task_id TEXT, parent_span_id TEXT, name TEXT, kind TEXT, status TEXT DEFAULT 'ok', start_time INTEGER, end_time INTEGER, attributes TEXT, events TEXT, exported_at INTEGER)`,
    );
    db.exec(
      `CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, value REAL, labels TEXT, recorded_at INTEGER, exported_at INTEGER)`,
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("marks spans as exported after successful POST", async () => {
    db.prepare(
      "INSERT INTO workflow_spans (id, trace_id, name, kind, start_time, end_time, attributes, events) VALUES (?, ?, ?, ?, ?, ?, '{}', '[]')",
    ).run("s1", "t1", "test", "system", 1000, 2000);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const exporter = createOtlpExporter(db, { endpoint: "http://localhost:4318", intervalMs: 100 });
    await exporter.exportOnce();
    exporter.shutdown();

    const span = db.prepare("SELECT exported_at FROM workflow_spans WHERE id = 's1'").get() as any;
    expect(span.exported_at).toBeGreaterThan(0);
  });

  it("does NOT mark as exported on HTTP failure", async () => {
    db.prepare(
      "INSERT INTO workflow_spans (id, trace_id, name, kind, start_time, end_time, attributes, events) VALUES (?, ?, ?, ?, ?, ?, '{}', '[]')",
    ).run("s1", "t1", "test", "system", 1000, 2000);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    const exporter = createOtlpExporter(db, { endpoint: "http://localhost:4318", intervalMs: 100 });
    await exporter.exportOnce();
    exporter.shutdown();

    const span = db.prepare("SELECT exported_at FROM workflow_spans WHERE id = 's1'").get() as any;
    expect(span.exported_at).toBeNull();
  });

  it("marks metrics as exported after successful POST", async () => {
    db.prepare(
      "INSERT INTO metrics (name, type, value, labels, recorded_at) VALUES ('test', 'counter', 1, null, ?)",
    ).run(Date.now());

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const exporter = createOtlpExporter(db, { endpoint: "http://localhost:4318", intervalMs: 100 });
    await exporter.exportOnce();
    exporter.shutdown();

    const metric = db.prepare("SELECT exported_at FROM metrics WHERE name = 'test'").get() as any;
    expect(metric.exported_at).toBeGreaterThan(0);
  });

  it("marks logs as exported after successful POST", async () => {
    db.prepare("INSERT INTO logs (level, message, logged_at) VALUES (30, 'test log', ?)").run(Date.now());

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const exporter = createOtlpExporter(db, { endpoint: "http://localhost:4318", intervalMs: 100 });
    await exporter.exportOnce();
    exporter.shutdown();

    const log = db.prepare("SELECT exported_at FROM logs WHERE message = 'test log'").get() as any;
    expect(log.exported_at).toBeGreaterThan(0);
  });

  it("skips export when no unexported data exists", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const exporter = createOtlpExporter(db, { endpoint: "http://localhost:4318", intervalMs: 100 });
    await exporter.exportOnce();
    exporter.shutdown();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
