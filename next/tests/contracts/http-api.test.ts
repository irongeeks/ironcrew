import { beforeEach, afterEach, afterAll, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:https";
import type { Server } from "node:http";
import { WorkerServer } from "../../apps/control/worker-server.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { configSchema } from "../../apps/control/configuration.ts";
import { contracts, contractFor } from "../../apps/control/api-contracts/registry.ts";
import { error } from "../../apps/control/api-contracts/common.ts";
import { assertRouteCoverage, generateOpenAPI } from "../../scripts/openapi.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
let server: Server,
  cookie: string,
  directory: string,
  repo: Repository,
  app: ReturnType<typeof createApp>,
  agent: ReturnType<typeof request.agent>,
  csrf: string,
  scope: Scope,
  setup: SetupResult;
const covered = new Set<string>();
beforeEach(async () => {
  csrf = "";
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-contract-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  agent = request.agent(server);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
async function call(
  method: "get" | "post" | "patch" | "put" | "delete",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  status = 200,
) {
  const contract = contractFor(method, "/api/v1" + url);
  expect(contract, `${method} ${url} has an explicit contract`).toBeDefined();
  if (body !== undefined && status === 200 && contract!.input) {
    const valid = contract!.input.safeParse(body);
    expect(valid.success, `${method} ${url} input: ${valid.success ? "" : valid.error.message}`).toBe(true);
  }
  let req = agent[method]("/api/v1" + url);
  if (csrf && method !== "get") req = req.set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() });
  req = req.set(headers);
  if (body !== undefined) req = req.send(body as object);
  const response = await req;
  expect(response.status, `${method} ${url}: ${JSON.stringify(response.body)}`).toBe(status);
  const schema = status === 200 ? contract!.output : error;
  if (schema && (contract!.media ?? "application/json") === "application/json") {
    const parsed = schema.safeParse(response.body);
    expect(
      parsed.success,
      `${method} ${url} response: ${parsed.success ? "" : parsed.error.message}\n${JSON.stringify(response.body)}`,
    ).toBe(true);
    if (parsed.success)
      expect(parsed.data, `${method} ${url} must preserve the entire actual response`).toEqual(response.body);
  }
  if (status === 200) covered.add(method + " " + contract!.path);
  return response;
}
async function initialize() {
  const token = await issueSetupToken(directory);
  await call("get", "/health");
  await call("get", "/session");
  await call("get", "/setup", undefined, { "X-Setup-Token": token });
  const created = await call("post", "/setup", {
    token,
    companyName: "Wire contract fixture",
    ceoName: "Local CEO",
    password: "fixture-contract-password",
    timezone: "UTC",
    locale: "de",
  });
  cookie = created.headers["set-cookie"][0].split(";")[0];
  csrf = created.body.csrfToken;
  setup = created.body;
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
}
async function order(kind = "website") {
  return (
    await call("post", "/orders", {
      scope,
      kind,
      goal: "Local contract fixture " + kind,
      budgetLimitUsdMicros: "0",
      acceptanceCriteria: ["Real persisted evidence"],
    })
  ).body;
}
it("keeps every mounted method and all request/response/media/security contracts synchronized", async () => {
  expect(assertRouteCoverage()).toBe(contracts.length);
  const document = generateOpenAPI();
  expect(JSON.parse(await readFile("docs/openapi.json", "utf8"))).toEqual(document);
  for (const c of contracts) {
    expect(c.output || c.status === 204, `${c.method} ${c.path} response schema`).toBeTruthy();
    const op = document.paths[c.path]![c.method] as { responses: Record<string, unknown>; security: unknown[] };
    expect(op.responses[String(c.status ?? 200)]).toBeDefined();
    if (c.security !== "public") expect(op.security.length).toBeGreaterThan(0);
  }
  const validateRefs = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(validateRefs);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
        const resolved = value
          .slice(2)
          .split("/")
          .reduce<unknown>(
            (parent, key) =>
              parent && typeof parent === "object"
                ? (parent as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")]
                : undefined,
            document,
          );
        expect(resolved, `Resolvable embedded JSON Schema reference ${value}`).toBeDefined();
      } else validateRefs(value);
    }
  };
  validateRefs(document);
  const paths = document.paths as Record<
    string,
    Record<string, { parameters: { name: string }[]; responses: Record<string, unknown> }>
  >;
  expect(paths["/api/v1/orders/{id}/transition"]!.post!.parameters.some((p) => p.name === "If-Match")).toBe(true);
  expect(
    paths["/api/v1/worker-transfers/{jobId}/output/{index}"]!.put!.parameters.some((p) => p.name === "X-CSRF-Token"),
  ).toBe(false);
  expect(paths["/api/v1/orders/{id}/events"]!.get!.responses["200"]).toHaveProperty("content.application/json");
  expect(paths["/api/v1/events"]!.get!.responses["200"]).toHaveProperty("content.text/event-stream");
});
it("validates real setup, settings, profiles, collections, revision and authorization responses", async () => {
  csrf = "";
  await call("get", "/orders", undefined, {}, 401);
  await initialize();
  await call("get", "/session");
  await call("patch", "/setup", { step: 2, data: { locale: "de" } });
  await call("get", "/setup");
  await call("get", "/company");
  await call("patch", "/company", { name: "Updated fixture", locale: "en" }, { "If-Match": "1" });
  await call("patch", "/company", { name: "Conflict" }, { "If-Match": "1" }, 409);
  await call(
    "patch",
    "/employees/" + setup.employees[0]!.id,
    { persona: "Explicit local persona" },
    { "If-Match": "1" },
  );
  await call("post", "/areas", { name: "Contract area", visibility: "private" });
  for (const name of [
    "employees",
    "areas",
    "orders",
    "approvals",
    "workers",
    "integrations",
    "schedules",
    "knowledge",
    "backups",
    "mandates",
    "models",
    "projects",
    "budget",
    "configuration",
    "maintenance",
    "recovery",
    "workers/status",
    "channels/config",
    "channels/bindings",
    "models/ratings",
    "notifications",
    "hosting/profiles",
    "incident/health-profiles",
  ])
    await call("get", "/" + name);
  const policyInput = {
    name: "Legacy policy without automatic application",
    trustedPublicKeyPem: "fixture public key ".repeat(4),
    installDirectory: directory + "-install",
    backupPolicyId: randomUUID(),
    allowedClasses: ["patch"],
    window: { cron: "0 3 * * *", timezone: "UTC", durationMinutes: 30 },
  };
  const policySchema = contractFor("post", "/api/v1/maintenance/update-policies")!.input!;
  const parsedPolicy = policySchema.parse(policyInput) as Record<string, unknown>;
  expect(Object.hasOwn(parsedPolicy, "autoApplyApproved")).toBe(false);
  expect(sha256(parsedPolicy)).toBe(sha256(policyInput));
  expect(policySchema.parse({ ...policyInput, autoApplyApproved: true })).toHaveProperty("autoApplyApproved", true);
  // Explicit repository fixture for an already recorded attempt; no updater is executed here.
  await repo.putDocument(scope, "update-schedule-attempt", randomUUID(), {
    planId: randomUUID(),
    state: "deferred",
    bootId: randomUUID(),
    attemptedAt: new Date().toISOString(),
    retryNotBefore: new Date(Date.now() + 30_000).toISOString(),
    code: "updater_unavailable",
  });
  await call("get", "/maintenance");
  const config = configSchema.parse({ liveExecutionEnabled: false });
  await call("put", "/configuration", config);
  await call("get", "/configuration");
  const now = Date.now();
  await call("post", "/budget", {
    limitUsdMicros: "100",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 3600000).toISOString(),
    renewal: "none",
  });
  await call("put", "/channels/config", { config: { version: 1, channels: [] } }, { "If-Match": "0" });
  await call("post", "/channels/challenge", { provider: "telegram", scope });
  await call("post", "/company/messages", { content: "Local fixture message" });
  await call("get", "/company/messages");
  await repo.putDocument(scope, "recovery-state", scope.companyId, {
    dispatchPaused: true,
    schedulesPaused: true,
    reason: "explicit contract recovery fixture",
  });
  await call("post", "/recovery/resume", { reviewedExternalEffects: true });
  await call("get", "/recovery");
  await call("delete", "/session");
  csrf = "";
  await call("post", "/session", { password: "fixture-contract-password" });
});
it("validates the real website lifecycle, artifact bytes and manual review wire formats", async () => {
  await initialize();
  const created = await order(),
    url = "/orders/" + created.id;
  await call("get", url);
  await call("get", url + "/workflow");
  await call(
    "post",
    url + "/plan",
    { steps: ["Build local static page"], acceptanceCriteria: ["Three documented checks"] },
    { "If-Match": "1" },
  );
  const current = (await call("get", url)).body;
  await call(
    "patch",
    url + "/lead",
    { leadEmployeeId: setup.employees.find((e) => e.seedKey === "web")?.id ?? setup.employees[0]!.id },
    { "If-Match": String(current.revision) },
  );
  await call("post", url + "/messages", { content: "Local request" });
  await call("get", url + "/messages");
  await call("get", url + "/events");
  await call("post", url + "/website", { briefing: "Local static contract", stack: "static" });
  const concepts = (
    await call("post", url + "/website/concepts", {
      concepts: Array.from({ length: 5 }, (_, i) => ({
        name: "Concept " + i,
        rationale: "Explicit fixture",
        html: "<!doctype html><html><body><h1>Contract " + i + "</h1></body></html>",
      })),
    })
  ).body;
  await call("post", url + "/website/select", { conceptId: concepts.data.concepts[0].id });
  const built = (await call("post", url + "/website/build")).body;
  await call("get", url + "/artifacts");
  const pin = (
    await call("post", url + "/website/pins", {
      artifactVersionId: built.id,
      viewport: { width: 390, height: 844 },
      anchor: "h1",
      comment: "Local check",
    })
  ).body;
  await call("get", url + "/website/pins");
  await call("post", url + "/website/pins/" + pin.id + "/resolve", {
    artifactVersionId: built.id,
    evidence: "Inspected current version",
  });
  await call("post", url + "/website/review", {
    artifactVersionId: built.id,
    checks: ["mobile", "functional", "quality"].map((name) => ({
      name,
      passed: true,
      evidence: "Manual local fixture assertion: " + name,
    })),
  });
  await call("get", url + "/reviews");
  await call("post", url + "/website/accept", { artifactVersionId: built.id });
  await call("get", url + "/workflow");
  const archive = await call("get", "/artifacts/" + built.id + "/package");
  expect(archive.headers["content-type"]).toContain("application/gzip");
  expect(archive.headers["x-package-sha256"]).toBe(built.packageSha256);
  const original = await call("get", "/artifacts/" + built.id + "/download");
  expect(original.headers["content-disposition"]).toContain("attachment");
  await call("get", url + "/model-ratings");
});
it("validates original vouchers, source-backed totals, corrections and prepared payments", async () => {
  await initialize();
  const created = await order("finance"),
    url = "/orders/" + created.id;
  const original = Buffer.from("%PDF-1.4\nlocal contract fixture\n%%EOF\n"),
    sha = createHash("sha256").update(original).digest("hex");
  const invoice = {
    id: "invoice-fixture",
    supplierId: "supplier-fixture",
    direction: "payable",
    reference: "Fixture reference",
    currency: "EUR",
    totalMinor: "12000",
    paidMinor: "2000",
    dueAt: new Date(Date.now() - 86400000).toISOString(),
    observedAt: new Date().toISOString(),
    source: "Local immutable original",
    disputed: false,
    paymentPause: false,
  };
  const voucher = (
    await call("post", url + "/finance/vouchers", {
      originalSha256: sha,
      originalBase64: original.toString("base64"),
      mediaType: "application/pdf",
      invoice,
    })
  ).body;
  await call("post", "/finance/snapshot", { invoices: [invoice] });
  await call("get", "/finance");
  await call("post", "/finance/vouchers/" + voucher.voucherId + "/correction", {
    field: "accountDatevId",
    value: 6100,
    source: "Verified original",
    reuse: false,
  });
  expect(
    (await repo.getDocument<{ classificationCorrectionIds: Record<string, string> }>(
      scope,
      "voucher",
      voucher.voucherId,
    ))!.data.classificationCorrectionIds.accountDatevId,
  ).toBeTruthy();
  await call("get", url + "/coordination");
  await call("post", "/finance/vouchers/" + voucher.voucherId + "/payment", {
    recipient: "Local fixture",
    bankAccount: "DE02120300000000202051",
    reference: "Fixture reference",
    amountMinor: "10000",
  });
  const download = await call("get", "/finance/vouchers/" + voucher.voucherId + "/original");
  expect(Buffer.compare(download.body as Buffer, original)).toBe(0);
  await call("get", "/finance");
});
it("validates research artifact/knowledge contracts with immutable local source evidence", async () => {
  await initialize();
  const created = await order("research"),
    url = "/orders/" + created.id;
  // Test-side repository seed is explicit local immutable source evidence, not a mocked HTTP provider response.
  const source = {
    id: randomUUID(),
    title: "Local recorded fixture",
    url: "https://example.invalid/contract",
    observedAt: new Date().toISOString(),
    status: "available",
    contentSha256: createHash("sha256").update("local source").digest("hex"),
    excerpt: "local source",
  };
  await repo.putDocument(scope, "research-source", source.id, source, { immutable: true });
  const report = (
    await call("post", url + "/research", {
      title: "Local report",
      recommendation: "Keep the fixture",
      reasons: [{ text: "Local evidence", sourceIds: [source.id] }],
      comparison: "One fixture",
      methodology: "Explicit source fixture",
      sources: [source],
      assumptions: [],
      gaps: [],
      requiredDelivery: "internal",
    })
  ).body;
  await call("get", url + "/research");
  await call("get", url + "/research/sources");
  await call("get", url + "/artifacts");
  const knowledge = (
    await call("post", "/knowledge", {
      title: "Fixture proposal",
      content: "Traceable fixture conclusion",
      type: "specialist",
      leadEmployeeId: created.leadEmployeeId,
      sourceArtifactVersionIds: [report.id],
    })
  ).body;
  await call("post", "/knowledge/" + knowledge.id + "/decision", { decision: "reject" }, { "If-Match": "1" });
  await call("get", "/knowledge");
  const mandate = (
    await call("post", "/mandates", {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["research.fetch"],
      targetIds: [randomUUID()],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxAttempts: 5,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "0",
    })
  ).body;
  await call("post", "/schedules", {
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    goal: "Local follow-up",
    kind: "research",
    leadEmployeeId: created.leadEmployeeId,
    budgetLimitUsdMicros: "0",
    mandateId: mandate.id,
    maxActiveOrders: 1,
  });
  await call("get", "/schedules");
  await call("get", url + "/research/watches");
  const watch = (
    await call("post", url + "/research/watches", {
      title: "Fixture watcher",
      relevantChanges: "Source hash changes",
      sources: [{ targetId: mandate.targetIds[0], url: source.url, title: source.title }],
      cadenceSeconds: 60,
      budgetLimitUsdMicros: "0",
      mandateId: mandate.id,
      mandateVersion: 1,
      predecessorArtifactId: report.id,
      enabled: true,
    })
  ).body;
  await call("get", url + "/research/watches");
  const check = (await call("post", url + "/research/watches/" + watch.id + "/check", {})).body;
  expect(check.status).toBe("incomplete");
  await call("get", url + "/research/watches/" + watch.id + "/checks");
  const latest = (await call("get", url + "/research/watches")).body.items[0];
  await call(
    "patch",
    url + "/research/watches/" + watch.id,
    { enabled: false },
    { "If-Match": String(latest.revision) },
  );
});
it("validates local incident state and honest unavailable-runtime failures", async () => {
  await initialize();
  const created = await order("incident"),
    url = "/orders/" + created.id;
  await call("post", url + "/incident", { targetId: randomUUID() });
  await call("post", url + "/incident/diagnosis", {
    evidence: "Local log",
    causeStatus: "suspected",
    explanation: "Source-bound fixture",
  });
  await call("get", url + "/workflow");
  await call("get", url + "/incident/status");
  await call("post", url + "/incident/prevention", { goal: "Prevent fixture recurrence", budgetLimitUsdMicros: "0" });
  await call("get", url + "/hosting");
  await call("post", url + "/run", { mandateId: randomUUID() }, {}, 409);
  await call("post", "/workers/enroll", { name: "Unavailable fixture", capabilities: ["workspace.read"] }, {}, 409);
  await call("post", "/orders", { scope, kind: "research", goal: "bad amount", budgetLimitUsdMicros: "-1" }, {}, 400);
});

afterAll(() => {
  console.info(`Actual successful HTTP operation contracts exercised: ${covered.size}/${contracts.length}`);
});
it("validates configured incident/hosting profiles and concrete approval decisions without dispatching effects", async () => {
  await initialize();
  const created = await order("incident"),
    url = "/orders/" + created.id,
    targetId = randomUUID();
  const config = configSchema.parse({
    liveExecutionEnabled: true,
    serviceTargets: [
      {
        id: targetId,
        scope,
        kind: "systemd",
        resourceName: "contract-fixture.service",
        executable: "/unused/fixture-systemctl",
      },
    ],
  });
  await writeFile(path.join(directory, "configuration.json"), JSON.stringify(config));
  await call("post", url + "/incident", { targetId });
  const health = {
    targetId,
    scope,
    url: "http://127.0.0.1:9/health",
    contains: ["unused fixture"],
    observationSeconds: 6,
    checkIntervalSeconds: 1,
    maxCheckGapSeconds: 2,
  };
  await call("post", "/incident/health-profiles", health);
  await call("get", "/incident/health-profiles");
  await call(
    "put",
    "/incident/health-profiles/" + targetId,
    { ...health, contains: ["updated fixture"] },
    { "If-Match": "1" },
  );
  const mandate = (
    await call("post", "/mandates", {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["incident.repair"],
      targetIds: [targetId],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxAttempts: 1,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "0",
    })
  ).body;
  const repair = (
    await call("post", url + "/incident/repair", {
      actionId: randomUUID(),
      mandateId: mandate.id,
      mandateVersion: 1,
      targetId,
      targetConfigSha256: sha256(config.serviceTargets[0]),
    })
  ).body;
  expect(repair.state).toBe("approval");
  await call("get", url + "/incident/status");
  const approvals = (await call("get", "/approvals")).body;
  await call(
    "post",
    "/approvals/" + repair.id + "/decision",
    { decision: "denied" },
    { "If-Match": String(approvals.items[0].revision) },
  );
  await call("get", "/approvals");
  const site = await order("website");
  await call("post", "/orders/" + site.id + "/website", { briefing: "Hosting configuration fixture", stack: "static" });
  const hosting = {
    name: "No-effect local profile",
    scope,
    provider: "ironcrew-hosting-v1",
    endpoint: "https://127.0.0.1:9/",
    publicUrl: "https://127.0.0.1:9/",
    expectedDnsAddresses: ["127.0.0.1"],
    stack: "static",
    plan: "fixture",
    monthlyCostLimitUsdMicros: "0",
    healthContains: ["fixture"],
  };
  const profile = (await call("post", "/hosting/profiles", hosting)).body;
  await call("put", "/hosting/profiles/" + profile.id, { ...hosting, name: "Updated profile" }, { "If-Match": "1" });
  await call("get", "/hosting/profiles");
  const provision = (
    await call("post", "/orders/" + site.id + "/hosting/provision", {
      actionId: randomUUID(),
      profileId: profile.id,
      mandateId: randomUUID(),
      mandateVersion: 1,
    })
  ).body;
  expect(provision.state).toBe("approval");
  await call("get", "/orders/" + site.id + "/hosting");
});
it("validates real worker enrollment, one-time replay, rotation and revocation response shapes", async () => {
  await initialize();
  const tlsServer = createServer({
    key: await readFile("tests/integration/worker-fixtures/key.pem"),
    cert: await readFile("tests/integration/worker-fixtures/cert.pem"),
  });
  const workers = await WorkerServer.create({ server: tlsServer, repo, scope });
  try {
    app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790", workers: async () => workers });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    agent = request.agent(server);
    const login = await call("post", "/session", { password: "fixture-contract-password" });
    csrf = login.body.csrfToken;
    await call("get", "/workers/status");
    const key = randomUUID(),
      body = { name: "Local credential contract", capabilities: ["workspace.read"], maxConcurrent: 1 };
    const issued = (await call("post", "/workers/enroll", body, { "Idempotency-Key": key })).body;
    await call("post", "/workers/enroll", body, { "Idempotency-Key": key }, 410);
    await call("get", "/workers");
    await call("post", "/workers/" + issued.workerId + "/rotate");
    await call("post", "/workers/" + issued.workerId + "/revoke");
    await call("get", "/workers");
  } finally {
    await workers.close();
    tlsServer.close();
  }
});
it("validates signed Discord binding responses and the separate webhook authentication contract", async () => {
  await initialize();
  const keys = generateKeyPairSync("ed25519"),
    channelId = randomUUID();
  const publicKeyHex = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  await call(
    "put",
    "/channels/config",
    {
      config: {
        version: 1,
        channels: [
          {
            id: channelId,
            provider: "discord",
            enabled: true,
            scope,
            accountId: "contract-app",
            publicKeyHex,
            conversationIds: ["room"],
            kind: "research",
            budgetLimitUsdMicros: "0",
          },
        ],
      },
    },
    { "If-Match": "0" },
  );
  const challenge = (await call("post", "/channels/challenge", { provider: "discord" })).body.challenge;
  const payload = {
    id: "123456789",
    type: 2,
    channel_id: "room",
    user: { id: "123" },
    data: { name: "ironcrew-bind", options: [{ name: "token", value: challenge }] },
  };
  const raw = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + raw), keys.privateKey).toString("hex");
  await call("post", "/channel-webhooks/discord/" + channelId, payload, {
    "X-Signature-Timestamp": timestamp,
    "X-Signature-Ed25519": signature,
  });
  await call("get", "/channels/bindings");
  const rejected = await agent
    .post("/api/v1/channel-webhooks/discord/" + channelId)
    .set({ "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": "0".repeat(128) })
    .send(payload)
    .expect(401);
  expect(rejected.body).toEqual({ error: "auth" });
});

it("validates the real SSE cursor and update payload without confusing it with order history JSON", async () => {
  await initialize();
  const created = await order("research");
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events?after=999999`,
    { headers: { Cookie: cookie, "Last-Event-ID": "0" }, signal: controller.signal },
  );
  try {
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const reader = response.body!.getReader();
    let content = "";
    while (!content.includes('"aggregateId":"' + created.id + '"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      content += new TextDecoder().decode(chunk.value);
    }
    expect(content).toContain("event: update");
    const records = content.split("\n\n").filter((record) => record.includes("event: update"));
    for (const record of records) {
      expect(record).toMatch(/id: [1-9][0-9]*/);
      const payload = JSON.parse(
        record
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      );
      expect(Object.keys(payload).sort()).toEqual(["aggregateId", "type"]);
    }
    covered.add("get /api/v1/events");
  } finally {
    controller.abort();
  }
});
it("validates finance automation proposals, lead review, CEO activation, revocation and payment holds", async () => {
  await initialize();
  const order = (
    await call("post", "/orders", {
      scope,
      kind: "finance",
      goal: "Accountant checks repeat vouchers",
      budgetLimitUsdMicros: "0",
    })
  ).body;
  const bytes = Buffer.from("%PDF-1.4\nfinance-api-original\n%%EOF");
  const v = (
    await call("post", `/orders/${order.id}/finance/vouchers`, {
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      originalBase64: bytes.toString("base64"),
      mediaType: "application/pdf",
      voucherDate: "01.09.2026",
      invoice: {
        id: "V-80",
        supplierId: "supplier-80",
        direction: "payable",
        reference: "V-80",
        currency: "EUR",
        totalMinor: "11900",
        paidMinor: "0",
        dueAt: "2026-09-30T00:00:00Z",
        observedAt: new Date().toISOString(),
        source: "verified-original",
        disputed: false,
        paymentPause: false,
      },
    })
  ).body;
  const targetId = randomUUID(),
    mandateId = randomUUID();
  await call("post", "/mandates", {
    id: mandateId,
    scope,
    version: 1,
    allowedToolIds: ["sevdesk.voucher.upload", "sevdesk.voucher.stage", "sevdesk.reminder.send"],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: "2027-01-01T00:00:00Z",
    maxAttempts: 3,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  });
  const rule = (
    await call("post", "/finance/processing-rules", {
      scope,
      sourceVoucherId: v.voucherId,
      supplierId: "supplier-80",
      currency: "EUR",
      minTotalMinor: "10000",
      maxTotalMinor: "13000",
      mediaTypes: ["application/pdf"],
      targetId,
      mandateId,
      mandateVersion: 1,
      sevdeskSupplierId: 80,
      accountDatevId: 10,
      taxRuleId: "1",
      taxRate: 19,
      source: "Explicit supplier routine",
    })
  ).body;
  await call("post", `/finance/processing-rules/${rule.id}/activate`, {}, {}, 409);
  const { FinanceAutomation } = await import("../../packages/domain/workflows/finance-automation.ts");
  await new FinanceAutomation(repo).review(
    scope,
    rule.id,
    setup.employees.find((e) => e.seedKey === "finance")!.id,
    "Test invokes finance-lead review component; no external model review claimed",
  );
  await call("post", `/finance/processing-rules/${rule.id}/activate`, {});
  await call("post", `/finance/processing-rules/${rule.id}/disable`, {});
  const policy = (
    await call("post", "/finance/reminder-policies", {
      scope,
      orderId: order.id,
      targetId,
      mandateId,
      mandateVersion: 1,
      invoiceId: "88",
      recipient: "invoice-api@example.invalid",
      stage: 1,
      minOverdueDays: 14,
      maxDataAgeSeconds: 60,
      subject: "Invoice reminder",
      text: "Please check the referenced invoice.",
      intervalSeconds: 3600,
    })
  ).body;
  await call("post", `/finance/reminder-policies/${policy.id}/activate`, {});
  await call("post", "/finance/invoice-holds", {
    scope,
    targetId,
    invoiceId: "88",
    disputed: true,
    paymentPause: false,
    source: "Customer dispute fixture",
  });
  await call("post", `/finance/reminder-policies/${policy.id}/disable`, {});
  const listing = (await call("get", "/finance/automation")).body;
  expect(listing.processingRules[0].data.state).toBe("disabled");
  expect(listing.holds[0].data.disputed).toBe(true);
  await call("get", "/finance");
});
