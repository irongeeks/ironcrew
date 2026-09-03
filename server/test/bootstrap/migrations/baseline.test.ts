import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyBaseSchema } from "../../../modules/bootstrap/schema/base-schema.ts";
import { migration as baseline } from "../../../modules/bootstrap/migrations/0000-baseline.ts";
import { hasColumn, hasTable } from "../../../modules/bootstrap/migrations/migration-types.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe("baseline migration (version 0)", () => {
  it("has version 0", () => {
    expect(baseline.version).toBe(0);
  });

  it("applies successfully on fresh DB (after base schema)", () => {
    expect(() => baseline.up(db)).not.toThrow();
  });

  it("is idempotent — running twice does not throw", () => {
    baseline.up(db);
    expect(() => baseline.up(db)).not.toThrow();
  });

  it("adds all expected columns to tasks", () => {
    baseline.up(db);
    expect(hasColumn(db, "tasks", "source_task_id")).toBe(true);
    expect(hasColumn(db, "tasks", "project_id")).toBe(true);
    expect(hasColumn(db, "tasks", "hidden")).toBe(true);
    expect(hasColumn(db, "tasks", "workflow_pack_key")).toBe(true);
    expect(hasColumn(db, "tasks", "workflow_meta_json")).toBe(true);
    expect(hasColumn(db, "tasks", "output_format")).toBe(true);
    expect(hasColumn(db, "tasks", "agent_routing")).toBe(true);
  });

  it("adds all expected columns to subtasks", () => {
    baseline.up(db);
    expect(hasColumn(db, "subtasks", "target_department_id")).toBe(true);
    expect(hasColumn(db, "subtasks", "delegated_task_id")).toBe(true);
  });

  it("adds all expected columns to agents", () => {
    baseline.up(db);
    expect(hasColumn(db, "agents", "cli_profile")).toBe(true);
    expect(hasColumn(db, "agents", "workflow_pack_key")).toBe(true);
    expect(hasColumn(db, "agents", "fallback_cli_provider")).toBe(true);
  });

  it("adds all expected columns to projects", () => {
    baseline.up(db);
    expect(hasColumn(db, "projects", "assignment_mode")).toBe(true);
    expect(hasColumn(db, "projects", "default_pack_key")).toBe(true);
    expect(hasColumn(db, "projects", "remote_server_id")).toBe(true);
    expect(hasColumn(db, "projects", "remote_path")).toBe(true);
  });

  it("creates migration-only tables", () => {
    baseline.up(db);
    expect(hasTable(db, "comfyui_workflows")).toBe(true);
    expect(hasTable(db, "project_agents")).toBe(true);
    expect(hasTable(db, "office_pack_departments")).toBe(true);
    expect(hasTable(db, "logs")).toBe(true);
    expect(hasTable(db, "workflow_spans")).toBe(true);
    expect(hasTable(db, "metrics")).toBe(true);
    expect(hasTable(db, "metrics_hourly")).toBe(true);
    expect(hasTable(db, "token_usage")).toBe(true);
  });

  it("adds task_creation_audits.completed column", () => {
    baseline.up(db);
    expect(hasColumn(db, "task_creation_audits", "completed")).toBe(true);
  });

  it("adds task_logs.span_id column", () => {
    baseline.up(db);
    expect(hasColumn(db, "task_logs", "span_id")).toBe(true);
  });

  it("adds messages.idempotency_key column", () => {
    baseline.up(db);
    expect(hasColumn(db, "messages", "idempotency_key")).toBe(true);
  });

  it("ensures foreign keys are ON after baseline", () => {
    baseline.up(db);
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });
});
