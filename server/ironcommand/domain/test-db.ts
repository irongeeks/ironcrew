/**
 * In-memory database helper for Iron Command domain tests.
 * Applies the same migration the server runs, so tests exercise the real schema.
 */
import { DatabaseSync } from "node:sqlite";
import { migration as ironCommandDomain } from "../../modules/bootstrap/migrations/0002-iron-command-domain.ts";
import { migration as icMilestones } from "../../modules/bootstrap/migrations/0003-ic-milestones.ts";
import { newId } from "./ids.ts";

export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ironCommandDomain.up(db);
  icMilestones.up(db);
  return db;
}

export function seedCompany(db: DatabaseSync, name = "Iron Command Test"): string {
  const id = newId("cmp");
  db.prepare("INSERT INTO ic_companies (id, name, slug) VALUES (?,?,?)").run(id, name, `test-${id}`);
  return id;
}

export function seedAgent(db: DatabaseSync, companyId: string, key = "cto"): string {
  const id = newId("agt");
  db.prepare(
    `INSERT INTO ic_agents (id, company_id, key, professional_role, display_name)
     VALUES (?,?,?,?,?)`,
  ).run(id, companyId, key, key, key.toUpperCase());
  return id;
}
