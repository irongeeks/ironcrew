import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../modules/bootstrap/schema/base-schema.ts";
import { initializeOAuthRuntime, type OAuthRuntimeHelpers } from "../../modules/bootstrap/schema/oauth-runtime.ts";

/**
 * Tests for `initializeOAuthRuntime` — the OAuth DB-runtime initializer that
 * applies idempotent column/index migrations and exposes a typed helper API
 * over the `oauth_accounts` / `oauth_active_accounts` tables.
 *
 * NOTE on scope: the X-009 issue described `oauth-runtime.ts` as the live
 * token-exchange flow, but the actual module at
 * `server/modules/bootstrap/schema/oauth-runtime.ts` is a DB-runtime initializer
 * (no HTTP). These tests cover the real public surface of that file.
 */

type RuntimeBundle = {
  db: DatabaseSync;
  now: ReturnType<typeof vi.fn>;
  txCalls: () => number;
  helpers: OAuthRuntimeHelpers;
};

function makeRuntime(opts?: { now?: number }): RuntimeBundle {
  const db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  let current = opts?.now ?? 1_700_000_000_000;
  const now = vi.fn(() => current++);
  let txCalls = 0;
  const runInTransaction = (fn: () => void) => {
    txCalls += 1;
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const helpers = initializeOAuthRuntime({ db, nowMs: now, runInTransaction });
  return { db, now, txCalls: () => txCalls, helpers };
}

function insertAccount(
  db: DatabaseSync,
  opts: {
    id: string;
    provider: "github" | "google_antigravity";
    label?: string | null;
    status?: "active" | "disabled";
    priority?: number;
    accessToken?: string;
    refreshToken?: string;
  },
): void {
  db.prepare(
    `INSERT INTO oauth_accounts (id, provider, label, status, priority, access_token_enc, refresh_token_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.provider,
    opts.label ?? null,
    opts.status ?? "active",
    opts.priority ?? 100,
    opts.accessToken ?? "tok-enc",
    opts.refreshToken ?? "ref-enc",
  );
}

describe("initializeOAuthRuntime", () => {
  let bundle: RuntimeBundle;

  beforeEach(() => {
    bundle = makeRuntime();
  });

  afterEach(() => {
    bundle.db.close();
  });

  describe("schema migrations", () => {
    it("applies all idempotent ALTER TABLE migrations without error", () => {
      const cols = bundle.db.prepare("PRAGMA table_info(oauth_credentials)").all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("access_token_enc");
      expect(colNames).toContain("refresh_token_enc");
    });

    it("re-running initializeOAuthRuntime is a no-op (idempotent)", () => {
      expect(() =>
        initializeOAuthRuntime({
          db: bundle.db,
          nowMs: () => 1,
          runInTransaction: (fn) => fn(),
        }),
      ).not.toThrow();
    });

    it("creates the unique index on departments(sort_order)", () => {
      const idx = bundle.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_departments_sort_order'")
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_departments_sort_order");
    });

    it("backfills department multilingual names", () => {
      const db2 = new DatabaseSync(":memory:");
      applyBaseSchema(db2);
      db2
        .prepare(
          "INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, sort_order) VALUES ('planning', 'Planning', '기획', '', '', '🧠', '#fff', 1)",
        )
        .run();
      initializeOAuthRuntime({ db: db2, nowMs: () => 1, runInTransaction: (fn) => fn() });
      const row = db2.prepare("SELECT name_ja, name_zh FROM departments WHERE id='planning'").get() as {
        name_ja: string;
        name_zh: string;
      };
      expect(row.name_ja).toBe("企画チーム");
      expect(row.name_zh).toBe("Planning Team");
      db2.close();
    });
  });

  describe("normalizeOAuthProvider", () => {
    it("maps github aliases to 'github'", () => {
      expect(bundle.helpers.normalizeOAuthProvider("github")).toBe("github");
      expect(bundle.helpers.normalizeOAuthProvider("github-copilot")).toBe("github");
      expect(bundle.helpers.normalizeOAuthProvider("copilot")).toBe("github");
    });

    it("maps antigravity aliases to 'google_antigravity'", () => {
      expect(bundle.helpers.normalizeOAuthProvider("antigravity")).toBe("google_antigravity");
      expect(bundle.helpers.normalizeOAuthProvider("google_antigravity")).toBe("google_antigravity");
    });

    it("returns null for unknown providers", () => {
      expect(bundle.helpers.normalizeOAuthProvider("unknown")).toBeNull();
      expect(bundle.helpers.normalizeOAuthProvider("")).toBeNull();
    });
  });

  describe("oauthProviderPrefix", () => {
    it("returns 'Copi' for github and 'Anti' otherwise", () => {
      expect(bundle.helpers.oauthProviderPrefix("github")).toBe("Copi");
      expect(bundle.helpers.oauthProviderPrefix("google_antigravity")).toBe("Anti");
      expect(bundle.helpers.oauthProviderPrefix("anything-else")).toBe("Anti");
    });
  });

  describe("getNextOAuthLabel", () => {
    it("returns prefix-1 when no labels exist", () => {
      expect(bundle.helpers.getNextOAuthLabel("github")).toBe("Copi-1");
      expect(bundle.helpers.getNextOAuthLabel("google_antigravity")).toBe("Anti-1");
    });

    it("increments past the highest existing labelled account, ignoring null/garbage labels", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github", label: "Copi-1" });
      insertAccount(bundle.db, { id: "a2", provider: "github", label: "Copi-3" });
      insertAccount(bundle.db, { id: "a3", provider: "github", label: null });
      insertAccount(bundle.db, { id: "a4", provider: "github", label: "garbage" });
      expect(bundle.helpers.getNextOAuthLabel("github")).toBe("Copi-4");
    });

    it("ignores labels for other providers when computing the sequence", () => {
      insertAccount(bundle.db, { id: "a1", provider: "google_antigravity", label: "Anti-9" });
      expect(bundle.helpers.getNextOAuthLabel("github")).toBe("Copi-1");
    });

    it("normalizes alias provider before computing the label", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github", label: "Copi-2" });
      expect(bundle.helpers.getNextOAuthLabel("copilot")).toBe("Copi-3");
    });
  });

  describe("getActiveOAuthAccountIds", () => {
    it("returns empty list when nothing is active", () => {
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });

    it("returns active account IDs ordered by updated_at DESC", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      insertAccount(bundle.db, { id: "a2", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.helpers.setActiveOAuthAccount("github", "a2");
      const ids = bundle.helpers.getActiveOAuthAccountIds("github");
      expect(ids).toEqual(["a2", "a1"]);
    });

    it("excludes disabled accounts", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github", status: "disabled" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });

    it("does not leak across providers", () => {
      insertAccount(bundle.db, { id: "g1", provider: "github" });
      insertAccount(bundle.db, { id: "x1", provider: "google_antigravity" });
      bundle.helpers.setActiveOAuthAccount("github", "g1");
      bundle.helpers.setActiveOAuthAccount("google_antigravity", "x1");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual(["g1"]);
      expect(bundle.helpers.getActiveOAuthAccountIds("google_antigravity")).toEqual(["x1"]);
    });
  });

  describe("setActiveOAuthAccount", () => {
    it("inserts a new active row", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual(["a1"]);
    });

    it("upserts updated_at on conflict (same row, no duplicate)", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      const rows = bundle.db
        .prepare("SELECT account_id FROM oauth_active_accounts WHERE provider = 'github'")
        .all() as Array<{ account_id: string }>;
      expect(rows.map((r) => r.account_id)).toEqual(["a1"]);
    });
  });

  describe("removeActiveOAuthAccount", () => {
    it("removes only the targeted (provider, account) row", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      insertAccount(bundle.db, { id: "a2", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.helpers.setActiveOAuthAccount("github", "a2");
      bundle.helpers.removeActiveOAuthAccount("github", "a1");
      const ids = bundle.helpers.getActiveOAuthAccountIds("github");
      expect(ids).toEqual(["a2"]);
    });

    it("is a no-op when the row does not exist", () => {
      expect(() => bundle.helpers.removeActiveOAuthAccount("github", "missing")).not.toThrow();
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });
  });

  describe("setOAuthActiveAccounts", () => {
    it("replaces the active set atomically and dedupes input", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      insertAccount(bundle.db, { id: "a2", provider: "github" });
      insertAccount(bundle.db, { id: "a3", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a3");
      bundle.helpers.setOAuthActiveAccounts("github", ["a1", "a2", "a1", ""]);
      const ids = bundle.helpers.getActiveOAuthAccountIds("github");
      expect(new Set(ids)).toEqual(new Set(["a1", "a2"]));
      expect(ids).not.toContain("a3");
    });

    it("clears the active set when given an empty list (still uses a transaction)", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      const before = bundle.txCalls();
      bundle.helpers.setOAuthActiveAccounts("github", []);
      expect(bundle.txCalls()).toBeGreaterThan(before);
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });

    it("rolls back on FK violation", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.db.exec("PRAGMA foreign_keys = ON");
      expect(() => bundle.helpers.setOAuthActiveAccounts("github", ["does-not-exist"])).toThrow();
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual(["a1"]);
    });
  });

  describe("ensureOAuthActiveAccount", () => {
    it("removes orphaned active rows whose underlying account is missing or disabled", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github" });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.db.prepare("UPDATE oauth_accounts SET status='disabled' WHERE id='a1'").run();
      bundle.helpers.ensureOAuthActiveAccount("github");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });

    it("promotes the highest-priority active account when nothing is selected", () => {
      insertAccount(bundle.db, { id: "low", provider: "github", priority: 200 });
      insertAccount(bundle.db, { id: "high", provider: "github", priority: 50 });
      bundle.helpers.ensureOAuthActiveAccount("github");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual(["high"]);
    });

    it("leaves an existing active selection alone", () => {
      insertAccount(bundle.db, { id: "a1", provider: "github", priority: 200 });
      insertAccount(bundle.db, { id: "a2", provider: "github", priority: 50 });
      bundle.helpers.setActiveOAuthAccount("github", "a1");
      bundle.helpers.ensureOAuthActiveAccount("github");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual(["a1"]);
    });

    it("clears active rows when there are no eligible fallbacks", () => {
      bundle.helpers.ensureOAuthActiveAccount("github");
      expect(bundle.helpers.getActiveOAuthAccountIds("github")).toEqual([]);
    });
  });

  describe("legacy oauth_credentials migration", () => {
    it("migrates a legacy github credential into oauth_accounts on init", () => {
      const db2 = new DatabaseSync(":memory:");
      applyBaseSchema(db2);
      // The token columns are added by initializeOAuthRuntime itself; add them up-front
      // so we can seed legacy data before triggering the migration path.
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN access_token_enc TEXT");
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN refresh_token_enc TEXT");
      db2
        .prepare(
          `INSERT INTO oauth_credentials
           (provider, source, encrypted_data, email, scope, expires_at, access_token_enc, refresh_token_enc, created_at, updated_at)
           VALUES ('github', 'web', 'legacy-blob', 'a@example.com', 'repo', 1234567, 'acc-enc', 'ref-enc', 1000, 2000)`,
        )
        .run();
      initializeOAuthRuntime({
        db: db2,
        nowMs: () => 9_999_999,
        runInTransaction: (fn) => fn(),
      });
      const row = db2
        .prepare("SELECT id, provider, label, email, access_token_enc, refresh_token_enc FROM oauth_accounts")
        .get() as {
        id: string;
        provider: string;
        label: string;
        email: string;
        access_token_enc: string;
        refresh_token_enc: string;
      };
      expect(row.provider).toBe("github");
      expect(row.email).toBe("a@example.com");
      expect(row.label).toBe("Copi-1");
      expect(row.access_token_enc).toBe("acc-enc");
      expect(row.refresh_token_enc).toBe("ref-enc");
      const active = db2
        .prepare("SELECT account_id FROM oauth_active_accounts WHERE provider='github'")
        .all() as Array<{ account_id: string }>;
      expect(active.map((r) => r.account_id)).toEqual([row.id]);
      db2.close();
    });

    it("skips legacy migration when oauth_accounts already has rows for that provider", () => {
      const db2 = new DatabaseSync(":memory:");
      applyBaseSchema(db2);
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN access_token_enc TEXT");
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN refresh_token_enc TEXT");
      db2
        .prepare(
          `INSERT INTO oauth_credentials
           (provider, encrypted_data, access_token_enc, refresh_token_enc)
           VALUES ('github', 'blob', 'acc', 'ref')`,
        )
        .run();
      db2
        .prepare(
          `INSERT INTO oauth_accounts
           (id, provider, label, status, access_token_enc, refresh_token_enc)
           VALUES ('existing', 'github', 'Copi-1', 'active', 'old', 'old')`,
        )
        .run();
      initializeOAuthRuntime({ db: db2, nowMs: () => 1, runInTransaction: (fn) => fn() });
      const count = db2.prepare("SELECT COUNT(*) as c FROM oauth_accounts WHERE provider='github'").get() as {
        c: number;
      };
      expect(count.c).toBe(1);
      db2.close();
    });

    it("skips legacy rows that have neither access nor refresh tokens", () => {
      const db2 = new DatabaseSync(":memory:");
      applyBaseSchema(db2);
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN access_token_enc TEXT");
      db2.exec("ALTER TABLE oauth_credentials ADD COLUMN refresh_token_enc TEXT");
      db2
        .prepare(
          `INSERT INTO oauth_credentials (provider, encrypted_data, access_token_enc, refresh_token_enc)
           VALUES ('google_antigravity', 'blob', NULL, NULL)`,
        )
        .run();
      initializeOAuthRuntime({ db: db2, nowMs: () => 1, runInTransaction: (fn) => fn() });
      const count = db2
        .prepare("SELECT COUNT(*) as c FROM oauth_accounts WHERE provider='google_antigravity'")
        .get() as { c: number };
      expect(count.c).toBe(0);
      db2.close();
    });
  });

  describe("oauth_active_accounts composite-PK migration", () => {
    it("upgrades a legacy single-PK table to composite (provider, account_id)", () => {
      const db2 = new DatabaseSync(":memory:");
      applyBaseSchema(db2);
      // Seed a real account so the legacy active row's FK target exists after migration.
      insertAccount(db2, { id: "legacy-id", provider: "github" });
      db2.exec("DROP TABLE oauth_active_accounts");
      db2.exec(`
        CREATE TABLE oauth_active_accounts (
          provider TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          updated_at INTEGER
        )
      `);
      db2.prepare("INSERT INTO oauth_active_accounts VALUES ('github', 'legacy-id', 5000)").run();
      initializeOAuthRuntime({ db: db2, nowMs: () => 6000, runInTransaction: (fn) => fn() });
      const cols = db2.prepare("PRAGMA table_info(oauth_active_accounts)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const providerCol = cols.find((c) => c.name === "provider");
      const accountCol = cols.find((c) => c.name === "account_id");
      expect(providerCol?.pk).toBe(1);
      expect(accountCol?.pk).toBe(2);
      db2.close();
    });
  });
});
