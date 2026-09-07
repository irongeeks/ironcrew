import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {
  IntegrationService,
  toolCapabilities,
  type IntegrationConnection,
} from "../../packages/integrations/src/service.ts";
let server: Server, service: IntegrationService, connections: IntegrationConnection[];
let seen: { method: string; path: string; headers: Record<string, unknown> }[],
  version: string,
  changed: boolean,
  conflict: boolean,
  native: boolean;
const scope = { companyId: randomUUID(), areaId: randomUUID() };
const bytes = Buffer.from([0, 255, 128, 13, 10]);
beforeEach(async () => {
  seen = [];
  version = "7";
  changed = false;
  conflict = false;
  native = false;
  server = createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, headers: req.headers });
    const u = new URL(req.url!, "http://fixture");
    if (req.method === "MKCOL" || req.method === "MOVE") return void res.writeHead(conflict ? 412 : 201).end();
    if (u.pathname.endsWith("/revisions"))
      return void res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify({ revisions: [{ id: "rev-1", size: "5" }], nextPageToken: "cursor+2" }));
    if (u.searchParams.get("alt") === "media") {
      if (changed) version = "8";
      return void res.end(bytes);
    }
    res.setHeader("content-type", "application/json").end(
      JSON.stringify({
        id: "file-1",
        version,
        mimeType: native ? "application/vnd.google-apps.document" : "application/octet-stream",
        size: "5",
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  connections = ["nextcloud", "gdrive"].map((provider) => ({
    id: randomUUID(),
    scope,
    provider: provider as "nextcloud" | "gdrive",
    baseUrl,
    allowHttp: true,
    username: "tester",
    rootPath: "permitted",
    resourceIds: ["file-1"],
    enabledTools:
      provider === "nextcloud" ? ["nextcloud.mkdir", "nextcloud.move"] : ["gdrive.download", "gdrive.revisions.read"],
    schemaTag: "fixture",
    secretRef: { provider: "proton-pass", shareId: "s", itemId: "i", field: "password" },
  }));
  service = new IntegrationService({
    connections,
    secrets: { resolve: async () => "fixture-secret" },
    authorize: async () => {},
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const execute = (toolId: string, args: unknown, override = scope) =>
  service.execute({
    id: randomUUID(),
    toolId,
    targetId: connections[toolId.startsWith("gdrive") ? 1 : 0]!.id,
    scope: override,
    args,
  });
it("creates and moves only beneath the configured DAV root with source CAS and destination overwrite forbidden", async () => {
  await execute("nextcloud.mkdir", { path: "reports" });
  const moved = await execute("nextcloud.move", {
    path: "report.md",
    destinationPath: "reports/new name.md",
    expectedEtag: '"v7"',
  });
  expect(seen[0]!.method).toBe("MKCOL");
  expect(seen[0]!.path).toBe("/remote.php/dav/files/tester/permitted/reports");
  expect(seen[1]!.headers["if-match"]).toBe('"v7"');
  expect(seen[1]!.headers.overwrite).toBe("F");
  expect(moved.externalId).toBe(seen[1]!.headers.destination);
  expect(moved.externalId).toContain("/permitted/reports/new%20name.md");
  conflict = true;
  await expect(
    execute("nextcloud.move", { path: "report.md", destinationPath: "reports/existing.md", expectedEtag: '"old"' }),
  ).rejects.toMatchObject({ effectStatus: "failed" });
  const count = seen.length;
  await expect(
    execute("nextcloud.move", { path: "report.md", destinationPath: "../escape", expectedEtag: '"v7"' }),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(execute("nextcloud.mkdir", { path: "a" }, { ...scope, areaId: randomUUID() })).rejects.toMatchObject({
    code: "authorization",
  });
  expect(seen).toHaveLength(count);
});
it("downloads exact binary bytes only for an allowlisted version and returns bounded hashed evidence", async () => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await execute("gdrive.download", {
    fileId: "file-1",
    expectedVersion: "7",
    expectedSha256: sha256,
    maxBytes: 5,
  });
  expect(result.data).toMatchObject({ bytes: 5, version: "7", sha256, contentBase64: bytes.toString("base64") });
  expect(seen).toHaveLength(3);
  const count = seen.length;
  await expect(execute("gdrive.download", { fileId: "foreign", expectedVersion: "7" })).rejects.toMatchObject({
    code: "authorization",
  });
  expect(seen).toHaveLength(count);
  await expect(
    execute("gdrive.download", { fileId: "file-1", expectedVersion: "7", maxBytes: 4 }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("rejects concurrently changed versions, wrong hashes and native Workspace files", async () => {
  changed = true;
  await expect(execute("gdrive.download", { fileId: "file-1", expectedVersion: "7" })).rejects.toMatchObject({
    code: "conflict",
  });
  changed = false;
  version = "7";
  await expect(
    execute("gdrive.download", { fileId: "file-1", expectedVersion: "7", expectedSha256: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "conflict" });
  native = true;
  await expect(execute("gdrive.download", { fileId: "file-1", expectedVersion: "7" })).rejects.toMatchObject({
    code: "validation",
  });
});
it("exposes explicit retained-history pagination without claiming full revision history", async () => {
  const result = await execute("gdrive.revisions.read", { fileId: "file-1", pageToken: "cursor+1", pageSize: 10 });
  expect(result.data).toMatchObject({
    items: [{ id: "rev-1" }],
    nextCursor: "cursor+2",
    historyCompleteness: "provider_retained_only",
  });
  expect(new URL(seen[0]!.path, "http://fixture").searchParams.get("pageToken")).toBe("cursor+1");
});
it("shares the two-request account limit across separately constructed workflow brokers", async () => {
  let active = 0,
    maximum = 0,
    count = 0;
  server.removeAllListeners("request");
  server.on("request", async (_req, res) => {
    active++;
    count++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 25));
    active--;
    res.writeHead(201).end();
  });
  const secondConnection = { ...connections[0]!, id: randomUUID(), rootPath: "another-scoped-folder" };
  const second = new IntegrationService({
    connections: [secondConnection],
    secrets: { resolve: async () => "fixture-secret" },
    authorize: async () => {},
  });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? execute("nextcloud.mkdir", { path: "folder-" + i })
        : second.execute({
            id: randomUUID(),
            scope,
            targetId: secondConnection.id,
            toolId: "nextcloud.mkdir",
            args: { path: "folder-" + i },
          }),
    ),
  );
  expect(count).toBe(8);
  expect(maximum).toBe(2);
});

it("declares output schemas for every capability and rejects malformed normalized metadata", async () => {
  for (const capability of toolCapabilities) {
    expect(capability.outputSchema).toBeDefined();
    expect(capability.outputSchema.safeParse({ effectStatus: "succeeded", evidenceRefs: [], data: null }).success).toBe(
      false,
    );
  }
  const connection = { ...connections[1]!, enabledTools: ["gdrive.read"] };
  const malformed = new IntegrationService({
    connections: [connection],
    secrets: { resolve: async () => "fixture-secret" },
    authorize: async () => {},
    transport: async () => ({ status: 200, headers: {}, body: Buffer.from('{"id":42,"version":"7"}') }),
  });
  await expect(
    malformed.execute({
      id: randomUUID(),
      scope,
      targetId: connection.id,
      toolId: "gdrive.read",
      args: { fileId: "file-1" },
    }),
  ).rejects.toMatchObject({ code: "provider", effectStatus: "failed" });
});
