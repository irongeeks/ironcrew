import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 37,
  description: "Immutable versioned objective run evaluations and reproducible evidence",
  up(db) {
    db.exec(`
CREATE TABLE crew_objective_rubrics (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crew_companies(id),
 rubric_key TEXT NOT NULL, version INTEGER NOT NULL, rubric_json TEXT NOT NULL,
 UNIQUE(company_id,rubric_key,version)
);
CREATE TABLE crew_objective_measurements (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crew_companies(id),
 rubric_id TEXT NOT NULL REFERENCES crew_objective_rubrics(id),
 run_id TEXT NOT NULL REFERENCES crew_runs(id), agent_id TEXT NOT NULL REFERENCES crew_agents(id),
 runtime_type TEXT NOT NULL, model TEXT, score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
 measurement_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
 UNIQUE(company_id,rubric_id,run_id)
);
CREATE INDEX crew_objective_measurements_company ON crew_objective_measurements(company_id,rubric_id);
CREATE TRIGGER crew_objective_rubrics_no_update BEFORE UPDATE ON crew_objective_rubrics BEGIN SELECT RAISE(ABORT,'immutable objective rubric'); END;
CREATE TRIGGER crew_objective_rubrics_no_delete BEFORE DELETE ON crew_objective_rubrics BEGIN SELECT RAISE(ABORT,'immutable objective rubric'); END;
CREATE TRIGGER crew_objective_measurements_no_update BEFORE UPDATE ON crew_objective_measurements BEGIN SELECT RAISE(ABORT,'immutable objective measurement'); END;
CREATE TRIGGER crew_objective_measurements_no_delete BEFORE DELETE ON crew_objective_measurements BEGIN SELECT RAISE(ABORT,'immutable objective measurement'); END;
`);
  },
};
