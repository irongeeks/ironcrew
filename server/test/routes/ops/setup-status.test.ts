import { describe, it, expect } from "vitest";

import {
  checkSecret,
  deriveOverallStatus,
  registerSetupStatusRoutes,
} from "../../../modules/routes/ops/setup-status.ts";

describe("checkSecret", () => {
  it("accepts injected runtime secrets without an env file", () => {
    expect(checkSecret("", "MY_SECRET", { MY_SECRET: "injected-value" })).toEqual({ ok: true });
    expect(checkSecret("", "MY_SECRET", { MY_SECRET: "__CHANGE_ME__" }).ok).toBe(false);
  });

  it("returns ok for a valid secret value", () => {
    const env = "OAUTH_ENCRYPTION_SECRET=supersecretvalue123\nINBOX_WEBHOOK_SECRET=anothersecret";
    expect(checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {})).toEqual({ ok: true });
    expect(checkSecret(env, "INBOX_WEBHOOK_SECRET", {})).toEqual({ ok: true });
  });

  it("returns not ok for __CHANGE_ME__ placeholder", () => {
    const env = "OAUTH_ENCRYPTION_SECRET=__CHANGE_ME__";
    const result = checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("OAUTH_ENCRYPTION_SECRET");
  });

  it("returns not ok when key is missing", () => {
    const env = "OTHER_KEY=somevalue";
    const result = checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not found");
  });

  it("returns not ok when value is empty string", () => {
    const env = "OAUTH_ENCRYPTION_SECRET=";
    const result = checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("OAUTH_ENCRYPTION_SECRET");
  });

  it("returns not ok when value is whitespace only", () => {
    const env = "OAUTH_ENCRYPTION_SECRET=   ";
    const result = checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {});
    expect(result.ok).toBe(false);
  });

  it("strips surrounding quotes when checking value", () => {
    const envSingle = "MY_SECRET='realvalue'";
    expect(checkSecret(envSingle, "MY_SECRET")).toEqual({ ok: true });

    const envDouble = 'MY_SECRET="realvalue"';
    expect(checkSecret(envDouble, "MY_SECRET")).toEqual({ ok: true });
  });

  it("returns not ok for quoted __CHANGE_ME__", () => {
    const env = "OAUTH_ENCRYPTION_SECRET='__CHANGE_ME__'";
    const result = checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {});
    expect(result.ok).toBe(false);
  });

  it("handles multiple keys in the same env string", () => {
    const env = ["FOO=bar", "OAUTH_ENCRYPTION_SECRET=myrealtoken", "INBOX_WEBHOOK_SECRET=__CHANGE_ME__"].join("\n");
    expect(checkSecret(env, "OAUTH_ENCRYPTION_SECRET", {})).toEqual({ ok: true });
    expect(checkSecret(env, "INBOX_WEBHOOK_SECRET", {}).ok).toBe(false);
  });
});

describe("deriveOverallStatus", () => {
  const allRequiredPassing: Record<string, { ok: boolean }> = {
    database: { ok: true },
    encryption_secret: { ok: true },
    webhook_secret: { ok: true },
    agents_seeded: { ok: true },
    departments_seeded: { ok: true },
    cli_provider_configured: { ok: true },
  };

  it("returns required_ok true when all required checks pass", () => {
    const result = deriveOverallStatus(allRequiredPassing);
    expect(result.required_ok).toBe(true);
  });

  it("returns optional_ok true when all checks pass (required + optional)", () => {
    const checks = {
      ...allRequiredPassing,
      api_key_configured: { ok: true },
      oauth_configured: { ok: true },
      agents_md_injected: { ok: true },
    };
    const result = deriveOverallStatus(checks);
    expect(result.required_ok).toBe(true);
    expect(result.optional_ok).toBe(true);
  });

  it("returns required_ok false when one required check fails", () => {
    const checks = {
      ...allRequiredPassing,
      database: { ok: false },
    };
    const result = deriveOverallStatus(checks);
    expect(result.required_ok).toBe(false);
  });

  it("returns optional_ok false when an optional check fails but required pass", () => {
    const checks = {
      ...allRequiredPassing,
      api_key_configured: { ok: false },
    };
    const result = deriveOverallStatus(checks);
    expect(result.required_ok).toBe(true);
    expect(result.optional_ok).toBe(false);
  });

  it("returns both false when required and optional checks fail", () => {
    const checks = {
      ...allRequiredPassing,
      encryption_secret: { ok: false },
      api_key_configured: { ok: false },
    };
    const result = deriveOverallStatus(checks);
    expect(result.required_ok).toBe(false);
    expect(result.optional_ok).toBe(false);
  });

  it("handles empty checks object — all required missing means required_ok false", () => {
    const result = deriveOverallStatus({});
    expect(result.required_ok).toBe(false);
    expect(result.optional_ok).toBe(true); // no values to fail
  });

  it("returns required_ok false when agents_seeded is missing from checks", () => {
    const { agents_seeded: _omit, ...rest } = allRequiredPassing;
    const result = deriveOverallStatus(rest);
    expect(result.required_ok).toBe(false);
  });
});

describe("setup status runtime credentials", () => {
  it("recognizes authenticated OpenRouter runtimes without stored API keys", async () => {
    let handler: any;
    const app = {
      locals: {
        ironCrewRuntimes: () => [
          { type: "openrouter", authStatus: async () => ({ authenticated: true, method: "api-key" }) },
        ],
      },
      get: (_path: string, fn: unknown) => {
        handler = fn;
      },
    };
    const db = { prepare: () => ({ get: () => ({ cnt: 0, value: "claude" }) }) };
    registerSetupStatusRoutes({ app, db } as any);
    let payload: any;
    await handler(
      {},
      {
        json: (body: unknown) => {
          payload = body;
        },
      },
    );
    expect(payload.checks.api_key_configured).toEqual({
      ok: true,
      detail: "Runtime credentials configured: openrouter",
    });
  });
});
