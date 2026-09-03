import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerProjectRoutes } from "../../../../modules/routes/core/projects.ts";

// ---------------------------------------------------------------------------
// Mock modules that helpers.ts may pull in indirectly
// ---------------------------------------------------------------------------

vi.mock("../../../../security/auth.ts", () => ({
  shouldRequireCsrf: vi.fn(() => false),
  hasValidCsrfToken: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Minimal mock DB — path-check and path-browse don't touch the DB,
// but registerProjectRoutes still wires up other routes that do.
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    prepare(_sql: string) {
      return {
        get: () => undefined,
        run: () => ({ changes: 0 }),
        all: () => [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to build a fully-wired Express app
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());

  const db = createMockDb();

  registerProjectRoutes({
    app: app as any,
    db: db as any,
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
      return undefined;
    },
    normalizeTextField: (value: unknown) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      return null;
    },
    runInTransaction: (fn: () => void) => fn(),
    nowMs: () => Date.now(),
  });

  return app;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Project Path Operations", () => {
  // -------------------------------------------------------------------------
  // GET /api/projects/path-check
  // -------------------------------------------------------------------------

  describe("GET /api/projects/path-check", () => {
    it("returns exists: true for an existing directory (e.g. /tmp)", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/projects/path-check").query({ path: "/tmp" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.exists).toBe(true);
      expect(res.body.is_directory).toBe(true);
      expect(res.body.normalized_path).toBeTruthy();
    });

    it("returns exists: false for a nonexistent path", async () => {
      const app = buildApp();

      const res = await request(app)
        .get("/api/projects/path-check")
        .query({ path: "/tmp/__definitely_does_not_exist_" + Date.now() });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.exists).toBe(false);
      expect(res.body.is_directory).toBe(false);
    });

    it("returns 400 when path query param is missing", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/projects/path-check");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("project_path_required");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/path-browse
  // -------------------------------------------------------------------------

  describe("GET /api/projects/path-browse", () => {
    it("lists directory contents for /tmp", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/projects/path-browse").query({ path: "/tmp" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.current_path).toBe("/tmp");
      expect(Array.isArray(res.body.entries)).toBe(true);
      // Each entry should have name and path
      for (const entry of res.body.entries) {
        expect(entry).toHaveProperty("name");
        expect(entry).toHaveProperty("path");
      }
    });

    it("handles path traversal attempt safely", async () => {
      const app = buildApp();

      // A traversal path like /tmp/../../etc/passwd should be normalized
      // and still return a valid response (normalized path won't escape allowed roots)
      const res = await request(app).get("/api/projects/path-browse").query({ path: "/tmp/../../etc" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // The path should be normalized — no ".." components
      expect(res.body.current_path).not.toContain("..");
    });
  });
});
