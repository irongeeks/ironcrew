import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ALLOWED_SETTING_KEYS, registerOpsSettingsStatsRoutes } from "./settings-stats.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: any;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🏢',
      color TEXT NOT NULL DEFAULT '#64748b',
      description TEXT,
      prompt TEXT,
      sort_order INTEGER NOT NULL DEFAULT 99,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT,
      role TEXT NOT NULL DEFAULT 'senior',
      acts_as_planning_leader INTEGER NOT NULL DEFAULT 0,
      cli_provider TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      personality TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      sprite_number INTEGER,
      cli_model TEXT,
      cli_reasoning_level TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      department_id TEXT,
      title TEXT,
      updated_at INTEGER,
      assigned_agent_id TEXT
    );
    CREATE TABLE task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function createHarness(db: DatabaseSync) {
  const getRoutes = new Map<string, RouteHandler>();
  const putRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    put(path: string, handler: RouteHandler) {
      putRoutes.set(path, handler);
      return this;
    },
  };

  registerOpsSettingsStatsRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    broadcast: () => {},
  } as any);

  return { getRoutes, putRoutes };
}

describe("PUT /api/settings allowlist (T-004, #81)", () => {
  it("accepts allowed keys and persists them to the settings table", () => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");
      expect(putHandler).toBeTypeOf("function");

      const res = createFakeResponse();
      putHandler?.(
        {
          body: {
            companyName: "Acme",
            theme: "dark",
            autoAssign: true,
            officeWorkflowPack: "development",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ ok: true });

      const companyName = db.prepare("SELECT value FROM settings WHERE key = 'companyName'").get() as
        | { value: string }
        | undefined;
      const theme = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get() as { value: string } | undefined;
      // String values are stored verbatim (no JSON-quoting); non-strings are JSON-encoded.
      expect(companyName?.value).toBe("Acme");
      expect(theme?.value).toBe("dark");
      const autoAssign = db.prepare("SELECT value FROM settings WHERE key = 'autoAssign'").get() as
        | { value: string }
        | undefined;
      expect(autoAssign?.value).toBe("true");
    } finally {
      db.close();
    }
  });

  it("rejects an unknown key with 400 unknown_setting_key and writes nothing", () => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");

      // Snapshot row count before request (the harness sets the seed-init flag at register time).
      const before = (db.prepare("SELECT COUNT(*) AS c FROM settings").get() as { c: number }).c;

      const res = createFakeResponse();
      putHandler?.(
        {
          body: {
            companyName: "Acme",
            totally_made_up_key: "x",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ ok: false, error: "unknown_setting_key", key: "totally_made_up_key" });

      // Allowed key from the same payload must NOT be persisted: rejection is all-or-nothing.
      const after = (db.prepare("SELECT COUNT(*) AS c FROM settings").get() as { c: number }).c;
      expect(after).toBe(before);
      const companyRow = db.prepare("SELECT value FROM settings WHERE key = 'companyName'").get();
      expect(companyRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects sensitive key access_password_hash with 400", () => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");

      const res = createFakeResponse();
      putHandler?.({ body: { access_password_hash: "attacker-controlled-hash" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload?.error).toBe("unknown_setting_key");
      expect(res.payload?.key).toBe("access_password_hash");

      const row = db.prepare("SELECT value FROM settings WHERE key = 'access_password_hash'").get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects other internal keys (mcp_servers, telegramReceiverOffset, remote_session:*)", () => {
    const internalKeys = [
      "mcp_servers",
      "telegramReceiverOffset",
      "discordReceiverCursor",
      "connector_capability_bindings",
      "ceo_model",
      "remote_session:abc123",
      "officePackSeedAgentsInitialized",
    ];

    for (const key of internalKeys) {
      const db = setupDb();
      try {
        const { putRoutes } = createHarness(db);
        const putHandler = putRoutes.get("/api/settings");

        const res = createFakeResponse();
        putHandler?.({ body: { [key]: "x" } }, res);

        expect(res.statusCode, `expected ${key} to be rejected`).toBe(400);
        expect(res.payload?.error).toBe("unknown_setting_key");
      } finally {
        db.close();
      }
    }
  });

  it("GET /api/settings filters out non-allowlisted (internal/sensitive) keys", () => {
    // T-004 review #2: GET must not leak internal keys, AND must not return keys
    // that PUT will reject — otherwise the round-trip GET→save fails the e2e flow.
    const db = setupDb();
    try {
      const { getRoutes } = createHarness(db);
      const getHandler = getRoutes.get("/api/settings");
      expect(getHandler).toBeTypeOf("function");

      // Pre-populate a mix of allowed and internal keys.
      const insert = db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      insert.run("companyName", "Acme");
      insert.run("theme", "dark");
      insert.run("access_password_hash", "scrypt$leak-me");
      insert.run("mcp_servers", "[]");
      insert.run("remote_session:abc123", "secret-cookie");
      insert.run("telegramReceiverOffset", "42");
      insert.run("ceo_model", "internal");
      insert.run("connector_capability_bindings", "{}");

      const res = createFakeResponse();
      getHandler?.({}, res);

      expect(res.statusCode).toBe(200);
      const settings = (res.payload as { settings: Record<string, unknown> }).settings;

      expect(settings.companyName).toBe("Acme");
      expect(settings.theme).toBe("dark");

      for (const internalKey of [
        "access_password_hash",
        "mcp_servers",
        "remote_session:abc123",
        "telegramReceiverOffset",
        "ceo_model",
        "connector_capability_bindings",
      ]) {
        expect(
          Object.prototype.hasOwnProperty.call(settings, internalKey),
          `expected GET to omit internal key ${internalKey}`,
        ).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("rejects non-object bodies with 400 invalid_body", () => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");

      const res = createFakeResponse();
      putHandler?.({ body: ["companyName", "Acme"] }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload?.error).toBe("invalid_body");
    } finally {
      db.close();
    }
  });

  it("ALLOWED_SETTING_KEYS contains every key produced by mergeSettingsWithDefaults({})", () => {
    // Regression guard (T-004 review #2): the frontend round-trip is
    //   GET /api/settings → mergeSettingsWithDefaults(sett) → PUT /api/settings.
    // mergeSettingsWithDefaults spreads DEFAULT_SETTINGS first, so every default key
    // ends up on the body. Any DEFAULT_SETTINGS key missing from the allowlist would
    // make the entire PUT fail with 400 (silently breaking the General tab and others).
    //
    // We mirror the DEFAULT_SETTINGS keys from src/types/index.ts here rather than
    // importing it directly: src/i18n.ts (a transitive dep of src/types) references
    // `window`, which the server tsconfig (no DOM lib) cannot compile. If you add a
    // field to DEFAULT_SETTINGS, add it to BOTH this list and ALLOWED_SETTING_KEYS.
    const defaultSettingsKeys = [
      "companyName",
      "ceoName",
      "autoAssign",
      "yoloMode",
      "autoUpdateEnabled",
      "autoUpdateNoticePending",
      "oauthAutoSwap",
      "theme",
      "language",
      "defaultProvider",
      "officeWorkflowPack",
      "defaultProjectPath",
      "apiRequestTimeoutMs",
      "taskExecutionTimeoutMs",
      "autoUpdateCheckIntervalMin",
      "providerModelConfig",
      "messengerChannels",
      "officePackProfiles",
      "departmentRoomAssignments",
      "autonomousMode",
      "autonomousMaxConcurrent",
      "ceoOrchestratorEnabled",
      "ceoOrchestratorIntervalMs",
      "ceoOrchestratorModel",
    ];
    for (const key of defaultSettingsKeys) {
      expect(ALLOWED_SETTING_KEYS.has(key), `expected allowlist to include DEFAULT_SETTINGS key ${key}`).toBe(true);
    }
  });

  it("ALLOWED_SETTING_KEYS contains all CompanySettings fields the frontend writes", () => {
    // Fields written by the frontend (src/types/index.ts CompanySettings + per-panel patches).
    const required = [
      "companyName",
      "ceoName",
      "autoAssign",
      "yoloMode",
      "autoUpdateEnabled",
      "autoUpdateNoticePending",
      "oauthAutoSwap",
      "theme",
      "language",
      "defaultProvider",
      "officeWorkflowPack",
      "defaultProjectPath",
      "apiRequestTimeoutMs",
      "taskExecutionTimeoutMs",
      "autoUpdateCheckIntervalMin",
      "providerModelConfig",
      "roomThemes",
      "messengerChannels",
      "officePackProfiles",
      "officePackHydratedPacks",
      "departmentRoomAssignments",
      "knowledgeAutoBindDefault",
      "autonomousMode",
      "autonomousMaxConcurrent",
      "ceoOrchestratorEnabled",
      "ceoOrchestratorIntervalMs",
      "ceoOrchestratorModel",
      "onboarding_completed",
      "comfyui_server_url",
      "observability_config",
      "github_oauth_client_id",
    ];
    for (const key of required) {
      expect(ALLOWED_SETTING_KEYS.has(key), `expected allowlist to include ${key}`).toBe(true);
    }
  });
});
