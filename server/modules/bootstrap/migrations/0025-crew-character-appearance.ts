import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";

/** Per-agent appearance, deliberately independent of shared talents and policies. */
export const migration: Migration = {
  version: 25,
  description: "Private character assets and independent per-agent visual appearance",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_character_assets (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('portrait','full_body')),
        content_type TEXT NOT NULL CHECK(content_type = 'image/webp'),
        width INTEGER NOT NULL CHECK(width > 0 AND width <= 4096),
        height INTEGER NOT NULL CHECK(height > 0 AND height <= 4096),
        size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(id, company_id)
      );
      CREATE INDEX IF NOT EXISTS idx_crew_character_assets_company ON crew_character_assets(company_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_agents_id_company ON crew_agents(id, company_id);
      CREATE TABLE IF NOT EXISTS crew_agent_appearances (
        agent_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
        character_id TEXT,
        portrait_asset_id TEXT,
        full_body_asset_id TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(agent_id, company_id) REFERENCES crew_agents(id, company_id) ON DELETE CASCADE,
        FOREIGN KEY(portrait_asset_id, company_id) REFERENCES crew_character_assets(id, company_id),
        FOREIGN KEY(full_body_asset_id, company_id) REFERENCES crew_character_assets(id, company_id)
      );
    `);
  },
};
