import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "prepare">;
export type CompanyIdentity = { id: string; name: string; owner_name: string; locale?: string };

export function readCompanyIdentity(db: Db, companyId?: string): CompanyIdentity | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crew_companies'").get()) return;
  return db
    .prepare(`SELECT * FROM crew_companies WHERE ${companyId ? "id" : "slug"} = ?`)
    .get(companyId ?? "iron-crew") as CompanyIdentity | undefined;
}

/** Import old wizard settings once, without overwriting an explicitly named company. */
export function migrateCompanyIdentity(db: Db, companyId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) return;
  const key = `crewCompanyIdentityMigrated:${companyId}`;
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key)) return;
  const company = readCompanyIdentity(db, companyId);
  if (!company) return;
  const read = (setting: string): string | undefined => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(setting) as { value: string } | undefined;
    if (!row) return;
    let value: unknown = row.value;
    try {
      value = JSON.parse(row.value);
    } catch {
      /* plain string settings */
    }
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  db.prepare("UPDATE crew_companies SET name = ?, owner_name = ?, updated_at = ? WHERE id = ?").run(
    company.name === "IronCrew" ? (read("companyName") ?? company.name) : company.name,
    company.owner_name === "CEO" ? (read("ceoName") ?? company.owner_name) : company.owner_name,
    Date.now(),
    companyId,
  );
  db.prepare("INSERT INTO settings (key, value) VALUES (?, 'true')").run(key);
}
