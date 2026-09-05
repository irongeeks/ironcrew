import type { Migration } from "./migration-types.ts";

/** Rebuild both linked tables together, preserving existing images and assignments. */
export const migration: Migration = {
  version: 30,
  description: "Private GLB/spritesheet assets and recoverable audited character-file deletion",
  up(db) {
    db.exec(`
      CREATE TABLE crew_character_assets_v2 (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('portrait','full_body','animation','model_3d')),
        content_type TEXT NOT NULL CHECK(content_type IN ('image/webp','model/gltf-binary')),
        width INTEGER NOT NULL CHECK(width >= 0 AND width <= 4096),
        height INTEGER NOT NULL CHECK(height >= 0 AND height <= 4096),
        size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        deletion_actor_id TEXT,
        deletion_actor_type TEXT,
        UNIQUE(id, company_id),
        CHECK((kind='model_3d' AND content_type='model/gltf-binary' AND width=0 AND height=0)
          OR (kind!='model_3d' AND content_type='image/webp' AND width>0 AND height>0))
      );
      INSERT INTO crew_character_assets_v2 (id,company_id,kind,content_type,width,height,size_bytes,sha256,created_by,created_at)
        SELECT id,company_id,kind,content_type,width,height,size_bytes,sha256,created_by,created_at FROM crew_character_assets;
      CREATE TABLE crew_agent_appearances_v2 (
        agent_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
        character_id TEXT,
        portrait_asset_id TEXT,
        full_body_asset_id TEXT,
        model_asset_id TEXT,
        animation_asset_id TEXT,
        animation_config_json TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(agent_id, company_id) REFERENCES crew_agents(id, company_id) ON DELETE CASCADE,
        FOREIGN KEY(portrait_asset_id, company_id) REFERENCES crew_character_assets_v2(id, company_id),
        FOREIGN KEY(full_body_asset_id, company_id) REFERENCES crew_character_assets_v2(id, company_id),
        FOREIGN KEY(model_asset_id, company_id) REFERENCES crew_character_assets_v2(id, company_id),
        FOREIGN KEY(animation_asset_id, company_id) REFERENCES crew_character_assets_v2(id, company_id)
      );
      INSERT INTO crew_agent_appearances_v2 (agent_id,company_id,character_id,portrait_asset_id,full_body_asset_id,updated_at)
        SELECT agent_id,company_id,character_id,portrait_asset_id,full_body_asset_id,updated_at FROM crew_agent_appearances;
      DROP TABLE crew_agent_appearances;
      DROP TABLE crew_character_assets;
      ALTER TABLE crew_character_assets_v2 RENAME TO crew_character_assets;
      ALTER TABLE crew_agent_appearances_v2 RENAME TO crew_agent_appearances;
      CREATE INDEX idx_crew_character_assets_company ON crew_character_assets(company_id);
    `);
  },
};
