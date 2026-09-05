import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migration as original } from "./0025-crew-character-appearance.ts";
import { migration } from "./0030-crew-character-media.ts";

describe("character media migration", () => {
  it("preserves assigned old images and composite company foreign keys during a transactional rebuild", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE crew_companies(id TEXT PRIMARY KEY);
        CREATE TABLE crew_agents(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES crew_companies(id));
        INSERT INTO crew_companies VALUES('first'),('second');
        INSERT INTO crew_agents VALUES('agent','first');`);
      original.up(db);
      db.exec(`INSERT INTO crew_character_assets VALUES('image','first','portrait','image/webp',40,40,100,'digest','owner',1);
        INSERT INTO crew_agent_appearances VALUES('agent','first','navigator','image',NULL,1);
        BEGIN`);
      migration.up(db);
      db.exec("COMMIT");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db.prepare("SELECT portrait_asset_id,model_asset_id,animation_config_json FROM crew_agent_appearances").get(),
      ).toEqual({ portrait_asset_id: "image", model_asset_id: null, animation_config_json: null });
      expect(db.prepare("SELECT status,metadata_json FROM crew_character_assets").get()).toEqual({
        status: "active",
        metadata_json: "{}",
      });
      expect(() => db.exec("DELETE FROM crew_character_assets WHERE id='image'")).toThrow(/FOREIGN KEY/);
      expect(() => db.exec("UPDATE crew_character_assets SET company_id='second' WHERE id='image'")).toThrow(
        /FOREIGN KEY/,
      );
    } finally {
      db.close();
    }
  });
});
