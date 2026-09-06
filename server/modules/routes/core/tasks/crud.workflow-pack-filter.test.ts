import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerTaskCrudRoutes } from "./crud.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function createTaskCrudHarness(): { db: DatabaseSync; routes: Map<string, RouteHandler> } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT REFERENCES agents(id),
      project_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      workflow_meta_json TEXT,
      output_format TEXT,
      project_path TEXT,
      base_branch TEXT,
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      source_task_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      skipped_phases TEXT NOT NULL DEFAULT '[]',
      agent_routing TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      avatar_emoji TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      core_goal TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      last_used_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delegated_task_id TEXT
    );
  `);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return this;
    },
    patch(path: string, handler: RouteHandler) {
      routes.set(`PATCH ${path}`, handler);
      return this;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return this;
    },
  };

  registerTaskCrudRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === "string");
        return typeof first === "string" ? first : undefined;
      }
      return undefined;
    },
    reconcileCrossDeptSubtasks: () => {},
    normalizeTextField: (raw: unknown) => {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    recordTaskCreationAudit: () => {},
    appendTaskLog: () => {},
    broadcast: () => {},
    setTaskCreationAuditCompletion: () => {},
    clearTaskWorkflowState: () => {},
    endTaskExecutionSession: () => {},
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    killPidTree: () => {},
    logsDir: "/tmp",
  });

  return { db, routes };
}

describe("task CRUD workflow pack filter", () => {
  it("GET /api/tasks는 workflow_pack_key 필터를 적용한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-report-1",
        "Report task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "report",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-dev-1",
        "Dev task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "development",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "report" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { tasks: Array<{ id: string; workflow_pack_key: string }> };
      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]).toMatchObject({
        id: "task-report-1",
        workflow_pack_key: "report",
      });
    } finally {
      db.close();
    }
  });

  it("GET /api/tasks는 invalid workflow_pack_key에 400을 반환한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "invalid-pack" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "invalid_workflow_pack_key" });
    } finally {
      db.close();
    }
  });

  it("POST /api/tasks는 workflow_pack_key 미지정 시 프로젝트 default_pack_key를 상속한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO projects (id, name, core_goal, project_path, default_pack_key)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run("project-novel", "Novel Project", "goal", "/tmp/novel-project", "novel");

      const handler = routes.get("POST /api/tasks") as RouteHandler | undefined;
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.(
        {
          body: {
            title: "Project-default pack task",
            project_id: "project-novel",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { task: { workflow_pack_key: string; project_id: string; project_path: string } };
      expect(payload.task.workflow_pack_key).toBe("novel");
      expect(payload.task.project_id).toBe("project-novel");
      expect(payload.task.project_path).toBe("/tmp/novel-project");
    } finally {
      db.close();
    }
  });
});

describe("task CRUD path and assignment validation", () => {
  it("accepts registered missing paths under symlink ancestors and rejects escaping siblings", () => {
    const { db, routes } = createTaskCrudHarness();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-project-path-"));
    try {
      const real = path.join(directory, "real");
      const alias = path.join(directory, "alias");
      fs.mkdirSync(real);
      fs.symlinkSync(real, alias, "dir");
      const projectPath = path.join(alias, "not-created", "project");
      db.prepare("INSERT INTO projects (id, project_path) VALUES (?, ?)").run("registered", projectPath);
      const create = routes.get("POST /api/tasks")!;
      for (const project_path of [projectPath, path.join(projectPath, "child")]) {
        const res = createFakeResponse();
        create({ body: { title: "New workspace", project_path } }, res);
        expect(res.statusCode).toBe(200);
        expect(fs.existsSync(project_path)).toBe(false);
      }
      const denied = createFakeResponse();
      create({ body: { title: "Outside workspace", project_path: `${projectPath}-outside` } }, denied);
      expect(denied.statusCode).toBe(400);
      expect(denied.payload).toEqual({ error: "project_path_not_allowed" });

      const outside = path.join(directory, "outside");
      fs.mkdirSync(outside);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.symlinkSync(outside, path.join(projectPath, "escape"), "dir");
      const escaped = createFakeResponse();
      create({ body: { title: "Symlink escape", project_path: path.join(projectPath, "escape", "new") } }, escaped);
      expect(escaped.statusCode).toBe(400);
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown and Crew-only assignments before SQL and permits valid assignment and clearing", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.exec(
        "CREATE TABLE crew_agents (id TEXT PRIMARY KEY); INSERT INTO crew_agents VALUES ('crew-only'); INSERT INTO agents (id) VALUES ('legacy-agent');",
      );
      const create = routes.get("POST /api/tasks")!;
      const update = routes.get("PATCH /api/tasks/:id")!;
      for (const assigned_agent_id of ["missing", "crew-only", ""]) {
        const res = createFakeResponse();
        create({ body: { title: "Invalid assignment", assigned_agent_id } }, res);
        expect(res.statusCode).toBe(400);
        expect(res.payload).toMatchObject({ error: "agent_not_found" });
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
      const created = createFakeResponse();
      create({ body: { title: "Valid assignment", assigned_agent_id: "legacy-agent" } }, created);
      expect(created.statusCode).toBe(200);
      const { id } = created.payload as { id: string };
      for (const assigned_agent_id of ["missing", "crew-only", ""]) {
        const res = createFakeResponse();
        update({ params: { id }, body: { title: "Must not persist", assigned_agent_id } }, res);
        expect(res.statusCode).toBe(400);
        expect(res.payload).toMatchObject({ error: "agent_not_found" });
        expect(db.prepare("SELECT title, assigned_agent_id FROM tasks WHERE id = ?").get(id)).toEqual({
          title: "Valid assignment",
          assigned_agent_id: "legacy-agent",
        });
      }
      const cleared = createFakeResponse();
      update({ params: { id }, body: { assigned_agent_id: null } }, cleared);
      expect(cleared.statusCode).toBe(200);
      expect(db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(id)).toEqual({
        assigned_agent_id: null,
      });
    } finally {
      db.close();
    }
  });
});
