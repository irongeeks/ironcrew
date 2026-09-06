import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateCompanyIdentity, readCompanyIdentity } from "./company-identity.ts";

describe("wizard identity migration", () => {
  it("imports existing wizard names once and preserves later canonical edits", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE crew_companies (id TEXT, slug TEXT, name TEXT, owner_name TEXT, updated_at INTEGER);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO crew_companies VALUES ('company', 'iron-crew', 'IronCrew', 'CEO', 0);
        INSERT INTO settings VALUES ('companyName', 'Testfirma'), ('ceoName', 'Robert');`);
      migrateCompanyIdentity(db, "company");
      expect(readCompanyIdentity(db)).toMatchObject({ name: "Testfirma", owner_name: "Robert" });
      db.prepare("UPDATE crew_companies SET name = 'IronCrew', owner_name = 'CEO'").run();
      migrateCompanyIdentity(db, "company");
      expect(readCompanyIdentity(db)).toMatchObject({ name: "IronCrew", owner_name: "CEO" });
    } finally {
      db.close();
    }
  });
});
