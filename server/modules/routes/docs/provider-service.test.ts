import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveTaskDocsProviders } from "./provider-service.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE docs_providers (
      id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      name TEXT NOT NULL,
      vault_path TEXT NOT NULL,
      metadata_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      read_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE docs_provider_bindings (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      project_id TEXT,
      project_path_prefix TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe("resolveTaskDocsProviders", () => {
  it("matches bound project path prefixes only on real path boundaries", () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO docs_providers (id, provider_type, name, vault_path, enabled, read_only, created_at, updated_at)
         VALUES ('provider-app', 'obsidian_local', 'App Docs', '/workspace/app/docs', 1, 0, 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO docs_provider_bindings (id, provider_id, project_id, project_path_prefix, created_at)
         VALUES ('binding-app', 'provider-app', NULL, '/workspace/app', 1)`,
      ).run();

      const exactMatch = resolveTaskDocsProviders(db, { project_path: "/workspace/app" });
      const childMatch = resolveTaskDocsProviders(db, { project_path: "/workspace/app/packages/api" });
      const siblingMiss = resolveTaskDocsProviders(db, { project_path: "/workspace/app2" });

      expect(exactMatch.map((provider) => provider.id)).toEqual(["provider-app"]);
      expect(childMatch.map((provider) => provider.id)).toEqual(["provider-app"]);
      expect(siblingMiss).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps fallback vault matching boundary-safe for neighboring directories", () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO docs_providers (id, provider_type, name, vault_path, enabled, read_only, created_at, updated_at)
         VALUES ('provider-vault', 'obsidian_local', 'Vault Docs', '/workspace/app/docs', 1, 0, 1, 1)`,
      ).run();

      const nestedProject = resolveTaskDocsProviders(db, { project_path: "/workspace/app/docs/feature-x" });
      const parentProject = resolveTaskDocsProviders(db, { project_path: "/workspace/app" });
      const siblingMiss = resolveTaskDocsProviders(db, { project_path: "/workspace/app-docs" });

      expect(nestedProject.map((provider) => provider.id)).toEqual(["provider-vault"]);
      expect(parentProject.map((provider) => provider.id)).toEqual(["provider-vault"]);
      expect(siblingMiss).toEqual([]);
    } finally {
      db.close();
    }
  });
});
