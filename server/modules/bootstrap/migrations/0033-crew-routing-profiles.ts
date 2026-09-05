import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 33,
  description: "Versioned owner routing profiles and agent bindings",
  up(db) {
    db.exec(`
CREATE TABLE crew_routing_revisions (
 company_id TEXT NOT NULL REFERENCES crew_companies(id),revision INTEGER NOT NULL,config_json TEXT NOT NULL,
 created_by TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,revision)
);
CREATE TABLE crew_agent_routing (
 company_id TEXT NOT NULL REFERENCES crew_companies(id),agent_id TEXT NOT NULL REFERENCES crew_agents(id),
 profile_key TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(company_id,agent_id)
);
ALTER TABLE crew_runs ADD COLUMN routing_vessel_id TEXT;
ALTER TABLE crew_runs ADD COLUMN routing_origin_vessel_id TEXT;
ALTER TABLE crew_runs ADD COLUMN routing_profile_key TEXT;
ALTER TABLE crew_runs ADD COLUMN routing_revision INTEGER;
-- A routed cost is recorded once, but remains subject to origin and destination caps.
ALTER TABLE crew_cost_events ADD COLUMN origin_runtime_type TEXT;
ALTER TABLE crew_cost_events ADD COLUMN model_vendor TEXT;
CREATE TABLE crew_routing_meeting_leases (
 id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES crew_companies(id),vessel_id TEXT NOT NULL REFERENCES crew_vessels(id),
 origin_vessel_id TEXT,meeting_id TEXT NOT NULL REFERENCES crew_meetings(id),expires_at INTEGER NOT NULL
);
`);
  },
};
