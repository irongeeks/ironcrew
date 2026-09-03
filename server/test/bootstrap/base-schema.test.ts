import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyBaseSchema } from "../../modules/bootstrap/schema/base-schema.ts";

const EXPECTED_TABLES = [
  "departments",
  "office_pack_departments",
  "agents",
  "projects",
  "workflow_packs",
  "tasks",
  "task_creation_audits",
  "messages",
  "task_logs",
  "task_interrupt_injections",
  "meeting_minutes",
  "meeting_minute_entries",
  "review_revision_history",
  "settings",
  "oauth_credentials",
  "oauth_accounts",
  "oauth_active_accounts",
  "oauth_states",
  "cli_usage_cache",
  "subtasks",
  "task_report_archives",
  "project_review_decision_states",
  "project_review_decision_events",
  "review_round_decision_states",
  "skill_learning_history",
  "docs_providers",
  "docs_provider_bindings",
  "servers",
  "server_allocations",
  "agent_server_access",
  "api_providers",
  "scheduled_tasks",
];

function getTableNames(db: DatabaseSync): string[] {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return (stmt.all() as Array<{ name: string }>).map((r) => r.name);
}

function getIndexNames(db: DatabaseSync): string[] {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return (stmt.all() as Array<{ name: string }>).map((r) => r.name);
}

function getTableInfo(
  db: DatabaseSync,
  table: string,
): Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as any;
}

describe("applyBaseSchema", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all expected tables", () => {
    applyBaseSchema(db);
    const tables = getTableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it("creates no unexpected tables", () => {
    applyBaseSchema(db);
    const tables = getTableNames(db);
    for (const t of tables) {
      expect(EXPECTED_TABLES, `unexpected table: ${t}`).toContain(t);
    }
  });

  it("is idempotent — running twice does not error", () => {
    applyBaseSchema(db);
    expect(() => applyBaseSchema(db)).not.toThrow();
    // Tables should still all exist
    const tables = getTableNames(db);
    expect(tables.length).toBe(EXPECTED_TABLES.length);
  });

  it("creates expected indexes", () => {
    applyBaseSchema(db);
    const indexes = getIndexNames(db);
    const expectedIndexPrefixes = [
      "idx_subtasks_task",
      "idx_subtasks_status_task",
      "idx_agents_status_dept",
      "idx_tasks_status",
      "idx_tasks_agent",
      "idx_tasks_dept",
      "idx_messages_receiver",
      "idx_meeting_minutes_task",
      "idx_servers_type_status",
    ];
    for (const prefix of expectedIndexPrefixes) {
      expect(
        indexes.some((i) => i.startsWith(prefix)),
        `missing index starting with: ${prefix}`,
      ).toBe(true);
    }
  });

  describe("departments table", () => {
    it("has correct columns and constraints", () => {
      applyBaseSchema(db);
      const cols = getTableInfo(db, "departments");
      const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(colMap["id"].pk).toBe(1);
      expect(colMap["name"].notnull).toBe(1);
      expect(colMap["name_ko"].notnull).toBe(1);
      expect(colMap["icon"].notnull).toBe(1);
      expect(colMap["color"].notnull).toBe(1);
      expect(colMap["description"].notnull).toBe(0);
    });
  });

  describe("agents table", () => {
    it("has correct columns", () => {
      applyBaseSchema(db);
      const cols = getTableInfo(db, "agents");
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("department_id");
      expect(colNames).toContain("role");
      expect(colNames).toContain("cli_provider");
      expect(colNames).toContain("status");
      expect(colNames).toContain("updated_at");
    });

    it("enforces role CHECK constraint", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      expect(() =>
        db.exec(
          "INSERT INTO agents (id, name, department_id, role, avatar_emoji) VALUES ('a1', 'Test', 'd1', 'invalid_role', '🤖')",
        ),
      ).toThrow();
    });

    it("enforces status CHECK constraint", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      expect(() =>
        db.exec(
          "INSERT INTO agents (id, name, department_id, role, status, avatar_emoji) VALUES ('a1', 'Test', 'd1', 'senior', 'dancing', '🤖')",
        ),
      ).toThrow();
    });

    it("enforces cli_provider CHECK constraint", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      expect(() =>
        db.exec(
          "INSERT INTO agents (id, name, department_id, role, cli_provider, avatar_emoji) VALUES ('a1', 'Test', 'd1', 'senior', 'unknown_provider', '🤖')",
        ),
      ).toThrow();
    });

    it("accepts valid cli_provider values", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      const providers = ["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api", "openclaw"];
      for (const p of providers) {
        expect(() =>
          db.exec(
            `INSERT INTO agents (id, name, department_id, role, cli_provider, avatar_emoji) VALUES ('a_${p}', 'Test', 'd1', 'senior', '${p}', '🤖')`,
          ),
        ).not.toThrow();
      }
    });
  });

  describe("tasks table", () => {
    it("enforces status CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() => db.exec("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Test', 'invalid_status')")).toThrow();
    });

    it("enforces task_type CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec("INSERT INTO tasks (id, title, task_type) VALUES ('t1', 'Test', 'nonexistent_type')"),
      ).toThrow();
    });

    it("accepts all valid status values", () => {
      applyBaseSchema(db);
      const statuses = ["inbox", "planned", "collaborating", "in_progress", "review", "done", "cancelled", "pending"];
      for (const s of statuses) {
        expect(() => db.exec(`INSERT INTO tasks (id, title, status) VALUES ('t_${s}', 'Test', '${s}')`)).not.toThrow();
      }
    });

    it("defaults status to inbox", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Test')");
      const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
      expect(row.status).toBe("inbox");
    });
  });

  describe("messages table", () => {
    it("enforces sender_type CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec("INSERT INTO messages (id, sender_type, receiver_type, content) VALUES ('m1', 'hacker', 'all', 'hi')"),
      ).toThrow();
    });

    it("enforces message_type CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec(
          "INSERT INTO messages (id, sender_type, receiver_type, content, message_type) VALUES ('m1', 'ceo', 'all', 'hi', 'spam')",
        ),
      ).toThrow();
    });
  });

  describe("subtasks table", () => {
    it("enforces status CHECK constraint", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Parent')");
      expect(() =>
        db.exec("INSERT INTO subtasks (id, task_id, title, status) VALUES ('s1', 't1', 'Sub', 'invalid')"),
      ).toThrow();
    });

    it("accepts all valid status values", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Parent')");
      const statuses = ["pending", "in_progress", "done", "blocked", "awaiting_approval", "skipped"];
      for (const s of statuses) {
        expect(() =>
          db.exec(`INSERT INTO subtasks (id, task_id, title, status) VALUES ('s_${s}', 't1', 'Sub', '${s}')`),
        ).not.toThrow();
      }
    });
  });

  describe("oauth_accounts table", () => {
    it("enforces provider CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec("INSERT INTO oauth_accounts (id, provider, encrypted_data) VALUES ('oa1', 'twitter', 'enc')"),
      ).toThrow();
    });
  });

  describe("api_providers table", () => {
    it("enforces type CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec("INSERT INTO api_providers (id, name, type, base_url) VALUES ('ap1', 'Test', 'invalid', 'http://x')"),
      ).toThrow();
    });

    it("has allow_local column with default 0", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO api_providers (id, name, type, base_url) VALUES ('ap1', 'Test', 'openai', 'http://x')");
      const row = db.prepare("SELECT allow_local FROM api_providers WHERE id = 'ap1'").get() as { allow_local: number };
      expect(row.allow_local).toBe(0);
    });
  });

  describe("office_pack_departments table", () => {
    it("has composite primary key", () => {
      applyBaseSchema(db);
      db.exec(
        "INSERT INTO office_pack_departments (workflow_pack_key, department_id, name, name_ko, icon, color) VALUES ('pk1', 'd1', 'N', 'K', '🔧', '#f00')",
      );
      // Duplicate composite key should fail
      expect(() =>
        db.exec(
          "INSERT INTO office_pack_departments (workflow_pack_key, department_id, name, name_ko, icon, color) VALUES ('pk1', 'd1', 'N2', 'K2', '🔧', '#f00')",
        ),
      ).toThrow();
      // Different combo should succeed
      expect(() =>
        db.exec(
          "INSERT INTO office_pack_departments (workflow_pack_key, department_id, name, name_ko, icon, color) VALUES ('pk1', 'd2', 'N', 'K', '🔧', '#f00')",
        ),
      ).not.toThrow();
    });
  });

  describe("review_revision_history table", () => {
    it("enforces UNIQUE(task_id, normalized_note)", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Test')");
      db.exec(
        "INSERT INTO review_revision_history (id, task_id, normalized_note, raw_note, first_round) VALUES (1, 't1', 'fix bug', 'Fix the bug', 1)",
      );
      expect(() =>
        db.exec(
          "INSERT INTO review_revision_history (id, task_id, normalized_note, raw_note, first_round) VALUES (2, 't1', 'fix bug', 'Fix the bug again', 2)",
        ),
      ).toThrow();
    });
  });

  describe("skill_learning_history table", () => {
    it("enforces UNIQUE(job_id, provider)", () => {
      applyBaseSchema(db);
      db.exec(
        "INSERT INTO skill_learning_history (id, job_id, provider, repo, skill_id, skill_label, status, command) VALUES ('s1', 'j1', 'claude', 'repo', 'sk1', 'label', 'queued', 'cmd')",
      );
      expect(() =>
        db.exec(
          "INSERT INTO skill_learning_history (id, job_id, provider, repo, skill_id, skill_label, status, command) VALUES ('s2', 'j1', 'claude', 'repo', 'sk2', 'label2', 'queued', 'cmd2')",
        ),
      ).toThrow();
    });
  });

  describe("meeting_minutes table", () => {
    it("enforces meeting_type CHECK constraint", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Test')");
      expect(() =>
        db.exec(
          "INSERT INTO meeting_minutes (id, task_id, meeting_type, round, title, started_at) VALUES ('mm1', 't1', 'invalid', 1, 'M', 1000)",
        ),
      ).toThrow();
    });
  });

  describe("servers table", () => {
    it("enforces status CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() =>
        db.exec("INSERT INTO servers (id, name, type, status) VALUES ('srv1', 'S', 'gpu', 'exploding')"),
      ).toThrow();
    });

    it("enforces enabled CHECK constraint", () => {
      applyBaseSchema(db);
      expect(() => db.exec("INSERT INTO servers (id, name, type, enabled) VALUES ('srv1', 'S', 'gpu', 2)")).toThrow();
    });
  });

  describe("cascade deletes", () => {
    it("subtasks are deleted when parent task is deleted", () => {
      applyBaseSchema(db);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Parent')");
      db.exec("INSERT INTO subtasks (id, task_id, title) VALUES ('s1', 't1', 'Child')");
      db.exec("DELETE FROM tasks WHERE id = 't1'");
      const row = db.prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = 't1'").get() as { cnt: number };
      expect(row.cnt).toBe(0);
    });

    it("task_interrupt_injections are deleted when parent task is deleted", () => {
      applyBaseSchema(db);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("INSERT INTO tasks (id, title) VALUES ('t1', 'Parent')");
      db.exec(
        "INSERT INTO task_interrupt_injections (task_id, session_id, prompt_text, prompt_hash) VALUES ('t1', 'sess1', 'text', 'hash')",
      );
      db.exec("DELETE FROM tasks WHERE id = 't1'");
      const row = db.prepare("SELECT COUNT(*) as cnt FROM task_interrupt_injections WHERE task_id = 't1'").get() as {
        cnt: number;
      };
      expect(row.cnt).toBe(0);
    });
  });

  describe("default values", () => {
    it("agents default status to idle", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      db.exec(
        "INSERT INTO agents (id, name, department_id, role, avatar_emoji) VALUES ('a1', 'Test', 'd1', 'senior', '🤖')",
      );
      const row = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string };
      expect(row.status).toBe("idle");
    });

    it("workflow_packs default enabled to 1", () => {
      applyBaseSchema(db);
      db.exec(
        "INSERT INTO workflow_packs (key, name, input_schema_json, prompt_preset_json, qa_rules_json, output_template_json, routing_keywords_json, cost_profile_json) VALUES ('pk1', 'Test', '{}', '{}', '{}', '{}', '{}', '{}')",
      );
      const row = db.prepare("SELECT enabled FROM workflow_packs WHERE key = 'pk1'").get() as { enabled: number };
      expect(row.enabled).toBe(1);
    });

    it("agents default workflow_pack_key to development", () => {
      applyBaseSchema(db);
      db.exec("INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('d1', 'Dev', '개발', '💻', '#00f')");
      db.exec(
        "INSERT INTO agents (id, name, department_id, role, avatar_emoji) VALUES ('a1', 'Test', 'd1', 'senior', '🤖')",
      );
      const row = db.prepare("SELECT workflow_pack_key FROM agents WHERE id = 'a1'").get() as {
        workflow_pack_key: string;
      };
      expect(row.workflow_pack_key).toBe("development");
    });
  });
});
