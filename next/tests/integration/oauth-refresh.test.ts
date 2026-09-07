import { it, expect } from "vitest";
import https from "node:https";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OAuthTokenBroker, type OAuthConfiguration } from "../../packages/integrations/src/oauth.ts";
const ca = fileURLToPath(new URL("./worker-fixtures/cert.pem", import.meta.url));
async function fixture(handler: (form: URLSearchParams, res: import("node:http").ServerResponse) => void) {
  let requests = 0;
  const server = https.createServer(
    { key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)), cert: await readFile(ca) },
    (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests++;
        expect(req.method).toBe("POST");
        handler(new URLSearchParams(body), res);
      });
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(tmpdir(), "oauth-refresh-"));
  const ref = (field: string) => ({ provider: "proton-pass" as const, shareId: "test", itemId: "test", field });
  const config: OAuthConfiguration = {
    id: randomUUID(),
    tokenEndpoint: `https://127.0.0.1:${(server.address() as { port: number }).port}/token`,
    clientId: "test-client",
    clientAuthentication: "client_secret_post",
    clientSecretRef: ref("client"),
    refreshTokenRef: ref("refresh"),
    encryptionKeyRef: ref("key"),
    scopes: ["mail.read"],
    tlsCaFile: ca,
  };
  const secrets = {
    resolve: async (r: { field: string }) =>
      r.field === "key"
        ? Buffer.alloc(32, 7).toString("base64")
        : r.field === "refresh"
          ? "refresh-old"
          : "client-secret",
  };
  const context = {
    scope: { companyId: randomUUID(), areaId: randomUUID() },
    connectionId: randomUUID(),
    reason: "OAuth fixture",
    generation: null,
    authorize: async () => {},
  };
  return {
    config,
    context,
    directory,
    secrets,
    get requests() {
      return requests;
    },
    broker: (now = Date.now()) => new OAuthTokenBroker({ directory, secrets, now: () => now }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("serializes concurrent TLS refresh, persists encrypted rotation and reuses the rotated token after restart", async () => {
  const seen: string[] = [];
  const f = await fixture((form, res) => {
    seen.push(form.get("refresh_token")!);
    expect(form.get("client_secret")).toBe("client-secret");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        access_token: "access-" + seen.length,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-new",
        scope: "mail.read",
      }),
    );
  });
  try {
    const now = Date.now(),
      broker = f.broker(now);
    expect(await Promise.all(Array.from({ length: 12 }, () => broker.accessToken(f.config, f.context)))).toEqual(
      Array(12).fill("access-1"),
    );
    expect(f.requests).toBe(1);
    expect(await f.broker(now + 1000).accessToken(f.config, f.context)).toBe("access-1");
    expect(await f.broker(now + 3600000).accessToken(f.config, f.context)).toBe("access-2");
    expect(seen).toEqual(["refresh-old", "refresh-new"]);
    const stored = (
      await Promise.all((await readdir(f.directory)).map((p) => readFile(path.join(f.directory, p), "utf8")))
    ).join("");
    for (const secret of ["refresh-old", "refresh-new", "access-1", "access-2", "client-secret"])
      expect(stored).not.toContain(secret);
    await expect(f.broker().accessToken({ ...f.config, clientId: "changed" }, f.context)).rejects.toMatchObject({
      code: "auth",
    });
    expect(f.requests).toBe(2);
  } finally {
    await f.close();
  }
});
it("does not retry an ambiguous refresh after restart or expose provider secrets", async () => {
  const f = await fixture((_form, res) => {
    res.destroy();
  });
  try {
    await expect(f.broker().accessToken(f.config, f.context)).rejects.toMatchObject({ code: "auth" });
    await expect(f.broker().accessToken(f.config, f.context)).rejects.toThrow("keine automatische Wiederholung");
    expect(f.requests).toBe(1);
  } finally {
    await f.close();
  }
});
it("rejects TLS trust failures, invalid grants, redirects and unexpected scopes without leaking response bodies", async () => {
  for (const mode of ["tls", "invalid", "redirect", "scope"]) {
    const f = await fixture((_form, res) => {
      res.statusCode = mode === "invalid" ? 400 : mode === "redirect" ? 302 : 200;
      res.setHeader("location", "https://example.invalid/stolen");
      res.end(
        JSON.stringify(
          mode === "scope"
            ? {
                access_token: "provider-secret",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "mail.read administrator",
              }
            : { error: "invalid_grant", error_description: "refresh-old client-secret provider-secret" },
        ),
      );
    });
    try {
      const config = mode === "tls" ? { ...f.config, tlsCaFile: undefined } : f.config;
      const error = await f
        .broker()
        .accessToken(config, f.context)
        .catch((e) => e);
      expect(error).toMatchObject({ code: "auth" });
      expect(String(error)).not.toMatch(/refresh-old|client-secret|provider-secret/);
      await expect(f.broker().accessToken(config, f.context)).rejects.toMatchObject({ code: "auth" });
      expect(f.requests).toBe(mode === "tls" ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});
it("checks every caller authority after shared refresh and persists rotation despite revoked initiating access", async () => {
  let revoked = false;
  const f = await fixture((_form, res) => {
    revoked = true;
    res.end(
      JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
  });
  try {
    const broker = f.broker(),
      context = {
        ...f.context,
        authorize: async () => {
          if (revoked) throw Error("revoked");
        },
      };
    await expect(broker.accessToken(f.config, context)).rejects.toThrow("revoked");
    expect(await broker.accessToken(f.config, f.context)).toBe("access-new");
    expect(f.requests).toBe(1);
  } finally {
    await f.close();
  }
});
it("invalidates encrypted and absent vault state after restore until the provider profile is explicitly reauthorized", async () => {
  const f = await fixture((_form, res) =>
    res.end(JSON.stringify({ access_token: "access-ready", token_type: "Bearer", expires_in: 3600 })),
  );
  try {
    await f.broker().accessToken(f.config, f.context);
    const restored = { ...f.context, generation: randomUUID() };
    await expect(f.broker().accessToken(f.config, restored)).rejects.toMatchObject({ code: "auth" });
    await rm(f.directory, { recursive: true, force: true });
    await expect(f.broker().accessToken(f.config, restored)).rejects.toMatchObject({ code: "auth" });
    expect(f.requests).toBe(1);
    await expect(
      f.broker().accessToken({ ...f.config, id: randomUUID(), authorizedGeneration: restored.generation }, restored),
    ).resolves.toBe("access-ready");
    expect(f.requests).toBe(2);
  } finally {
    await f.close();
  }
});
it("a second broker cannot race a refresh-token rotation and a completed state is reusable", async () => {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture((_form, res) => {
    release = () =>
      res.end(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "rotated",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    started();
  });
  try {
    const first = f.broker().accessToken(f.config, f.context);
    await arrived;
    await expect(f.broker().accessToken(f.config, f.context)).rejects.toMatchObject({ code: "conflict" });
    release();
    expect(await first).toBe("access-new");
    expect(await f.broker().accessToken(f.config, f.context)).toBe("access-new");
    expect(f.requests).toBe(1);
  } finally {
    release();
    await f.close();
  }
});
it("supplies refreshed bearer tokens to an actual configured Graph HTTP request without returning credentials", async () => {
  const { createServer } = await import("node:http"),
    { IntegrationService } = await import("../../packages/integrations/src/service.ts");
  const f = await fixture((_form, res) =>
    res.end(
      JSON.stringify({
        access_token: "resource-token",
        refresh_token: "rotated-resource",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    ),
  );
  let reads = 0;
  let resourceAuthorization: string | undefined, resourceUrl: string | undefined;
  const resource = createServer((req, res) => {
    resourceAuthorization = req.headers.authorization;
    resourceUrl = req.url;
    reads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: [{ id: "fixture-user" }] }));
  });
  await new Promise<void>((resolve) => resource.listen(0, "127.0.0.1", resolve));
  try {
    const id = randomUUID(),
      service = new IntegrationService({
        connections: [
          {
            id,
            scope: f.context.scope,
            provider: "graph",
            baseUrl: `http://127.0.0.1:${(resource.address() as { port: number }).port}`,
            allowHttp: true,
            oauth: f.config,
            enabledTools: ["graph.users.read"],
            schemaTag: "local-fixture",
          },
        ],
        secrets: f.secrets,
        oauth: f.broker(),
        oauthGeneration: async () => null,
        authorize: async () => {},
      });
    const result = await service.execute({
      id: randomUUID(),
      targetId: id,
      scope: f.context.scope,
      toolId: "graph.users.read",
      args: {},
    });
    expect(result.effectStatus).toBe("succeeded");
    expect(reads).toBe(1);
    expect(resourceAuthorization).toBe("Bearer resource-token");
    expect(resourceUrl?.split("?")[0]).toBe("/users");
    expect(f.requests).toBe(1);
    expect(JSON.stringify(result)).not.toContain("resource-token");
  } finally {
    resource.closeAllConnections();
    await new Promise<void>((resolve) => resource.close(() => resolve()));
    await f.close();
  }
});
