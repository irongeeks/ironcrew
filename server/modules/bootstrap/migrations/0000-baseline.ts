// server/modules/bootstrap/migrations/0000-baseline.ts
//
// Baseline migration — idempotent coverage of all pre-versioned schema changes.
// Covers: task-schema-migrations.ts, observability-schema-migrations.ts, token-usage-schema.ts
//
// Every operation uses PRAGMA guards instead of try-catch.
// Complex table rebuilds (CHECK constraint widening, FK repair) use transactional
// rename-create-copy-drop patterns with proper rollback.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { hasColumn, hasTable, hasIndex, getTableDdl } from "./migration-types.ts";
import { DEFAULT_WORKFLOW_PACK_KEY, WORKFLOW_PACK_KEYS, isWorkflowPackKey } from "../../workflow/packs/definitions.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

export const migration: Migration = {
  version: 0,
  description: "Baseline — all pre-versioned schema changes",
  up(db: DatabaseSync): void {
    applyColumnMigrations(db);
    applyTableMigrations(db);
    applyIndexMigrations(db);
    applyCheckConstraintMigrations(db);
    applyObservabilityMigrations(db);
    applyTokenUsageMigration(db);
    applyDataMigrations(db);

    // Ensure FK enforcement is ON after all migrations
    db.exec("PRAGMA foreign_keys = ON");
  },
};

// ── Column additions (PRAGMA-guarded) ──────────────────────────────────────

function applyColumnMigrations(db: DatabaseSync): void {
  // subtasks
  if (!hasColumn(db, "subtasks", "target_department_id")) {
    db.exec("ALTER TABLE subtasks ADD COLUMN target_department_id TEXT");
  }
  if (!hasColumn(db, "subtasks", "delegated_task_id")) {
    db.exec("ALTER TABLE subtasks ADD COLUMN delegated_task_id TEXT");
  }

  // tasks
  if (!hasColumn(db, "tasks", "source_task_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN source_task_id TEXT");
  }
  if (!hasColumn(db, "tasks", "project_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  }
  if (!hasColumn(db, "tasks", "hidden")) {
    db.exec("ALTER TABLE tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "tasks", "workflow_pack_key")) {
    db.exec("ALTER TABLE tasks ADD COLUMN workflow_pack_key TEXT NOT NULL DEFAULT 'development'");
  }
  if (!hasColumn(db, "tasks", "workflow_meta_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN workflow_meta_json TEXT");
  }
  if (!hasColumn(db, "tasks", "output_format")) {
    db.exec("ALTER TABLE tasks ADD COLUMN output_format TEXT");
  }
  if (!hasColumn(db, "tasks", "agent_routing")) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_routing TEXT");
  }

  // task_creation_audits
  if (!hasColumn(db, "task_creation_audits", "completed")) {
    db.exec("ALTER TABLE task_creation_audits ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  }

  // task_logs
  if (!hasColumn(db, "task_logs", "span_id")) {
    db.exec("ALTER TABLE task_logs ADD COLUMN span_id TEXT");
  }

  // agents
  if (!hasColumn(db, "agents", "cli_profile")) {
    db.exec("ALTER TABLE agents ADD COLUMN cli_profile TEXT");
  }
  if (!hasColumn(db, "agents", "workflow_pack_key")) {
    db.exec("ALTER TABLE agents ADD COLUMN workflow_pack_key TEXT NOT NULL DEFAULT 'development'");
  }
  if (!hasColumn(db, "agents", "fallback_cli_provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN fallback_cli_provider TEXT");
  }

  // projects
  if (!hasColumn(db, "projects", "assignment_mode")) {
    db.exec("ALTER TABLE projects ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto'");
  }
  if (!hasColumn(db, "projects", "default_pack_key")) {
    db.exec("ALTER TABLE projects ADD COLUMN default_pack_key TEXT NOT NULL DEFAULT 'development'");
  }
  if (!hasColumn(db, "projects", "remote_server_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN remote_server_id TEXT DEFAULT NULL");
  }
  if (!hasColumn(db, "projects", "remote_path")) {
    db.exec("ALTER TABLE projects ADD COLUMN remote_path TEXT DEFAULT NULL");
  }

  // messages
  if (!hasColumn(db, "messages", "idempotency_key")) {
    db.exec("ALTER TABLE messages ADD COLUMN idempotency_key TEXT");
  }

  // servers
  if (hasTable(db, "servers")) {
    if (!hasColumn(db, "servers", "metadata_json")) {
      db.exec("ALTER TABLE servers ADD COLUMN metadata_json TEXT");
    }
    if (!hasColumn(db, "servers", "last_health_check_at")) {
      db.exec("ALTER TABLE servers ADD COLUMN last_health_check_at INTEGER");
    }
    if (!hasColumn(db, "servers", "last_health_error")) {
      db.exec("ALTER TABLE servers ADD COLUMN last_health_error TEXT");
    }
    if (!hasColumn(db, "servers", "ssh_config_json")) {
      db.exec("ALTER TABLE servers ADD COLUMN ssh_config_json TEXT DEFAULT NULL");
    }
  }

  // server_allocations
  if (hasTable(db, "server_allocations")) {
    if (!hasColumn(db, "server_allocations", "queue_reason")) {
      db.exec("ALTER TABLE server_allocations ADD COLUMN queue_reason TEXT");
    }
    if (!hasColumn(db, "server_allocations", "released_reason")) {
      db.exec("ALTER TABLE server_allocations ADD COLUMN released_reason TEXT");
    }
  }
}

// ── Table creation (IF NOT EXISTS guarded) ─────────────────────────────────

function applyTableMigrations(db: DatabaseSync): void {
  if (!hasTable(db, "comfyui_workflows")) {
    db.exec(`
      CREATE TABLE comfyui_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workflow_type TEXT NOT NULL CHECK(workflow_type IN ('text2img', 'img2video', 'text2speech', 'custom')),
        workflow_json TEXT NOT NULL,
        parameter_mappings_json TEXT NOT NULL,
        default_server_id TEXT REFERENCES servers(id),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        updated_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
  }

  if (!hasTable(db, "task_interrupt_injections")) {
    db.exec(`
      CREATE TABLE task_interrupt_injections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        actor_token_hash TEXT,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        consumed_at INTEGER
      )
    `);
  }

  if (!hasTable(db, "project_agents")) {
    db.exec(`
      CREATE TABLE project_agents (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        PRIMARY KEY (project_id, agent_id)
      )
    `);
  }

  if (!hasTable(db, "office_pack_departments")) {
    db.exec(`
      CREATE TABLE office_pack_departments (
        workflow_pack_key TEXT NOT NULL,
        department_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_ko TEXT NOT NULL,
        name_ja TEXT NOT NULL DEFAULT '',
        name_zh TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        description TEXT,
        prompt TEXT,
        sort_order INTEGER NOT NULL DEFAULT 99,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        PRIMARY KEY (workflow_pack_key, department_id)
      )
    `);
  }

  if (!hasTable(db, "servers")) {
    db.exec(`
      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        endpoint_url TEXT,
        auth_config_json TEXT,
        ssh_config_json TEXT,
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
        current_jobs INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','idle')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        department_id TEXT REFERENCES departments(id),
        metadata_json TEXT,
        last_health_check_at INTEGER,
        last_health_error TEXT,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        updated_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
  }

  if (!hasTable(db, "server_allocations")) {
    db.exec(`
      CREATE TABLE server_allocations (
        id TEXT PRIMARY KEY,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        requested_server_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','active','released')),
        queue_reason TEXT,
        released_reason TEXT,
        requested_at INTEGER NOT NULL,
        started_at INTEGER,
        released_at INTEGER
      )
    `);
  }

  if (!hasTable(db, "agent_server_access")) {
    db.exec(`
      CREATE TABLE agent_server_access (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        PRIMARY KEY (agent_id, server_id)
      )
    `);
  }
}

// ── Index creation (IF NOT EXISTS guarded) ─────────────────────────────────

function applyIndexMigrations(db: DatabaseSync): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_creation_audits_completed ON task_creation_audits(completed, created_at DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_interrupt_injections_task ON task_interrupt_injections(task_id, session_id, consumed_at, created_at DESC)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_pack ON tasks(workflow_pack_key, updated_at DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_agents_workflow_pack ON agents(workflow_pack_key, department_id, role, created_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_office_pack_departments_pack_sort ON office_pack_departments(workflow_pack_key, sort_order)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_servers_type_status ON servers(type, status, enabled, updated_at DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_server_allocations_server ON server_allocations(server_id, status, requested_at ASC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_server_allocations_task ON server_allocations(task_id, status, requested_at ASC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_server_allocations_queue ON server_allocations(requested_server_type, status, requested_at ASC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_agent_server_access_server ON agent_server_access(server_id, created_at DESC)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_type, receiver_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meeting_minutes_task ON meeting_minutes(task_id, started_at DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_meeting_minute_entries_meeting ON meeting_minute_entries(meeting_id, seq ASC)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_department ON agents(department_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(department_id)");
}

// ── CHECK constraint migrations (table rebuild) ───────────────────────────

function applyCheckConstraintMigrations(db: DatabaseSync): void {
  // messages: add 'directive' to message_type CHECK
  migrateMessagesDirectiveType(db);
  // tasks: widen status + task_type CHECK constraints
  migrateLegacyTasksStatusSchema(db);
  // subtasks: add 'awaiting_approval' and 'skipped' to status CHECK
  migrateSubtaskStatusCheck(db);
  // agents: add 'browser' and 'openclaw' to cli_provider CHECK
  migrateAgentsCliProviderCheck(db);
  // comfyui_workflows: add 'text2speech' to workflow_type CHECK
  migrateComfyuiWorkflowTypeCheck(db);
  // servers: remove CHECK on type column (support ssh_remote)
  migrateServersTypeCheck(db);
  // server_allocations: remove CHECK on requested_server_type (support ssh_remote)
  migrateServerAllocationsTypeCheck(db);
  // Repair FK refs broken by agents table rename
  repairBrokenAgentsFkRefs(db);
  // Repair FK refs from legacy status migration
  repairLegacyTaskForeignKeys(db);
  // Messages idempotency: unique index + duplicate cleanup
  ensureMessagesIdempotency(db);
}

// ── Observability tables (from observability-schema-migrations.ts) ─────────

function applyObservabilityMigrations(db: DatabaseSync): void {
  if (!hasTable(db, "logs")) {
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level INTEGER NOT NULL,
        module TEXT,
        message TEXT NOT NULL,
        data TEXT,
        logged_at INTEGER NOT NULL,
        exported_at INTEGER
      )
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(logged_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_module_level ON logs(module, level)");
  // Partial index — may not be supported on all SQLite builds
  if (!hasIndex(db, "idx_logs_unexported")) {
    try {
      db.exec("CREATE INDEX idx_logs_unexported ON logs(exported_at) WHERE exported_at IS NULL");
    } catch {
      // partial index not supported on this SQLite build — skip
      log.debug("partial index idx_logs_unexported not supported, skipping");
    }
  }

  if (!hasTable(db, "workflow_spans")) {
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
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_spans_trace ON workflow_spans(trace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_spans_task ON workflow_spans(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_spans_parent ON workflow_spans(parent_span_id)");
  if (!hasIndex(db, "idx_spans_unexported")) {
    try {
      db.exec("CREATE INDEX idx_spans_unexported ON workflow_spans(exported_at) WHERE exported_at IS NULL");
    } catch {
      log.debug("partial index idx_spans_unexported not supported, skipping");
    }
  }

  if (!hasTable(db, "metrics")) {
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
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON metrics(name, recorded_at)");
  if (!hasIndex(db, "idx_metrics_unexported")) {
    try {
      db.exec("CREATE INDEX idx_metrics_unexported ON metrics(exported_at) WHERE exported_at IS NULL");
    } catch {
      log.debug("partial index idx_metrics_unexported not supported, skipping");
    }
  }

  if (!hasTable(db, "metrics_hourly")) {
    db.exec(`
      CREATE TABLE metrics_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        labels TEXT,
        hour INTEGER NOT NULL,
        count INTEGER NOT NULL,
        sum REAL,
        min REAL,
        max REAL,
        avg REAL
      )
    `);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_hourly_key ON metrics_hourly(name, labels, hour)");
}

// ── Token usage table (from token-usage-schema.ts) ─────────────────────────

function applyTokenUsageMigration(db: DatabaseSync): void {
  if (!hasTable(db, "token_usage")) {
    db.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        subtask_id TEXT REFERENCES subtasks(id),
        agent_id TEXT REFERENCES agents(id),
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        recorded_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id)");
}

// ── Data migrations ────────────────────────────────────────────────────────

function applyDataMigrations(db: DatabaseSync): void {
  // Backfill workflow_pack_key for agents based on id prefix
  for (const packKey of WORKFLOW_PACK_KEYS) {
    if (packKey === DEFAULT_WORKFLOW_PACK_KEY) continue;
    db.prepare(
      `UPDATE agents SET workflow_pack_key = ?
       WHERE (workflow_pack_key IS NULL OR workflow_pack_key = '' OR workflow_pack_key = ?)
         AND id LIKE ?`,
    ).run(packKey, DEFAULT_WORKFLOW_PACK_KEY, `${packKey}-%`);
  }

  // Backfill from officePackProfiles setting
  backfillFromOfficePackProfiles(db);

  // Clean empty idempotency keys
  db.prepare(
    "UPDATE messages SET idempotency_key = NULL WHERE idempotency_key IS NOT NULL AND TRIM(idempotency_key) = ''",
  ).run();

  // Sage: Planning Lead should use Claude
  db.prepare(
    "UPDATE agents SET cli_provider = 'claude' WHERE name = 'Sage' AND department_id = 'planning' AND cli_provider = 'codex'",
  ).run();

  // Browser agents: set default fallback
  db.prepare(
    "UPDATE agents SET fallback_cli_provider = 'claude' WHERE cli_provider = 'browser' AND (fallback_cli_provider IS NULL OR fallback_cli_provider = '')",
  ).run();
}

// ── Complex helper functions (ported from task-schema-migrations.ts) ──────
// These use the same transactional rename-create-copy-drop pattern as the
// originals but with PRAGMA guards at the entry point to skip if already done.

function migrateMessagesDirectiveType(db: DatabaseSync): void {
  const ddl = getTableDdl(db, "messages");
  if (ddl.includes("'directive'")) return;

  log.info("baseline: migrating messages.message_type CHECK to include 'directive'");
  const oldTable = "messages_directive_migration_old";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE messages RENAME TO ${oldTable}`);
      const oldCols = db.prepare(`PRAGMA table_info(${oldTable})`).all() as Array<{ name: string }>;
      const hasIdempotencyKey = oldCols.some((c) => c.name === "idempotency_key");
      const idempotencyExpr = hasIdempotencyKey ? "idempotency_key" : "NULL";
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          sender_type TEXT NOT NULL CHECK(sender_type IN ('ceo','agent','system')),
          sender_id TEXT,
          receiver_type TEXT NOT NULL CHECK(receiver_type IN ('agent','department','all')),
          receiver_id TEXT,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat','task_assign','announcement','directive','report','status_update')),
          task_id TEXT REFERENCES tasks(id),
          idempotency_key TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        )
      `);
      db.exec(`
        INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at)
        SELECT id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, ${idempotencyExpr}, created_at
        FROM ${oldTable}
      `);
      db.exec(`DROP TABLE ${oldTable}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      try {
        db.exec(`ALTER TABLE ${oldTable} RENAME TO messages`);
      } catch {
        /* */
      }
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_type, receiver_id, created_at DESC)");
}

function migrateLegacyTasksStatusSchema(db: DatabaseSync): void {
  const ddl = getTableDdl(db, "tasks");
  const hasNewStatus = ddl.includes("'collaborating'") && ddl.includes("'pending'");
  const hasDesignTypes = ddl.includes("'create_mockup'") && ddl.includes("'design_system_update'");
  const hasBrowserTypes = ddl.includes("'website_audit'") && ddl.includes("'e2e_test'");
  if (hasNewStatus && hasDesignTypes && hasBrowserTypes) return;

  log.info("baseline: migrating tasks CHECK constraints");
  const newTable = "tasks_status_migration_new";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`DROP TABLE IF EXISTS ${newTable}`);
      db.exec(`
        CREATE TABLE ${newTable} (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          department_id TEXT REFERENCES departments(id),
          assigned_agent_id TEXT REFERENCES agents(id),
          project_id TEXT REFERENCES projects(id),
          status TEXT NOT NULL DEFAULT 'inbox'
            CHECK(status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending')),
          priority INTEGER DEFAULT 0,
          task_type TEXT DEFAULT 'general'
            CHECK(task_type IN ('general','development','design','analysis','presentation','documentation',
              'website_audit','e2e_test','screenshot_comparison','data_extraction',
              'create_mockup','design_system_update','color_palette_generate','typography_review')),
          workflow_pack_key TEXT NOT NULL DEFAULT 'development',
          workflow_meta_json TEXT, output_format TEXT, agent_routing TEXT, project_path TEXT, result TEXT,
          started_at INTEGER, completed_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()*1000),
          updated_at INTEGER DEFAULT (unixepoch()*1000),
          source_task_id TEXT
        )
      `);
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const col = (name: string, fallback: string) => (cols.some((c) => c.name === name) ? name : fallback);
      db.exec(`
        INSERT INTO ${newTable} (id, title, description, department_id, assigned_agent_id, project_id,
          status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format, agent_routing,
          project_path, result, started_at, completed_at, created_at, updated_at, source_task_id)
        SELECT id, title, description, department_id, assigned_agent_id,
          ${col("project_id", "NULL")},
          CASE WHEN status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending') THEN status ELSE 'inbox' END,
          priority, task_type,
          ${col("workflow_pack_key", "'development'")},
          ${col("workflow_meta_json", "NULL")},
          ${col("output_format", "NULL")},
          ${col("agent_routing", "NULL")},
          project_path, result, started_at, completed_at, created_at, updated_at,
          ${col("source_task_id", "NULL")}
        FROM tasks
      `);
      db.exec("DROP TABLE tasks");
      db.exec(`ALTER TABLE ${newTable} RENAME TO tasks`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateSubtaskStatusCheck(db: DatabaseSync): void {
  const ddl = getTableDdl(db, "subtasks");
  if (ddl.includes("awaiting_approval") && ddl.includes("skipped")) return;

  log.info("baseline: migrating subtasks.status CHECK");
  const oldTable = "subtasks_status_migration_old";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE subtasks RENAME TO ${oldTable}`);
      const oldCols = db.prepare(`PRAGMA table_info(${oldTable})`).all() as Array<{ name: string }>;
      const hasTargetDept = oldCols.some((c) => c.name === "target_department_id");
      const hasDelegated = oldCols.some((c) => c.name === "delegated_task_id");
      db.exec(`
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','in_progress','done','blocked','awaiting_approval','skipped')),
          assigned_agent_id TEXT REFERENCES agents(id), blocked_reason TEXT, cli_tool_use_id TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000), completed_at INTEGER,
          target_department_id TEXT, delegated_task_id TEXT
        )
      `);
      const insertCols = [
        "id",
        "task_id",
        "title",
        "description",
        "status",
        "assigned_agent_id",
        "blocked_reason",
        "cli_tool_use_id",
        "created_at",
        "completed_at",
        hasTargetDept ? "target_department_id" : null,
        hasDelegated ? "delegated_task_id" : null,
      ]
        .filter(Boolean)
        .join(", ");
      db.exec(`INSERT INTO subtasks (${insertCols}) SELECT ${insertCols} FROM ${oldTable}`);
      db.exec(`DROP TABLE ${oldTable}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      try {
        db.exec(`ALTER TABLE ${oldTable} RENAME TO subtasks`);
      } catch {
        /* */
      }
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateAgentsCliProviderCheck(db: DatabaseSync): void {
  const ddl = getTableDdl(db, "agents");
  if (ddl.includes("'openclaw'")) return;

  log.info("baseline: migrating agents.cli_provider CHECK");
  const oldTable = "agents_cliprovider_migration_old";
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE agents RENAME TO ${oldTable}`);
      const oldCols = db.prepare(`PRAGMA table_info(${oldTable})`).all() as Array<{ name: string }>;
      const hasWpk = oldCols.some((c) => c.name === "workflow_pack_key");
      const hasFallback = oldCols.some((c) => c.name === "fallback_cli_provider");
      const hasProfile = oldCols.some((c) => c.name === "cli_profile");
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ko TEXT NOT NULL DEFAULT '', name_ja TEXT NOT NULL DEFAULT '', name_zh TEXT NOT NULL DEFAULT '',
          department_id TEXT REFERENCES departments(id), workflow_pack_key TEXT NOT NULL DEFAULT 'development',
          role TEXT NOT NULL CHECK(role IN ('team_leader','senior','junior','intern')),
          acts_as_planning_leader INTEGER NOT NULL DEFAULT 0 CHECK(acts_as_planning_leader IN (0,1)),
          cli_provider TEXT CHECK(cli_provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api','browser','openclaw')),
          cli_profile TEXT, oauth_account_id TEXT, api_provider_id TEXT, api_model TEXT, cli_model TEXT, cli_reasoning_level TEXT,
          avatar_emoji TEXT NOT NULL DEFAULT '🤖', sprite_number INTEGER, personality TEXT,
          status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','working','break','offline')),
          current_task_id TEXT, stats_tasks_done INTEGER DEFAULT 0, stats_xp INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()*1000), fallback_cli_provider TEXT
        )
      `);
      const baseCols = [
        "id",
        "name",
        "name_ko",
        "name_ja",
        "name_zh",
        "department_id",
        "role",
        "acts_as_planning_leader",
        "cli_provider",
        "oauth_account_id",
        "api_provider_id",
        "api_model",
        "cli_model",
        "cli_reasoning_level",
        "avatar_emoji",
        "sprite_number",
        "personality",
        "status",
        "current_task_id",
        "stats_tasks_done",
        "stats_xp",
        "created_at",
      ];
      const destCols = [...baseCols];
      const srcCols = [...baseCols];
      if (hasWpk) {
        destCols.push("workflow_pack_key");
        srcCols.push("workflow_pack_key");
      }
      if (hasFallback) {
        destCols.push("fallback_cli_provider");
        srcCols.push("fallback_cli_provider");
      }
      if (hasProfile) {
        destCols.push("cli_profile");
        srcCols.push("cli_profile");
      }
      db.exec(`INSERT INTO agents (${destCols.join(", ")}) SELECT ${srcCols.join(", ")} FROM ${oldTable}`);
      db.exec(`DROP TABLE ${oldTable}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      try {
        db.exec(`ALTER TABLE ${oldTable} RENAME TO agents`);
      } catch {
        /* */
      }
      throw e;
    }
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateComfyuiWorkflowTypeCheck(db: DatabaseSync): void {
  const ddl = getTableDdl(db, "comfyui_workflows");
  if (!ddl || ddl.includes("'text2speech'")) return;

  log.info("baseline: migrating comfyui_workflows.workflow_type CHECK");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE comfyui_workflows RENAME TO comfyui_workflows_migration_old");
      db.exec(`
        CREATE TABLE comfyui_workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          workflow_type TEXT NOT NULL CHECK(workflow_type IN ('text2img', 'img2video', 'text2speech', 'custom')),
          workflow_json TEXT NOT NULL, parameter_mappings_json TEXT NOT NULL,
          default_server_id TEXT REFERENCES servers(id), enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER DEFAULT (unixepoch()*1000), updated_at INTEGER DEFAULT (unixepoch()*1000)
        )
      `);
      db.exec(`INSERT INTO comfyui_workflows SELECT * FROM comfyui_workflows_migration_old`);
      db.exec("DROP TABLE comfyui_workflows_migration_old");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateServersTypeCheck(db: DatabaseSync): void {
  if (!hasTable(db, "servers")) return;
  const ddl = getTableDdl(db, "servers");
  // Already migrated if no CHECK on type column or already has ssh_config_json in correct position
  if (!ddl.includes("'file_storage')") || (ddl.includes("ssh_config_json") && !ddl.includes("'file_storage')"))) return;

  log.info("baseline: migrating servers type CHECK to support ssh_remote");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE servers_new (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, endpoint_url TEXT,
          auth_config_json TEXT, ssh_config_json TEXT, max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
          current_jobs INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','idle')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          department_id TEXT REFERENCES departments(id), metadata_json TEXT,
          last_health_check_at INTEGER, last_health_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000), updated_at INTEGER DEFAULT (unixepoch()*1000)
        )
      `);
      db.exec(
        "INSERT INTO servers_new SELECT id, name, type, endpoint_url, auth_config_json, NULL, max_concurrent_jobs, current_jobs, status, enabled, department_id, metadata_json, last_health_check_at, last_health_error, created_at, updated_at FROM servers",
      );
      db.exec("DROP TABLE servers");
      db.exec("ALTER TABLE servers_new RENAME TO servers");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateServerAllocationsTypeCheck(db: DatabaseSync): void {
  if (!hasTable(db, "server_allocations")) return;
  const ddl = getTableDdl(db, "server_allocations");
  if (!ddl.includes("'file_storage')")) return;

  log.info("baseline: migrating server_allocations requested_server_type CHECK");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE server_allocations_new (
          id TEXT PRIMARY KEY, server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          requested_server_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','active','released')),
          queue_reason TEXT, released_reason TEXT, requested_at INTEGER NOT NULL,
          started_at INTEGER, released_at INTEGER
        )
      `);
      db.exec("INSERT INTO server_allocations_new SELECT * FROM server_allocations");
      db.exec("DROP TABLE server_allocations");
      db.exec("ALTER TABLE server_allocations_new RENAME TO server_allocations");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function repairBrokenAgentsFkRefs(db: DatabaseSync): void {
  const broken = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND sql LIKE '%agents_cliprovider_migration_old%'",
    )
    .get() as { cnt: number };
  if (!broken || broken.cnt === 0) return;

  log.info({ count: broken.cnt }, "baseline: repairing broken FK refs");
  db.exec("PRAGMA writable_schema = ON");
  try {
    db.exec(`
      UPDATE sqlite_master
      SET sql = REPLACE(sql, '"agents_cliprovider_migration_old"', 'agents')
      WHERE type = 'table' AND sql LIKE '%agents_cliprovider_migration_old%'
    `);
  } finally {
    db.exec("PRAGMA writable_schema = OFF");
  }
}

function repairLegacyTaskForeignKeys(db: DatabaseSync): void {
  const refCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND sql LIKE '%tasks_legacy_status_migration%'",
      )
      .get() as { cnt: number }
  ).cnt;
  if (refCount === 0) return;

  log.info("baseline: repairing legacy task FK references");
  // This migration rebuilds messages, task_logs, subtasks, meeting_minutes, meeting_minute_entries
  // to fix FK refs that point at the temp migration table name.
  // Same transactional pattern as the original.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      // Rebuild each table with correct FK refs
      rebuildMessagesForFkRepair(db);
      rebuildTaskLogsForFkRepair(db);
      rebuildSubtasksForFkRepair(db);
      rebuildMeetingMinutesForFkRepair(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildMessagesForFkRepair(db: DatabaseSync): void {
  const old = "messages_fkfix_old";
  db.exec(`ALTER TABLE messages RENAME TO ${old}`);
  const cols = db.prepare(`PRAGMA table_info(${old})`).all() as Array<{ name: string }>;
  const hasIk = cols.some((c) => c.name === "idempotency_key");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, sender_type TEXT NOT NULL CHECK(sender_type IN ('ceo','agent','system')),
      sender_id TEXT, receiver_type TEXT NOT NULL CHECK(receiver_type IN ('agent','department','all')),
      receiver_id TEXT, content TEXT NOT NULL,
      message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat','task_assign','announcement','directive','report','status_update')),
      task_id TEXT REFERENCES tasks(id), idempotency_key TEXT, created_at INTEGER DEFAULT (unixepoch()*1000)
    )
  `);
  db.exec(
    `INSERT INTO messages SELECT id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, ${hasIk ? "idempotency_key" : "NULL"}, created_at FROM ${old}`,
  );
  db.exec(`DROP TABLE ${old}`);
}

function rebuildTaskLogsForFkRepair(db: DatabaseSync): void {
  const old = "task_logs_fkfix_old";
  db.exec(`ALTER TABLE task_logs RENAME TO ${old}`);
  const cols = db.prepare(`PRAGMA table_info(${old})`).all() as Array<{ name: string }>;
  const hasSpanId = cols.some((c) => c.name === "span_id");
  db.exec(`
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
      kind TEXT NOT NULL, message TEXT NOT NULL, span_id TEXT, created_at INTEGER DEFAULT (unixepoch()*1000)
    )
  `);
  db.exec(
    `INSERT INTO task_logs (id, task_id, kind, message, span_id, created_at) SELECT id, task_id, kind, message, ${hasSpanId ? "span_id" : "NULL"}, created_at FROM ${old}`,
  );
  db.exec(`DROP TABLE ${old}`);
}

function rebuildSubtasksForFkRepair(db: DatabaseSync): void {
  const old = "subtasks_fkfix_old";
  db.exec(`ALTER TABLE subtasks RENAME TO ${old}`);
  db.exec(`
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked','awaiting_approval','skipped')),
      assigned_agent_id TEXT REFERENCES agents(id), blocked_reason TEXT, cli_tool_use_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()*1000), completed_at INTEGER,
      target_department_id TEXT, delegated_task_id TEXT
    )
  `);
  const cols = db.prepare(`PRAGMA table_info(${old})`).all() as Array<{ name: string }>;
  const hasTd = cols.some((c) => c.name === "target_department_id");
  const hasDt = cols.some((c) => c.name === "delegated_task_id");
  db.exec(
    `INSERT INTO subtasks SELECT id, task_id, title, description, status, assigned_agent_id, blocked_reason, cli_tool_use_id, created_at, completed_at, ${hasTd ? "target_department_id" : "NULL"}, ${hasDt ? "delegated_task_id" : "NULL"} FROM ${old}`,
  );
  db.exec(`DROP TABLE ${old}`);
}

function rebuildMeetingMinutesForFkRepair(db: DatabaseSync): void {
  const entriesOld = "meeting_minute_entries_fkfix_old";
  const minutesOld = "meeting_minutes_fkfix_old";
  db.exec(`ALTER TABLE meeting_minute_entries RENAME TO ${entriesOld}`);
  db.exec(`ALTER TABLE meeting_minutes RENAME TO ${minutesOld}`);
  db.exec(`
    CREATE TABLE meeting_minutes (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      meeting_type TEXT NOT NULL CHECK(meeting_type IN ('planned','review')),
      round INTEGER NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','revision_requested','failed')),
      started_at INTEGER NOT NULL, completed_at INTEGER, created_at INTEGER DEFAULT (unixepoch()*1000)
    )
  `);
  db.exec(`INSERT INTO meeting_minutes SELECT * FROM ${minutesOld}`);
  db.exec(`
    CREATE TABLE meeting_minute_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meeting_minutes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, speaker_agent_id TEXT REFERENCES agents(id), speaker_name TEXT NOT NULL,
      department_name TEXT, role_label TEXT, message_type TEXT NOT NULL DEFAULT 'chat',
      content TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()*1000)
    )
  `);
  db.exec(`INSERT INTO meeting_minute_entries SELECT * FROM ${entriesOld}`);
  db.exec(`DROP TABLE ${entriesOld}`);
  db.exec(`DROP TABLE ${minutesOld}`);
}

function ensureMessagesIdempotency(db: DatabaseSync): void {
  // Clean duplicates before creating unique index
  const duplicateKeys = db
    .prepare(
      "SELECT idempotency_key FROM messages WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*) > 1",
    )
    .all() as Array<{ idempotency_key: string }>;

  for (const row of duplicateKeys) {
    const keep = db
      .prepare("SELECT id FROM messages WHERE idempotency_key = ? ORDER BY created_at ASC, id ASC LIMIT 1")
      .get(row.idempotency_key) as { id: string } | undefined;
    if (!keep) continue;
    db.prepare("UPDATE messages SET idempotency_key = NULL WHERE idempotency_key = ? AND id != ?").run(
      row.idempotency_key,
      keep.id,
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_key
    ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL
  `);
}

function backfillFromOfficePackProfiles(db: DatabaseSync): void {
  const profileRow = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  if (!profileRow) return;

  let parsedRoot: unknown = profileRow.value;
  if (typeof parsedRoot === "string") {
    try {
      parsedRoot = JSON.parse(parsedRoot);
    } catch {
      return;
    }
  }
  if (!parsedRoot || typeof parsedRoot !== "object" || Array.isArray(parsedRoot)) return;
  const root = parsedRoot as Record<string, unknown>;

  const upsertDept = db.prepare(`
    INSERT INTO office_pack_departments (workflow_pack_key, department_id, name, name_ko, name_ja, name_zh, icon, color, description, prompt, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_pack_key, department_id) DO UPDATE SET
      name=excluded.name, name_ko=excluded.name_ko, name_ja=excluded.name_ja, name_zh=excluded.name_zh,
      icon=excluded.icon, color=excluded.color, description=excluded.description, prompt=excluded.prompt, sort_order=excluded.sort_order
  `);
  const updateAgent = db.prepare("UPDATE agents SET workflow_pack_key = ? WHERE id = ?");
  const now = Date.now();

  for (const [rawPackKey, rawProfile] of Object.entries(root)) {
    const packKey = rawPackKey.trim();
    if (!isWorkflowPackKey(packKey) || packKey === DEFAULT_WORKFLOW_PACK_KEY) continue;
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) continue;
    const profile = rawProfile as Record<string, unknown>;

    if (Array.isArray(profile.departments)) {
      for (const rawDept of profile.departments) {
        if (!rawDept || typeof rawDept !== "object" || Array.isArray(rawDept)) continue;
        const dept = rawDept as Record<string, unknown>;
        const id = typeof dept.id === "string" ? dept.id.trim() : "";
        if (!id) continue;
        const name = (typeof dept.name === "string" ? dept.name.trim() : "") || id;
        const nameKo = (typeof dept.name_ko === "string" ? dept.name_ko.trim() : "") || name;
        const sortRaw = Number(dept.sort_order);
        const sort = Number.isFinite(sortRaw) ? Math.max(0, Math.trunc(sortRaw)) : 99;
        const catRaw = Number(dept.created_at);
        const cat = Number.isFinite(catRaw) ? Math.max(0, Math.trunc(catRaw)) : now;
        upsertDept.run(
          packKey,
          id,
          name,
          nameKo,
          typeof dept.name_ja === "string" ? dept.name_ja.trim() : "",
          typeof dept.name_zh === "string" ? dept.name_zh.trim() : "",
          (typeof dept.icon === "string" ? dept.icon.trim() : "") || "🏢",
          (typeof dept.color === "string" ? dept.color.trim() : "") || "#64748b",
          typeof dept.description === "string" ? dept.description.trim() || null : null,
          typeof dept.prompt === "string" ? dept.prompt.trim() || null : null,
          sort,
          cat,
        );
      }
    }
    if (Array.isArray(profile.agents)) {
      for (const rawAgent of profile.agents) {
        if (!rawAgent || typeof rawAgent !== "object" || Array.isArray(rawAgent)) continue;
        const agent = rawAgent as Record<string, unknown>;
        const agentId = typeof agent.id === "string" ? agent.id.trim() : "";
        if (agentId) updateAgent.run(packKey, agentId);
      }
    }
  }
}
