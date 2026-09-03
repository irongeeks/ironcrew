import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { describe, expect, it, beforeEach } from "vitest";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";
import { installSecurityMiddleware } from "../../../security/auth.ts";
import { registerDocsRoutes } from "../../../modules/routes/docs/routes.ts";

/**
 * Unit tests for Knowledge (docs) provider CRUD routes.
 *
 * Uses an in-memory SQLite database (node:sqlite DatabaseSync) with the real
 * table schema so provider-service.ts SQL runs unmodified.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('obsidian_local')),
  vault_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  read_only INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at INTEGER DEFAULT (unixepoch()*1000),
  updated_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS docs_provider_bindings (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES docs_providers(id) ON DELETE CASCADE,
  project_id TEXT,
  project_path_prefix TEXT,
  created_at INTEGER DEFAULT (unixepoch()*1000)
);
`;

function createApp() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const app = express();

  // Force loopback so security middleware passes
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", writable: true });
    next();
  });

  installSecurityMiddleware(app);

  registerDocsRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    appendTaskLog: () => {},
    taskWorktrees: new Map(),
  });

  return { app, db };
}

function authGet(app: express.Express, path: string) {
  return request(app).get(path).set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);
}

function authPost(app: express.Express, path: string, body?: object) {
  return request(app)
    .post(path)
    .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
    .send(body ?? {});
}

function authDelete(app: express.Express, path: string) {
  return request(app).delete(path).set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);
}

function authPatch(app: express.Express, path: string, body?: object) {
  return request(app)
    .patch(path)
    .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
    .send(body ?? {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Knowledge Provider CRUD routes", () => {
  let app: express.Express;
  let db: DatabaseSync;

  beforeEach(() => {
    ({ app, db } = createApp());
  });

  // ---- GET /api/knowledge/docs/providers ----

  describe("GET /api/knowledge/docs/providers", () => {
    it("returns empty list initially", async () => {
      const res = await authGet(app, "/api/knowledge/docs/providers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, providers: [] });
    });

    it("returns providers after creation", async () => {
      await authPost(app, "/api/knowledge/docs/providers", {
        name: "My Vault",
        vaultPath: "/tmp/test-vault",
      });

      const res = await authGet(app, "/api/knowledge/docs/providers");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.providers).toHaveLength(1);
      expect(res.body.providers[0].name).toBe("My Vault");
    });
  });

  // ---- POST /api/knowledge/docs/providers ----

  describe("POST /api/knowledge/docs/providers", () => {
    it("creates a provider with valid data", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Test Vault",
        vaultPath: "/tmp/obsidian-vault",
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBeDefined();
      expect(res.body.provider.name).toBe("Test Vault");
      expect(res.body.provider.providerType).toBe("obsidian_local");
      expect(res.body.provider.enabled).toBe(true);
      expect(res.body.provider.readOnly).toBe(false);
      expect(res.body.provider.id).toBeTruthy();
    });

    it("uses default name when name is omitted", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        vaultPath: "/tmp/vault",
      });

      expect(res.status).toBe(200);
      expect(res.body.provider.name).toBe("Obsidian Vault");
    });

    it("rejects missing vaultPath", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Bad Vault",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("rejects empty vaultPath", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Bad Vault",
        vaultPath: "",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("respects enabled=false", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Disabled Vault",
        vaultPath: "/tmp/disabled",
        enabled: false,
      });

      expect(res.status).toBe(200);
      expect(res.body.provider.enabled).toBe(false);
    });

    it("respects readOnly=true", async () => {
      const res = await authPost(app, "/api/knowledge/docs/providers", {
        name: "RO Vault",
        vaultPath: "/tmp/readonly",
        readOnly: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.provider.readOnly).toBe(true);
    });
  });

  // ---- PATCH /api/knowledge/docs/providers/:id ----

  describe("PATCH /api/knowledge/docs/providers/:id", () => {
    it("updates provider name", async () => {
      const createRes = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Original",
        vaultPath: "/tmp/vault",
      });
      const id = createRes.body.provider.id;

      const patchRes = await authPatch(app, `/api/knowledge/docs/providers/${id}`, {
        name: "Renamed",
      });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.ok).toBe(true);
      expect(patchRes.body.provider.name).toBe("Renamed");
    });

    it("returns 404 for non-existent provider", async () => {
      const res = await authPatch(app, "/api/knowledge/docs/providers/nonexistent-id", {
        name: "Nope",
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("provider_not_found");
    });
  });

  // ---- DELETE /api/knowledge/docs/providers/:id ----

  describe("DELETE /api/knowledge/docs/providers/:id", () => {
    it("removes an existing provider", async () => {
      const createRes = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Doomed Vault",
        vaultPath: "/tmp/doomed",
      });
      const id = createRes.body.provider.id;

      const deleteRes = await authDelete(app, `/api/knowledge/docs/providers/${id}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.ok).toBe(true);

      // Verify it is gone
      const listRes = await authGet(app, "/api/knowledge/docs/providers");
      expect(listRes.body.providers).toHaveLength(0);
    });

    it("returns 404 for non-existent provider", async () => {
      const res = await authDelete(app, "/api/knowledge/docs/providers/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("provider_not_found");
    });

    it("also removes associated bindings", async () => {
      // Create provider
      const createRes = await authPost(app, "/api/knowledge/docs/providers", {
        name: "Bound Vault",
        vaultPath: "/tmp/bound",
      });
      const providerId = createRes.body.provider.id;

      // Create a binding
      await authPost(app, `/api/knowledge/docs/providers/${providerId}/bindings`, {
        projectId: "proj-1",
      });

      // Verify binding exists
      const bindingsRes = await authGet(app, `/api/knowledge/docs/providers/${providerId}/bindings`);
      expect(bindingsRes.body.bindings).toHaveLength(1);

      // Delete provider
      await authDelete(app, `/api/knowledge/docs/providers/${providerId}`);

      // Verify bindings are gone (query DB directly since the provider route would 404)
      const rows = db.prepare("SELECT * FROM docs_provider_bindings WHERE provider_id = ?").all(providerId);
      expect(rows).toHaveLength(0);
    });
  });

  // ---- Auth guard ----

  describe("Auth guard", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(app).get("/api/knowledge/docs/providers");
      expect(res.status).toBe(401);
    });
  });
});
