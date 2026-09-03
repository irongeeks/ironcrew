import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { shouldRequireCsrf, hasValidCsrfToken, getCsrfToken } from "../../../security/auth.ts";
import type { Request } from "express";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      cron_expression   TEXT NOT NULL,
      timezone          TEXT NOT NULL DEFAULT 'UTC',
      workflow_pack_key TEXT DEFAULT NULL,
      project_path      TEXT DEFAULT NULL,
      department_id     TEXT DEFAULT NULL,
      priority          INTEGER NOT NULL DEFAULT 5,
      enabled           INTEGER NOT NULL DEFAULT 1,
      next_run_at       INTEGER NOT NULL,
      last_run_at       INTEGER DEFAULT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE task_creation_audits (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      trigger_detail TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      completed_at INTEGER
    )
  `);
  return db;
}

describe("scheduled-tasks cron validation", () => {
  it("should accept valid cron expressions", () => {
    expect(() => CronExpressionParser.parse("0 9 * * *")).not.toThrow();
    expect(() => CronExpressionParser.parse("0 9 * * MON")).not.toThrow();
    expect(() => CronExpressionParser.parse("*/15 * * * *")).not.toThrow();
  });

  it("should reject invalid cron expressions", () => {
    expect(() => CronExpressionParser.parse("not a cron")).toThrow();
  });

  it("should compute next run from cron expression", () => {
    const interval = CronExpressionParser.parse("0 9 * * *", {
      currentDate: new Date("2026-04-04T10:00:00Z"),
      tz: "UTC",
    });
    const next = interval.next().toDate();
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCDate()).toBe(5);
  });
});

describe("scheduled-tasks DB operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("should insert and list schedules", () => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, title, cron_expression, timezone, priority, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "Weekly review", "0 9 * * MON", "Europe/Berlin", 7, now + 86400000, now, now);

    const rows = db.prepare("SELECT * FROM scheduled_tasks").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Weekly review");
    expect(rows[0].timezone).toBe("Europe/Berlin");
    expect(rows[0].priority).toBe(7);
    db.close();
  });

  it("should toggle enabled flag", () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run(id, "Toggle me", "0 9 * * *", Date.now());

    db.prepare("UPDATE scheduled_tasks SET enabled = 1 - enabled WHERE id = ?").run(id);
    const row = db.prepare("SELECT enabled FROM scheduled_tasks WHERE id = ?").get(id) as any;
    expect(row.enabled).toBe(0);
    db.close();
  });

  it("should delete a schedule", () => {
    const id = randomUUID();
    db.prepare("INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at) VALUES (?, ?, ?, ?)").run(
      id,
      "Delete me",
      "0 9 * * *",
      Date.now(),
    );

    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    expect(row).toBeUndefined();
    db.close();
  });

  it("should reject invalid timezone at validation level", () => {
    // Intl.DateTimeFormat throws on invalid timezone — our Zod schema uses this
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "UTC" })).not.toThrow();
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "Europe/Berlin" })).not.toThrow();
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "America/New_York" })).not.toThrow();
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "Nope/Bad" })).toThrow();
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "" })).toThrow();
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: "invalid" })).toThrow();
  });

  it("should query history via task_creation_audits join", () => {
    const schedId = randomUUID();
    const taskId = randomUUID();
    const now = Date.now();

    db.prepare("INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, ?, ?)").run(
      taskId,
      "Created by schedule",
      "inbox",
      now,
    );
    db.prepare(
      "INSERT INTO task_creation_audits (id, task_id, trigger, trigger_detail, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), taskId, "scheduled", schedId, now);

    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.created_at
       FROM tasks t
       JOIN task_creation_audits a ON a.task_id = t.id
       WHERE a.trigger = 'scheduled' AND a.trigger_detail = ?
       ORDER BY t.created_at DESC
       LIMIT 20`,
      )
      .all(schedId) as any[];

    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Created by schedule");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// CSRF guard tests — verify mutation endpoints require CSRF token
// ---------------------------------------------------------------------------

function mockRequest(overrides: Partial<{ method: string; headers: Record<string, string> }>): Request {
  const headers: Record<string, string> = overrides.headers ?? {};
  return {
    method: overrides.method ?? "GET",
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
  } as unknown as Request;
}

describe("scheduled-tasks CSRF protection", () => {
  it("POST without CSRF token should require CSRF (no bearer bypass)", () => {
    const req = mockRequest({ method: "POST" });
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(false);
  });

  it("PUT without CSRF token should require CSRF", () => {
    const req = mockRequest({ method: "PUT" });
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(false);
  });

  it("DELETE without CSRF token should require CSRF", () => {
    const req = mockRequest({ method: "DELETE" });
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(false);
  });

  it("POST with valid CSRF token should pass", () => {
    const token = getCsrfToken();
    const req = mockRequest({ method: "POST", headers: { "x-csrf-token": token } });
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(true);
  });

  it("GET should not require CSRF", () => {
    const req = mockRequest({ method: "GET" });
    expect(shouldRequireCsrf(req)).toBe(false);
  });
});
