import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { registerAgentCrudRoutes } from "../../../modules/routes/core/agents/crud.ts";

/**
 * Tests for agent CRUD route handlers and their internal helper functions.
 * Uses a minimal in-memory SQLite database and fake Express app/response objects.
 */

// ---------------------------------------------------------------------------
// Test harness (mirrors the pattern from crud.seed-filter.test.ts)
// ---------------------------------------------------------------------------

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

function createHarness(): { db: DatabaseSync; routes: Map<string, RouteHandler> } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      color TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT,
      role TEXT NOT NULL,
      acts_as_planning_leader INTEGER NOT NULL DEFAULT 0,
      cli_provider TEXT,
      cli_profile TEXT,
      cli_model TEXT,
      cli_reasoning_level TEXT,
      oauth_account_id TEXT,
      api_provider_id TEXT,
      api_model TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      sprite_number INTEGER,
      personality TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority INTEGER NOT NULL DEFAULT 0,
      assigned_agent_id TEXT,
      department_id TEXT,
      workflow_pack_key TEXT,
      project_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      assigned_agent_id TEXT
    );

    CREATE TABLE meeting_minute_entries (
      id TEXT PRIMARY KEY,
      speaker_agent_id TEXT
    );

    CREATE TABLE task_report_archives (
      id TEXT PRIMARY KEY,
      generated_by_agent_id TEXT
    );

    CREATE TABLE project_review_decision_states (
      id TEXT PRIMARY KEY,
      planner_agent_id TEXT
    );

    CREATE TABLE review_round_decision_states (
      id TEXT PRIMARY KEY,
      planner_agent_id TEXT
    );

    CREATE TABLE agent_server_access (
      agent_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, server_id)
    );

    CREATE TABLE office_pack_departments (
      department_id TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL,
      name TEXT,
      name_ko TEXT,
      icon TEXT,
      color TEXT,
      sort_order INTEGER DEFAULT 0,
      PRIMARY KEY (workflow_pack_key, department_id)
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
    put(path: string, handler: RouteHandler) {
      routes.set(`PUT ${path}`, handler);
      return this;
    },
  };

  registerAgentCrudRoutes({
    app: app as any,
    db: db as any,
    broadcast: () => {},
    runInTransaction: (fn: () => void) => fn(),
    nowMs: () => 1000,
    meetingPresenceUntil: new Map(),
    meetingSeatIndexByAgent: new Map(),
    meetingPhaseByAgent: new Map(),
    meetingTaskIdByAgent: new Map(),
    meetingReviewDecisionByAgent: new Map(),
  } as any);

  return { db, routes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/agents — agent creation", () => {
  it("rejects creation without name", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("POST /api/agents");
      expect(handler).toBeDefined();

      const res = createFakeResponse();
      handler?.({ body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect((res.payload as { error: string }).error).toBe("name_required");
    } finally {
      db.close();
    }
  });

  it("rejects creation with empty string name", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("POST /api/agents");
      const res = createFakeResponse();
      handler?.({ body: { name: "   " } }, res);
      expect(res.statusCode).toBe(400);
      expect((res.payload as { error: string }).error).toBe("name_required");
    } finally {
      db.close();
    }
  });

  it("creates agent with valid name and defaults (no department)", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("POST /api/agents");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            name: "Test Agent",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(201);
      const payload = res.payload as { agent: { id: string; name: string; role: string } };
      expect(payload.agent).toBeDefined();
      expect(payload.agent.name).toBe("Test Agent");
      expect(payload.agent.role).toBe("junior"); // default role
    } finally {
      db.close();
    }
  });

  it("rejects invalid department_id type", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("POST /api/agents");
      const res = createFakeResponse();
      handler?.({ body: { name: "Agent", department_id: 123 } }, res);
      expect(res.statusCode).toBe(400);
      expect((res.payload as { error: string }).error).toBe("invalid_department_id");
    } finally {
      db.close();
    }
  });
});

describe("GET /api/agents/:id — agent detail", () => {
  it("returns 404 for non-existent agent", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("GET /api/agents/:id");
      expect(handler).toBeDefined();

      const res = createFakeResponse();
      handler?.({ params: { id: "non-existent" } }, res);
      expect(res.statusCode).toBe(404);
      expect((res.payload as { error: string }).error).toBe("not_found");
    } finally {
      db.close();
    }
  });

  it("returns agent data for existing agent", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO departments (id, name) VALUES ('dev', 'Development')").run();
      db.prepare(
        "INSERT INTO agents (id, name, department_id, role, status, created_at) VALUES (?, ?, 'dev', 'senior', 'idle', 1)",
      ).run("agent-1", "Alice");

      const handler = routes.get("GET /api/agents/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "agent-1" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { agent: { id: string; name: string }; recent_tasks: unknown[] };
      expect(payload.agent.id).toBe("agent-1");
      expect(payload.agent.name).toBe("Alice");
      expect(payload.recent_tasks).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("GET /api/agents — agent listing", () => {
  it("returns empty array when no agents", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("GET /api/agents");
      const res = createFakeResponse();
      handler?.({ query: {} }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { agents: unknown[] };
      expect(payload.agents).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("filters out seed agents by default", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 1)").run(
        "normal-agent",
        "Normal",
      );
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 2)").run(
        "pack-seed-1",
        "Seed Agent",
      );

      const handler = routes.get("GET /api/agents");
      const res = createFakeResponse();
      handler?.({ query: {} }, res);

      const payload = res.payload as { agents: Array<{ id: string }> };
      const ids = payload.agents.map((a) => a.id);
      expect(ids).toContain("normal-agent");
      expect(ids).not.toContain("pack-seed-1");
    } finally {
      db.close();
    }
  });

  it("includes seed agents when include_seed=true", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 1)").run(
        "normal-agent",
        "Normal",
      );
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 2)").run(
        "pack-seed-1",
        "Seed Agent",
      );

      const handler = routes.get("GET /api/agents");
      const res = createFakeResponse();
      handler?.({ query: { include_seed: "true" } }, res);

      const payload = res.payload as { agents: Array<{ id: string }> };
      const ids = payload.agents.map((a) => a.id);
      expect(ids).toContain("normal-agent");
      expect(ids).toContain("pack-seed-1");
    } finally {
      db.close();
    }
  });
});

describe("GET /api/meeting-presence", () => {
  it("returns empty presence when no meetings active", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("GET /api/meeting-presence");
      expect(handler).toBeDefined();

      const res = createFakeResponse();
      handler?.({}, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { presence: unknown[] };
      expect(payload.presence).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("PATCH /api/agents/:id — agent update", () => {
  it("returns 404 for non-existent agent", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("PATCH /api/agents/:id");
      expect(handler).toBeDefined();

      const res = createFakeResponse();
      handler?.({ params: { id: "non-existent" }, body: { name: "New Name" } }, res);
      expect(res.statusCode).toBe(404);
    } finally {
      db.close();
    }
  });

  it("updates agent name", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 1)").run(
        "agent-1",
        "Old Name",
      );

      const handler = routes.get("PATCH /api/agents/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "agent-1" }, body: { name: "New Name" } }, res);

      expect(res.statusCode).toBe(200);
      const row = db.prepare("SELECT name FROM agents WHERE id = ?").get("agent-1") as { name: string };
      expect(row.name).toBe("New Name");
    } finally {
      db.close();
    }
  });

  it("updates agent status", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 1)").run(
        "agent-1",
        "Agent",
      );

      const handler = routes.get("PATCH /api/agents/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "agent-1" }, body: { status: "working" } }, res);

      expect(res.statusCode).toBe(200);
      const row = db.prepare("SELECT status FROM agents WHERE id = ?").get("agent-1") as { status: string };
      expect(row.status).toBe("working");
    } finally {
      db.close();
    }
  });
});

describe("DELETE /api/agents/:id — agent deletion", () => {
  it("deletes an existing agent", () => {
    const { db, routes } = createHarness();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status, created_at) VALUES (?, ?, 'senior', 'idle', 1)").run(
        "agent-1",
        "Agent",
      );

      const handler = routes.get("DELETE /api/agents/:id");
      expect(handler).toBeDefined();

      const res = createFakeResponse();
      handler?.({ params: { id: "agent-1" } }, res);

      expect(res.statusCode).toBe(200);
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get("agent-1");
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns 404 for non-existent agent", () => {
    const { db, routes } = createHarness();
    try {
      const handler = routes.get("DELETE /api/agents/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "ghost" } }, res);

      expect(res.statusCode).toBe(404);
    } finally {
      db.close();
    }
  });
});
