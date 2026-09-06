import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response, RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { UtilContext } from "../../../../types/runtime-context-domains.ts";
import { registerUpdateAutoRoutes } from "./register.ts";

vi.mock("../../../../security/auth.ts", () => ({
  isAuthenticated: (request: Request) => request.headers.authorization === "Bearer test-owner",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function harness(options: { setting?: string; companyLocale?: string } = {}) {
  const routes = new Map<string, RequestHandler[]>();
  const get = vi.fn((path: string, ...handlers: RequestHandler[]) => routes.set(`GET ${path}`, handlers));
  const post = vi.fn((path: string, ...handlers: RequestHandler[]) => routes.set(`POST ${path}`, handlers));
  const prepare = vi.fn((sql: string) => ({
    get: vi.fn(() => {
      if (sql.includes("FROM settings")) return options.setting === undefined ? undefined : { value: options.setting };
      if (sql.includes("sqlite_master")) return options.companyLocale ? { exists: 1 } : undefined;
      if (sql.includes("FROM crew_companies")) return { id: "company", locale: options.companyLocale };
      return undefined;
    }),
  }));
  const interval = vi.spyOn(globalThis, "setInterval");
  vi.stubEnv("IRONCREW_INSTALL_TYPE", "native");
  vi.stubEnv("UPDATE_CHECK_ENABLED", "1");
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new globalThis.Response(JSON.stringify({ tag_name: "v99.0.0", draft: false, prerelease: false })),
    );
  vi.stubGlobal("fetch", fetcher);
  registerUpdateAutoRoutes(
    {
      app: { get, post } as unknown as Express,
      db: { prepare } as unknown as DatabaseSync,
      dbPath: ":memory:",
      activeProcesses: new Map(),
    },
    {} as UtilContext,
  );
  const request = async (
    method: string,
    path: string,
    authenticated = true,
    body = {},
    query: Record<string, string> = {},
  ) => {
    let statusCode = 200;
    let payload: unknown;
    const response = {
      status: (value: number) => {
        statusCode = value;
        return response;
      },
      json: (value: unknown) => {
        payload = value;
        return response;
      },
    };
    const req = { headers: authenticated ? { authorization: "Bearer test-owner" } : {}, query, body } as Request;
    const handlers = routes.get(`${method} ${path}`)!;
    for (const handler of handlers) {
      let nextCalled = false;
      await handler(req, response as unknown as Response, () => {
        nextCalled = true;
      });
      if (!nextCalled) break;
    }
    return { statusCode, payload };
  };
  return { request, fetcher, prepare, interval };
}

describe("release update routes", () => {
  it("authenticates discovery and legacy mutation endpoints before fetching", async () => {
    const app = harness();
    for (const [method, path] of [
      ["GET", "/api/update-status"],
      ["GET", "/api/update-auto-status"],
      ["POST", "/api/update-apply"],
      ["POST", "/api/update-auto-config"],
    ]) {
      expect(await app.request(method, path, false)).toEqual({
        statusCode: 401,
        payload: { ok: false, error: "unauthorized" },
      });
    }
    expect(app.fetcher).not.toHaveBeenCalled();
  });
  it("never enables legacy scheduled or forced self-update, including persisted flags", async () => {
    vi.stubEnv("AUTO_UPDATE_ENABLED", "1");
    vi.stubEnv("AUTO_UPDATE_TARGET_BRANCH", "main");
    vi.stubEnv("AUTO_UPDATE_ALLOW_MAJOR", "1");
    const app = harness();
    for (const path of ["/api/update-apply", "/api/update-auto-config"]) {
      expect(
        await app.request("POST", path, true, { enabled: true, force: true, dry_run: false, branch: "main" }),
      ).toMatchObject({
        statusCode: 409,
        payload: {
          error: "manual_update_required",
          update_status: { self_update_supported: false, latest_tag: "v99.0.0" },
        },
      });
    }
    expect(await app.request("GET", "/api/update-auto-status")).toMatchObject({
      statusCode: 200,
      payload: {
        auto_update: { enabled: false, scheduler_ready: false, reason: "manual_update_required" },
        runtime: { running: false, next_check_at: null },
      },
    });
    expect(app.prepare.mock.calls.every(([sql]) => sql.startsWith("SELECT "))).toBe(true);
    expect(app.interval).not.toHaveBeenCalled();
  });
  it("exposes the installed version, stable release, and host preflight to authenticated users", async () => {
    const app = harness();
    expect(await app.request("GET", "/api/update-status")).toMatchObject({
      statusCode: 200,
      payload: {
        ok: true,
        current_version: expect.any(String),
        install_type: "native",
        repo: "irongeeks/ironcrew",
        channel: "stable",
        instructions: { command: "node scripts/ironcrew-update.mjs --to v99.0.0 --check" },
      },
    });
  });
});

describe("release response language", () => {
  it("localizes each response independently while sharing release discovery", async () => {
    const app = harness({ setting: '"de"' });
    const german = await app.request("GET", "/api/update-status");
    const english = await app.request("GET", "/api/update-status", true, {}, { language: "en" });
    const germanAgain = await app.request("GET", "/api/update-status");
    expect(german.payload).toMatchObject({
      instructions: {
        steps: expect.arrayContaining(["Nach der Aktualisierung Version, Systemzustand und laufende Aufgaben prüfen."]),
      },
    });
    expect(english.payload).toMatchObject({
      instructions: {
        steps: expect.arrayContaining(["After the update, check the version, system health and running tasks."]),
      },
    });
    expect(germanAgain.payload).toEqual(german.payload);
    expect(app.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ setting: "de" }, "de"],
    [{ companyLocale: "de-DE" }, "de"],
    [{ setting: '"en"', companyLocale: "de" }, "en"],
    [{ setting: "ja", companyLocale: "de" }, "en"],
    [{}, "en"],
  ] as const)("uses supported saved or company language %j", async (options, language) => {
    const app = harness(options);
    const response = await app.request("POST", "/api/update-apply");
    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      message:
        language === "de"
          ? "IronCrew aktualisiert sich nicht aus dem laufenden Webprozess. Bitte den Host-Update-Assistenten für ein stabiles Release verwenden."
          : "IronCrew does not update itself from the running web process. Use the host update assistant for a stable release.",
    });
  });
});
