// server/modules/bootstrap/migrations/0002-iron-crew-domain.ts
//
// IronCrew domain foundation.
//
// This is ADDITIVE. It introduces the governance-grade domain
// (companies, agents, tasks, runs, approvals, budgets, audit) alongside the
// existing IronCrew tables rather than rewriting them, so the 2500+ upstream
// tests keep passing while the new control plane is built out.
//
// Design decisions worth stating up front:
//
//  * Every business table carries `company_id` from day one, even though the
//    MVP runs a single company. Retrofitting a tenant key later means touching
//    every index and every query; adding it now is nearly free.
//
//  * Tasks carry an execution-lock triple (`execution_run_id`,
//    `execution_locked_at`, `lock_expires_at`) plus `status_version`. Claiming
//    is a compare-and-set UPDATE guarded on the observed status_version, so two
//    workers cannot both take the same task. See ../../../ironcrew/domain/task-store.ts.
//
//  * `audit_events` is hash-chained (`prev_hash` -> `entry_hash`) so tampering
//    is detectable, and has no UPDATE/DELETE path in the application layer.
//
//  * Timestamps are INTEGER epoch milliseconds throughout, matching the
//    upstream convention (`unixepoch()*1000`).

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  owner_name    TEXT NOT NULL DEFAULT 'CEO',
  locale        TEXT NOT NULL DEFAULT 'de-DE',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

-- ---------------------------------------------------------------------------
-- Org: departments, agents.
-- persona (skin) is deliberately stored apart from professional role and from
-- policy, so a cosmetic skin can never widen what an agent may do.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_departments (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);

CREATE TABLE IF NOT EXISTS crew_agents (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  department_id      TEXT REFERENCES crew_departments(id) ON DELETE SET NULL,
  key                TEXT NOT NULL,
  -- Layer 1: professional role (what this agent is competent for)
  professional_role  TEXT NOT NULL,
  role_summary       TEXT NOT NULL DEFAULT '',
  seniority          TEXT NOT NULL DEFAULT 'senior',
  -- Layer 2: policy (what it may do) — JSON, validated by Zod on read
  policy_json        TEXT NOT NULL DEFAULT '{}',
  -- Layer 3: persona skin (how it looks and sounds) — cosmetic only
  persona_json       TEXT NOT NULL DEFAULT '{}',
  display_name       TEXT NOT NULL,
  -- Runtime binding
  runtime_profile    TEXT NOT NULL DEFAULT 'balanced',
  runtime_provider   TEXT NOT NULL DEFAULT 'mock',
  status             TEXT NOT NULL DEFAULT 'offline'
                     CHECK (status IN ('offline','idle','thinking','working','in_meeting',
                                       'waiting_for_input','waiting_for_approval',
                                       'rate_limited','paused','error')),
  status_detail      TEXT NOT NULL DEFAULT '',
  is_executive_assistant INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_crew_agents_company ON crew_agents(company_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_agents_department ON crew_agents(company_id, department_id);

-- ---------------------------------------------------------------------------
-- Goals and projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_goals (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES crew_goals(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','achieved','abandoned','on_hold')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_goals_company ON crew_goals(company_id, status);

CREATE TABLE IF NOT EXISTS crew_projects (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  goal_id       TEXT REFERENCES crew_goals(id) ON DELETE SET NULL,
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('draft','active','on_hold','done','cancelled')),
  owner_agent_id TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  workspace_path TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_crew_projects_company ON crew_projects(company_id, status);

-- ---------------------------------------------------------------------------
-- Tasks. The heart of the system.
--
-- status_version is bumped on every state transition and is the CAS token used
-- by the atomic claim. The execution lock triple is only ever cleared while
-- naming the run that owns it, so a late reaper cannot clear a fresh owner's
-- lock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_tasks (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES crew_projects(id) ON DELETE CASCADE,
  parent_task_id    TEXT REFERENCES crew_tasks(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  status            TEXT NOT NULL DEFAULT 'inbox'
                    CHECK (status IN ('inbox','planned','ready','assigned','running','waiting',
                                      'blocked','review','approval_required','done',
                                      'failed','cancelled')),
  status_version    INTEGER NOT NULL DEFAULT 0,
  status_reason     TEXT NOT NULL DEFAULT '',
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),
  risk_level        TEXT NOT NULL DEFAULT 'low'
                    CHECK (risk_level IN ('low','medium','high','critical')),
  sensitive         INTEGER NOT NULL DEFAULT 0,
  assigned_agent_id TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  created_by        TEXT NOT NULL DEFAULT 'system',
  -- execution lock triple
  execution_run_id  TEXT,
  execution_locked_at INTEGER,
  lock_expires_at   INTEGER,
  -- results
  result_summary    TEXT,
  review_notes      TEXT,
  correlation_id    TEXT NOT NULL DEFAULT '',
  deadline_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  completed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_company_status ON crew_tasks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_project ON crew_tasks(company_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_agent ON crew_tasks(company_id, assigned_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_lock ON crew_tasks(status, lock_expires_at);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_parent ON crew_tasks(parent_task_id);

-- Blocker edges. UNIQUE prevents duplicate edges; a task may not block itself.
CREATE TABLE IF NOT EXISTS crew_task_dependencies (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES crew_tasks(id) ON DELETE CASCADE,
  depends_on_id   TEXT NOT NULL REFERENCES crew_tasks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, task_id, depends_on_id, kind),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_task_deps_task ON crew_task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_crew_task_deps_dep ON crew_task_dependencies(depends_on_id);

-- ---------------------------------------------------------------------------
-- Runs and normalised run events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_runs (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES crew_tasks(id) ON DELETE CASCADE,
  agent_id         TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  project_id       TEXT REFERENCES crew_projects(id) ON DELETE SET NULL,
  runtime_type     TEXT NOT NULL,
  model            TEXT,
  permission_mode  TEXT NOT NULL DEFAULT 'restricted',
  sandbox_grant_id TEXT,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','waiting','completed','failed',
                                     'cancelled','rate_limited')),
  correlation_id   TEXT NOT NULL DEFAULT '',
  session_ref      TEXT,
  worker_id        TEXT,
  heartbeat_at     INTEGER,
  error_message    TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micros      INTEGER NOT NULL DEFAULT 0,
  next_event_seq   INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_runs_task ON crew_runs(company_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crew_runs_status ON crew_runs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_runs_heartbeat ON crew_runs(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS crew_run_events (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL REFERENCES crew_runs(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL,
  project_id     TEXT,
  agent_id       TEXT,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  redacted       INTEGER NOT NULL DEFAULT 0,
  redaction_rules TEXT NOT NULL DEFAULT '[]',
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_crew_run_events_run ON crew_run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_crew_run_events_task ON crew_run_events(company_id, task_id, created_at);

-- ---------------------------------------------------------------------------
-- CEO <-> EA conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_conversations (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES crew_projects(id) ON DELETE SET NULL,
  task_id      TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'ceo_ea'
               CHECK (kind IN ('ceo_ea','ceo_agent','agent_agent','meeting')),
  title        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_conversations_company ON crew_conversations(company_id, kind);

CREATE TABLE IF NOT EXISTS crew_messages (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES crew_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('ceo','agent','system')),
  author_agent_id TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  task_id         TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  triage_json     TEXT,
  correlation_id  TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_messages_conversation ON crew_messages(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Governance: approvals, decisions, budgets, costs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_approvals (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES crew_tasks(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES crew_runs(id) ON DELETE SET NULL,
  requested_by    TEXT NOT NULL,
  approval_type   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'high'
                  CHECK (risk_level IN ('low','medium','high','critical')),
  impact          TEXT NOT NULL DEFAULT '',
  rollback_plan   TEXT NOT NULL DEFAULT '',
  proposed_action TEXT NOT NULL DEFAULT '',
  evidence_json   TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by      TEXT,
  decision_reason TEXT,
  decided_at      INTEGER,
  expires_at      INTEGER,
  correlation_id  TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_approvals_company ON crew_approvals(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_crew_approvals_task ON crew_approvals(task_id, status);

CREATE TABLE IF NOT EXISTS crew_decisions (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES crew_projects(id) ON DELETE SET NULL,
  task_id       TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  decision      TEXT NOT NULL,
  rationale     TEXT NOT NULL DEFAULT '',
  decided_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_decisions_company ON crew_decisions(company_id, created_at);

CREATE TABLE IF NOT EXISTS crew_budgets (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL
                 CHECK (scope_type IN ('company','agent','project','task','runtime','provider')),
  scope_id       TEXT NOT NULL DEFAULT '',
  window_kind    TEXT NOT NULL DEFAULT 'calendar_month_utc'
                 CHECK (window_kind IN ('calendar_month_utc','lifetime','day_utc')),
  limit_micros   INTEGER NOT NULL,
  warn_percent   INTEGER NOT NULL DEFAULT 80,
  hard_stop      INTEGER NOT NULL DEFAULT 1,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, scope_type, scope_id, window_kind)
);
CREATE INDEX IF NOT EXISTS idx_crew_budgets_company ON crew_budgets(company_id, active);

CREATE TABLE IF NOT EXISTS crew_cost_events (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES crew_runs(id) ON DELETE CASCADE,
  task_id       TEXT,
  project_id    TEXT,
  agent_id      TEXT,
  runtime_type  TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT,
  kind          TEXT NOT NULL DEFAULT 'usage'
                CHECK (kind IN ('usage','quota','adjustment')),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Subscription runtimes have no per-call price. cost_micros stays 0 and the
  -- consumption is recorded as a quota event instead, so dashboards do not
  -- invent monetary figures.
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  window_day    TEXT NOT NULL DEFAULT '',
  window_month  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_cost_company_month ON crew_cost_events(company_id, window_month);
CREATE INDEX IF NOT EXISTS idx_crew_cost_agent ON crew_cost_events(company_id, agent_id, window_month);
CREATE INDEX IF NOT EXISTS idx_crew_cost_project ON crew_cost_events(company_id, project_id, window_month);

-- ---------------------------------------------------------------------------
-- Sandbox grants (elevation of CLI permissions), always tied to an approval.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_sandbox_grants (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  approval_id    TEXT NOT NULL REFERENCES crew_approvals(id) ON DELETE CASCADE,
  approved_by    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  providers_json TEXT NOT NULL DEFAULT '[]',
  task_id        TEXT REFERENCES crew_tasks(id) ON DELETE CASCADE,
  workspace_path TEXT,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crew_grants_company ON crew_sandbox_grants(company_id, expires_at);

-- ---------------------------------------------------------------------------
-- Audit. Append-only and hash-chained per company.
-- The application layer exposes no UPDATE or DELETE for this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_audit_events (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('owner','agent','system','routine')),
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL DEFAULT '',
  entity_id      TEXT NOT NULL DEFAULT '',
  task_id        TEXT,
  run_id         TEXT,
  approval_id    TEXT,
  outcome        TEXT NOT NULL DEFAULT 'ok',
  details_json   TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL DEFAULT '',
  prev_hash      TEXT NOT NULL DEFAULT '',
  entry_hash     TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_crew_audit_company ON crew_audit_events(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crew_audit_entity ON crew_audit_events(company_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Memory references (Obsidian vault / Honcho provenance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_memory_refs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note','fact','preference','hypothesis','summary')),
  title         TEXT NOT NULL DEFAULT '',
  path          TEXT,
  task_id       TEXT,
  project_id    TEXT,
  agent_id      TEXT,
  source        TEXT NOT NULL DEFAULT '',
  confidence    REAL NOT NULL DEFAULT 1.0,
  sensitivity   TEXT NOT NULL DEFAULT 'internal',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_memory_company ON crew_memory_refs(company_id, kind);

-- ---------------------------------------------------------------------------
-- Notifications (decision inbox / Discord fan-out)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crew_notifications (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info','warning','critical')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  task_id       TEXT,
  approval_id   TEXT,
  read_at       INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_notifications_company ON crew_notifications(company_id, read_at, created_at);
`;

export const migration: Migration = {
  version: 2,
  description: "ironcrew domain foundation (company-scoped tasks, runs, governance, audit)",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 2 }, "ironcrew domain tables ensured");
  },
};
