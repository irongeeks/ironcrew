import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricsCollector, type MetricsCollector } from "../metrics.ts";

describe("metrics", () => {
  let db: DatabaseSync;
  let metrics: MetricsCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT,
        recorded_at INTEGER NOT NULL,
        exported_at INTEGER
      )
    `);
    metrics = createMetricsCollector(db);
  });

  afterEach(() => {
    metrics.shutdown();
    db.close();
    vi.useRealTimers();
  });

  it("buffers counter increments and flushes on interval", async () => {
    metrics.incCounter("workflow.started", { pack: "video_preprod" });
    metrics.incCounter("workflow.started", { pack: "video_preprod" });

    const before = (db.prepare("SELECT COUNT(*) as c FROM metrics").get() as any).c;
    expect(before).toBe(0);

    await vi.advanceTimersByTimeAsync(5_100);

    const after = (db.prepare("SELECT COUNT(*) as c FROM metrics").get() as any).c;
    expect(after).toBe(2);
  });

  it("flushes when buffer reaches 100 entries", () => {
    for (let i = 0; i < 100; i++) {
      metrics.incCounter("test.counter");
    }
    const count = (db.prepare("SELECT COUNT(*) as c FROM metrics").get() as any).c;
    expect(count).toBe(100);
  });

  it("records histogram values with labels", async () => {
    metrics.recordHistogram("phase.duration_ms", 1500, { pack: "web_research", phase: "crawl" });
    await vi.advanceTimersByTimeAsync(5_100);

    const row = db.prepare("SELECT * FROM metrics WHERE name = ?").get("phase.duration_ms") as any;
    expect(row.type).toBe("histogram");
    expect(row.value).toBe(1500);
    const labels = JSON.parse(row.labels);
    expect(labels.pack).toBe("web_research");
  });

  it("records gauge values", async () => {
    metrics.setGauge("active.workflows", 3);
    await vi.advanceTimersByTimeAsync(5_100);

    const row = db.prepare("SELECT * FROM metrics WHERE name = ?").get("active.workflows") as any;
    expect(row.type).toBe("gauge");
    expect(row.value).toBe(3);
  });

  it("serializes labels as null when empty", async () => {
    metrics.incCounter("test.no_labels");
    await vi.advanceTimersByTimeAsync(5_100);

    const row = db.prepare("SELECT labels FROM metrics WHERE name = ?").get("test.no_labels") as any;
    expect(row.labels).toBeNull();
  });

  it("shutdown flushes remaining buffer", () => {
    metrics.incCounter("test.final");
    metrics.shutdown();

    const count = (db.prepare("SELECT COUNT(*) as c FROM metrics").get() as any).c;
    expect(count).toBe(1);
  });
});
