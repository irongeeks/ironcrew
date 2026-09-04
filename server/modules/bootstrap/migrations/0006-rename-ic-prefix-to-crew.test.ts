import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach } from "vitest";
import { migration as ironCrewDomain } from "./0002-iron-crew-domain.ts";
import { migration as crewMilestones } from "./0003-crew-milestones.ts";
import { migration as crewSecrets } from "./0004-crew-secrets.ts";
import { migration as crewAttachments } from "./0005-crew-attachments.ts";
import { migration as renameIcToCrew } from "./0006-rename-ic-prefix-to-crew.ts";
import { hasIndex, hasTable } from "./migration-types.ts";

let db: DatabaseSync;

afterEach(() => db?.close());

describe("0006-rename-ic-prefix-to-crew — fresh install", () => {
  it("is a no-op: 0002-0005 already create crew_-named tables directly", () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    ironCrewDomain.up(db);
    crewMilestones.up(db);
    crewSecrets.up(db);
    crewAttachments.up(db);

    expect(() => renameIcToCrew.up(db)).not.toThrow();

    expect(hasTable(db, "crew_agents")).toBe(true);
    expect(hasTable(db, "crew_secrets")).toBe(true);
    expect(hasTable(db, "ic_agents")).toBe(false);
    expect(hasIndex(db, "idx_crew_agents_company")).toBe(true);
  });
});

describe("0006-rename-ic-prefix-to-crew — upgrade from a pre-rename database", () => {
  it("renames every ic_ table and index to its crew_ equivalent, preserving data", () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    // Simulate the schema as it existed before the IronCrew rename: build the
    // same tables under their original "ic_" names by rewriting the current
    // migrations' own SQL back to that prefix — the exact inverse of what
    // 0006 is supposed to undo.
    const oldSchemaSql = (up: (db: DatabaseSync) => void) => {
      const calls: string[] = [];
      const spy = { exec: (sql: string) => calls.push(sql) } as unknown as DatabaseSync;
      up(spy);
      return calls.map((sql) => sql.replaceAll("crew_", "ic_"));
    };

    for (const sql of oldSchemaSql(ironCrewDomain.up)) db.exec(sql);
    for (const sql of oldSchemaSql(crewMilestones.up)) db.exec(sql);
    for (const sql of oldSchemaSql(crewSecrets.up)) db.exec(sql);
    for (const sql of oldSchemaSql(crewAttachments.up)) db.exec(sql);

    expect(hasTable(db, "ic_agents")).toBe(true);
    expect(hasTable(db, "ic_secrets")).toBe(true);
    expect(hasIndex(db, "idx_ic_agents_company")).toBe(true);

    // A real row, so the rename is proven to preserve data, not just structure.
    db.prepare("INSERT INTO ic_companies (id, name, slug) VALUES ('cmp_1','Acme','acme')").run();

    renameIcToCrew.up(db);

    expect(hasTable(db, "ic_agents")).toBe(false);
    expect(hasTable(db, "ic_companies")).toBe(false);
    expect(hasTable(db, "crew_agents")).toBe(true);
    expect(hasTable(db, "crew_companies")).toBe(true);
    expect(hasIndex(db, "idx_ic_agents_company")).toBe(false);
    expect(hasIndex(db, "idx_crew_agents_company")).toBe(true);

    const row = db.prepare("SELECT name FROM crew_companies WHERE id = 'cmp_1'").get() as { name: string };
    expect(row.name).toBe("Acme");
  });

  it("is idempotent — running it twice does not error", () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    ironCrewDomain.up(db);
    crewMilestones.up(db);
    crewSecrets.up(db);
    crewAttachments.up(db);

    renameIcToCrew.up(db);
    expect(() => renameIcToCrew.up(db)).not.toThrow();
    expect(hasTable(db, "crew_agents")).toBe(true);
  });
});
