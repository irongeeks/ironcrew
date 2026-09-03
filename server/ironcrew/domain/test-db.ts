/**
 * In-memory database helper for IronCrew domain tests.
 * Applies the same migration the server runs, so tests exercise the real schema.
 */
import { DatabaseSync } from "node:sqlite";
import { migration as ironCrewDomain } from "../../modules/bootstrap/migrations/0002-iron-crew-domain.ts";
import { migration as crewMilestones } from "../../modules/bootstrap/migrations/0003-crew-milestones.ts";
import { migration as crewSecrets } from "../../modules/bootstrap/migrations/0004-crew-secrets.ts";
import { migration as crewAttachments } from "../../modules/bootstrap/migrations/0005-crew-attachments.ts";
import { migration as renameIcToCrew } from "../../modules/bootstrap/migrations/0006-rename-ic-prefix-to-crew.ts";
import { migration as crewRemoteWorkers } from "../../modules/bootstrap/migrations/0007-crew-remote-workers.ts";
import { newId } from "./ids.ts";

export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ironCrewDomain.up(db);
  crewMilestones.up(db);
  crewSecrets.up(db);
  crewAttachments.up(db);
  renameIcToCrew.up(db);
  crewRemoteWorkers.up(db);
  return db;
}

export function seedCompany(db: DatabaseSync, name = "IronCrew Test"): string {
  const id = newId("cmp");
  db.prepare("INSERT INTO crew_companies (id, name, slug) VALUES (?,?,?)").run(id, name, `test-${id}`);
  return id;
}

export function seedAgent(db: DatabaseSync, companyId: string, key = "cto"): string {
  const id = newId("agt");
  db.prepare(
    `INSERT INTO crew_agents (id, company_id, key, professional_role, display_name)
     VALUES (?,?,?,?,?)`,
  ).run(id, companyId, key, key, key.toUpperCase());
  return id;
}
