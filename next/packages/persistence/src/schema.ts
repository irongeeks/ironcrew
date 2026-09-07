/** Migration 1 is intentionally additive; schema_version is checked before writing. */
export const schema = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS areas(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), data TEXT NOT NULL, UNIQUE(company_id,id));
CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),seed_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(company_id,seed_key),UNIQUE(company_id,id));
CREATE TABLE IF NOT EXISTS documents(company_id TEXT NOT NULL REFERENCES companies(id),area_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,customer_id TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(company_id,kind,id),FOREIGN KEY(company_id,area_id) REFERENCES areas(company_id,id));
CREATE TABLE IF NOT EXISTS document_seals(company_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(company_id,kind,id),FOREIGN KEY(company_id,kind,id) REFERENCES documents(company_id,kind,id));
CREATE INDEX IF NOT EXISTS documents_scope ON documents(company_id,area_id,kind,customer_id,project_id);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,area_id TEXT NOT NULL,customer_id TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',lead_employee_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,FOREIGN KEY(company_id,area_id) REFERENCES areas(company_id,id),FOREIGN KEY(company_id,lead_employee_id) REFERENCES employees(company_id,id));
CREATE INDEX IF NOT EXISTS orders_scope ON orders(company_id,area_id,customer_id,project_id);
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,company_id TEXT NOT NULL REFERENCES companies(id),area_id TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL REFERENCES companies(id),previous_hash TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),event_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),state TEXT NOT NULL DEFAULT 'pending',data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_periods(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),limit_micros INTEGER NOT NULL CHECK(limit_micros>=0),active INTEGER NOT NULL DEFAULT 1,UNIQUE(company_id,active));
CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),period_id TEXT NOT NULL REFERENCES budget_periods(id),order_id TEXT NOT NULL REFERENCES orders(id),reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0),settled_micros INTEGER CHECK(settled_micros>=0),state TEXT NOT NULL CHECK(state IN ('held','settled','released','unreconciled')),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(company_id TEXT NOT NULL REFERENCES companies(id),key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(company_id,key));
`;
