import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";

/**
 * Regression tests for the `allow_local` per-provider SSRF flag.
 *
 * Tests three areas:
 *  1. Persistence roundtrip — write/read/update the flag via SQLite
 *  2. Default value — column defaults to 0 when not specified
 *  3. SSRF behavior — isBlockedSsrfTarget respects the allowLocal option
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'openai',
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      allow_local INTEGER NOT NULL DEFAULT 0,
      models_cache TEXT,
      models_cached_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

type ApiProviderRow = {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_enc: string | null;
  enabled: number;
  allow_local: number;
  models_cache: string | null;
  models_cached_at: number | null;
  created_at: number;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// 1. Persistence roundtrip
// ---------------------------------------------------------------------------

describe("allow_local persistence roundtrip", () => {
  it("stores allow_local=1 and reads it back", () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO api_providers (id, name, type, base_url, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Local Ollama", "ollama", "http://localhost:11434/v1", 1, now, now);

    const row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("p1") as ApiProviderRow;
    expect(row.allow_local).toBe(1);
    expect(Boolean(row.allow_local)).toBe(true);
  });

  it("updates allow_local from true to false", () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO api_providers (id, name, type, base_url, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p2", "Local LM Studio", "custom", "http://localhost:1234/v1", 1, now, now);

    // Verify initial value
    let row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("p2") as ApiProviderRow;
    expect(row.allow_local).toBe(1);

    // Update to false
    db.prepare("UPDATE api_providers SET allow_local = ?, updated_at = ? WHERE id = ?").run(0, now + 1000, "p2");

    row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("p2") as ApiProviderRow;
    expect(row.allow_local).toBe(0);
    expect(Boolean(row.allow_local)).toBe(false);
  });

  it("updates allow_local from false to true", () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO api_providers (id, name, type, base_url, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p3", "OpenAI", "openai", "https://api.openai.com/v1", 0, now, now);

    // Update to true
    db.prepare("UPDATE api_providers SET allow_local = ?, updated_at = ? WHERE id = ?").run(1, now + 1000, "p3");

    const row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("p3") as ApiProviderRow;
    expect(row.allow_local).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Default value
// ---------------------------------------------------------------------------

describe("allow_local default value", () => {
  it("defaults to 0 (false) when not specified in INSERT", () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO api_providers (id, name, type, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("p-default", "Anthropic", "anthropic", "https://api.anthropic.com/v1", now, now);

    const row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("p-default") as ApiProviderRow;
    expect(row.allow_local).toBe(0);
    expect(Boolean(row.allow_local)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. SSRF behavior with allowLocal flag
// ---------------------------------------------------------------------------

describe("isBlockedSsrfTarget with allowLocal flag", () => {
  describe("when allow_local is false (default)", () => {
    const opts = { allowLocal: false };

    it("blocks localhost URLs", () => {
      expect(isBlockedSsrfTarget("http://localhost:11434/v1/models", opts)).toBe(true);
    });

    it("blocks 127.0.0.1", () => {
      expect(isBlockedSsrfTarget("http://127.0.0.1:11434/v1/models", opts)).toBe(true);
    });

    it("blocks ::1 (IPv6 loopback)", () => {
      expect(isBlockedSsrfTarget("http://[::1]:8080/api", opts)).toBe(true);
    });

    it("blocks RFC 1918 private addresses", () => {
      expect(isBlockedSsrfTarget("http://10.0.0.5:8188/", opts)).toBe(true);
      expect(isBlockedSsrfTarget("http://192.168.1.100:3000/", opts)).toBe(true);
      expect(isBlockedSsrfTarget("http://172.16.0.1/api", opts)).toBe(true);
    });

    it("blocks cloud metadata endpoints", () => {
      expect(isBlockedSsrfTarget("http://169.254.169.254/latest/meta-data/", opts)).toBe(true);
      expect(isBlockedSsrfTarget("http://metadata.google.internal/computeMetadata/v1/", opts)).toBe(true);
    });

    it("allows public API URLs", () => {
      expect(isBlockedSsrfTarget("https://api.openai.com/v1/models", opts)).toBe(false);
      expect(isBlockedSsrfTarget("https://api.anthropic.com/v1/models", opts)).toBe(false);
    });
  });

  describe("when allow_local is true", () => {
    const opts = { allowLocal: true };

    it("allows localhost URLs", () => {
      expect(isBlockedSsrfTarget("http://localhost:11434/v1/models", opts)).toBe(false);
    });

    it("allows 127.0.0.1", () => {
      expect(isBlockedSsrfTarget("http://127.0.0.1:11434/v1/models", opts)).toBe(false);
    });

    it("allows ::1 (IPv6 loopback)", () => {
      expect(isBlockedSsrfTarget("http://[::1]:8080/api", opts)).toBe(false);
    });

    it("allows RFC 1918 private addresses", () => {
      expect(isBlockedSsrfTarget("http://10.0.0.5:8188/", opts)).toBe(false);
      expect(isBlockedSsrfTarget("http://192.168.1.100:3000/", opts)).toBe(false);
      expect(isBlockedSsrfTarget("http://172.16.0.1/api", opts)).toBe(false);
    });

    it("still blocks cloud metadata endpoints", () => {
      expect(isBlockedSsrfTarget("http://169.254.169.254/latest/meta-data/", opts)).toBe(true);
      expect(isBlockedSsrfTarget("http://metadata.google.internal/computeMetadata/v1/", opts)).toBe(true);
    });

    it("allows public API URLs", () => {
      expect(isBlockedSsrfTarget("https://api.openai.com/v1/models", opts)).toBe(false);
      expect(isBlockedSsrfTarget("https://api.anthropic.com/v1/models", opts)).toBe(false);
    });
  });

  describe("integration: DB flag drives SSRF decision", () => {
    it("provider with allow_local=0 blocks localhost, allow_local=1 allows it", () => {
      const db = createTestDb();
      const now = Date.now();

      // Create two providers: one strict, one local-friendly
      db.prepare(
        "INSERT INTO api_providers (id, name, type, base_url, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("strict", "Cloud OpenAI", "openai", "https://api.openai.com/v1", 0, now, now);

      db.prepare(
        "INSERT INTO api_providers (id, name, type, base_url, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("local", "Local Ollama", "ollama", "http://localhost:11434/v1", 1, now, now);

      const strictRow = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("strict") as ApiProviderRow;
      const localRow = db.prepare("SELECT * FROM api_providers WHERE id = ?").get("local") as ApiProviderRow;

      const localUrl = "http://localhost:11434/v1/models";

      // Strict provider: localhost is blocked
      expect(isBlockedSsrfTarget(localUrl, { allowLocal: !!strictRow.allow_local })).toBe(true);

      // Local-friendly provider: localhost is allowed
      expect(isBlockedSsrfTarget(localUrl, { allowLocal: !!localRow.allow_local })).toBe(false);
    });
  });
});
