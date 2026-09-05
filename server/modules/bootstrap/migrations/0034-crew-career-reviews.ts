import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 34,
  description: "Versioned career configuration and immutable run-bound lead reviews",
  up(db) {
    db.exec(`
CREATE TABLE crew_career_config(company_id TEXT NOT NULL REFERENCES crew_companies(id),revision INTEGER NOT NULL,config_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,revision));
CREATE TABLE crew_career_legacy_tasks(company_id TEXT NOT NULL REFERENCES crew_companies(id),task_id TEXT NOT NULL REFERENCES crew_tasks(id),PRIMARY KEY(company_id,task_id));
CREATE TABLE crew_career_levels(company_id TEXT NOT NULL REFERENCES crew_companies(id),agent_id TEXT NOT NULL REFERENCES crew_agents(id),revision INTEGER NOT NULL,level TEXT NOT NULL CHECK(level IN ('junior','senior','lead')),approval_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,agent_id,revision));
CREATE TABLE crew_career_changes(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES crew_companies(id),agent_id TEXT NOT NULL REFERENCES crew_agents(id),base_revision INTEGER NOT NULL,level TEXT NOT NULL,approval_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE crew_career_workflows(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES crew_companies(id),purpose TEXT NOT NULL CHECK(purpose IN ('routing','review')),task_id TEXT NOT NULL REFERENCES crew_tasks(id),work_run_id TEXT REFERENCES crew_runs(id),internal_task_id TEXT UNIQUE REFERENCES crew_tasks(id),lead_agent_id TEXT REFERENCES crew_agents(id),reviewer_agent_id TEXT REFERENCES crew_agents(id),revision INTEGER NOT NULL,status TEXT NOT NULL,difficulty TEXT NOT NULL DEFAULT 'normal',run_id TEXT REFERENCES crew_runs(id),assigned_agent_id TEXT REFERENCES crew_agents(id),rationale TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,UNIQUE(company_id,purpose,task_id,revision),UNIQUE(company_id,purpose,work_run_id));
CREATE TABLE crew_career_reviews(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES crew_companies(id),workflow_id TEXT NOT NULL UNIQUE REFERENCES crew_career_workflows(id),task_id TEXT NOT NULL REFERENCES crew_tasks(id),work_run_id TEXT NOT NULL UNIQUE REFERENCES crew_runs(id),review_run_id TEXT NOT NULL UNIQUE REFERENCES crew_runs(id),agent_id TEXT NOT NULL REFERENCES crew_agents(id),reviewer_agent_id TEXT NOT NULL REFERENCES crew_agents(id),runtime_type TEXT NOT NULL,model TEXT,vessel_id TEXT,revision INTEGER NOT NULL,difficulty TEXT NOT NULL,score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),rationale TEXT NOT NULL,rubric_json TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,rubric_version INTEGER NOT NULL,reviewer_runtime_type TEXT NOT NULL,reviewer_model TEXT,reviewer_vessel_id TEXT);
CREATE TRIGGER crew_career_reviews_no_update BEFORE UPDATE ON crew_career_reviews BEGIN SELECT RAISE(ABORT,'immutable career review'); END;
CREATE TRIGGER crew_career_reviews_no_delete BEFORE DELETE ON crew_career_reviews BEGIN SELECT RAISE(ABORT,'immutable career review'); END;
ALTER TABLE crew_cost_events ADD COLUMN root_task_id TEXT;
`);
  },
};
