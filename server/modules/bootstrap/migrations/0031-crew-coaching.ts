import type { Migration } from "./migration-types.ts";

/** Native, original implementation of human-reviewed coaching; no upstream code copied. */
export const migration: Migration = {
  version: 31,
  description: "Agent coaching proposals, deterministic evaluations and approved guidance versions",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_coaching_proposals (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        agent_id TEXT NOT NULL REFERENCES crew_agents(id),
        title TEXT NOT NULL, guidance TEXT NOT NULL, skills_json TEXT NOT NULL,
        cases_json TEXT NOT NULL, skill_basis_json TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','ready','failed','applied','rejected')),
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        reviewed_by TEXT, review_reason TEXT NOT NULL DEFAULT '',
        correlation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_coaching_proposals_agent
        ON crew_coaching_proposals(company_id, agent_id, created_at);
      CREATE TABLE IF NOT EXISTS crew_coaching_evaluations (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        proposal_id TEXT NOT NULL REFERENCES crew_coaching_proposals(id),
        checks_json TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)),
        created_at INTEGER NOT NULL, created_by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_coaching_evaluations_proposal
        ON crew_coaching_evaluations(company_id, proposal_id, created_at);
      CREATE TABLE IF NOT EXISTS crew_agent_guidance_versions (
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        agent_id TEXT NOT NULL REFERENCES crew_agents(id),
        version INTEGER NOT NULL CHECK(version > 0),
        guidance TEXT NOT NULL, skills_json TEXT NOT NULL,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES crew_coaching_proposals(id),
        approved_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(company_id, agent_id, version)
      );
      CREATE TABLE IF NOT EXISTS crew_coaching_notes (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        agent_id TEXT NOT NULL REFERENCES crew_agents(id),
        kind TEXT NOT NULL CHECK(kind IN ('one_on_one','retrospective','lesson')),
        title TEXT NOT NULL, body TEXT NOT NULL,
        run_id TEXT REFERENCES crew_runs(id),
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_coaching_notes_agent
        ON crew_coaching_notes(company_id, agent_id, created_at);
    `);
  },
};
