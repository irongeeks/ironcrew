import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRetention } from "../retention.ts";

describe("retention", () => {
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
    db.exec(
      `CREATE TABLE metrics_hourly (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, labels TEXT, hour INTEGER, count INTEGER, sum REAL, min REAL, max REAL, avg REAL)`,
    );
    db.exec(`CREATE UNIQUE INDEX idx_metrics_hourly_key ON metrics_hourly(name, labels, hour)`);
  });

  afterEach(() => {
    db.close();
  });

  it("purges exported logs older than retention threshold", () => {
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    db.prepare("INSERT INTO logs (level, message, logged_at, exported_at) VALUES (30, 'old-exported', ?, ?)").run(
      oldTime,
      oldTime + 1000,
    );
    db.prepare("INSERT INTO logs (level, message, logged_at) VALUES (30, 'old-unexported', ?)").run(oldTime);
    db.prepare("INSERT INTO logs (level, message, logged_at) VALUES (30, 'recent', ?)").run(Date.now());

    runRetention(db, {
      metricsRetentionDays: 7,
      aggregateRetentionDays: 90,
      spanRetentionDays: 30,
      logRetentionDays: 7,
      maxLogRows: 500_000,
    });

    const rows = db.prepare("SELECT message FROM logs").all() as any[];
    const messages = rows.map((r: any) => r.message);
    expect(messages).toContain("recent");
    expect(messages).toContain("old-unexported"); // kept: not exported yet
    expect(messages).not.toContain("old-exported"); // purged: exported + old
  });

  it("marks orphaned spans as abandoned after 24h", () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO workflow_spans (id, trace_id, name, kind, start_time) VALUES ('s1', 't1', 'test', 'agent', ?)",
    ).run(old);

    runRetention(db, {
      metricsRetentionDays: 7,
      aggregateRetentionDays: 90,
      spanRetentionDays: 30,
      logRetentionDays: 7,
      maxLogRows: 500_000,
    });

    const span = db.prepare("SELECT status, end_time FROM workflow_spans WHERE id = 's1'").get() as any;
    expect(span.status).toBe("abandoned");
    expect(span.end_time).toBeGreaterThan(0);
  });

  it("aggregates old metrics into metrics_hourly", () => {
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const hour = Math.floor(oldTime / 1000 / 3600) * 3600;
    db.prepare(
      "INSERT INTO metrics (name, type, value, labels, recorded_at, exported_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("test.counter", "counter", 1, '{"a":"b"}', oldTime, oldTime);
    db.prepare(
      "INSERT INTO metrics (name, type, value, labels, recorded_at, exported_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("test.counter", "counter", 1, '{"a":"b"}', oldTime + 1000, oldTime + 1000);

    runRetention(db, {
      metricsRetentionDays: 7,
      aggregateRetentionDays: 90,
      spanRetentionDays: 30,
      logRetentionDays: 7,
      maxLogRows: 500_000,
    });

    const agg = db.prepare("SELECT * FROM metrics_hourly WHERE name = 'test.counter'").get() as any;
    expect(agg.count).toBe(2);
    expect(agg.sum).toBe(2);
    expect(agg.hour).toBe(hour);

    // Raw metrics should be purged
    const raw = db.prepare("SELECT COUNT(*) as c FROM metrics WHERE name = 'test.counter'").get() as any;
    expect(raw.c).toBe(0);
  });

  it("triggers emergency purge when maxLogRows exceeded", () => {
    // Insert just over the threshold
    const maxRows = 100; // Use a small number for testing
    for (let i = 0; i < maxRows + 20; i++) {
      db.prepare("INSERT INTO logs (level, message, logged_at) VALUES (30, ?, ?)").run(
        `msg-${i}`,
        Date.now() - i * 1000,
      );
    }

    runRetention(db, {
      metricsRetentionDays: 7,
      aggregateRetentionDays: 90,
      spanRetentionDays: 30,
      logRetentionDays: 7,
      maxLogRows: maxRows,
    });

    const count = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as any).c;
    expect(count).toBeLessThan(maxRows + 20); // Some were purged
  });

  it("purges exported spans older than retention threshold", () => {
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    db.prepare(
      "INSERT INTO workflow_spans (id, trace_id, name, kind, start_time, end_time, exported_at) VALUES ('s1', 't1', 'test', 'system', ?, ?, ?)",
    ).run(oldTime, oldTime + 1000, oldTime + 2000);
    db.prepare(
      "INSERT INTO workflow_spans (id, trace_id, name, kind, start_time, end_time) VALUES ('s2', 't2', 'recent', 'system', ?, ?)",
    ).run(Date.now() - 1000, Date.now());

    runRetention(db, {
      metricsRetentionDays: 7,
      aggregateRetentionDays: 90,
      spanRetentionDays: 30,
      logRetentionDays: 7,
      maxLogRows: 500_000,
    });

    const rows = db.prepare("SELECT id FROM workflow_spans").all() as any[];
    expect(rows.map((r: any) => r.id)).toEqual(["s2"]); // s1 purged, s2 kept
  });
});
