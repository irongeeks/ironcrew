import { beforeEach, afterEach, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { ResearchService, type ResearchReport } from "../../packages/domain/workflows/research.ts";
import {
  ResearchWatch,
  type WatchDefinition,
  type WatchCheck,
  type WatchArtifact,
} from "../../packages/domain/workflows/research-watch.ts";
import type { Scope, Mandate, Order } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { digest } from "../../packages/tools/workspace.ts";
import type { IntegrationService } from "../../packages/integrations/src/service.ts";
let repo: Repository,
  directory: string,
  scope: Scope,
  order: Order,
  mandate: Mandate,
  server: Server,
  base: string,
  now: number,
  requests: number;
let contents: Record<string, string>,
  unavailable: Set<string>,
  port: Pick<IntegrationService, "execute">,
  predecessor: ResearchReport,
  targets: string[];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "research-watch-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Watch fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "10000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Observe explicit fixture sources",
    budgetLimitUsdMicros: "10000",
  });
  now = Date.now();
  requests = 0;
  contents = { "/one": "The release supports version 1.", "/two": "Support ends in December." };
  unavailable = new Set();
  server = createServer((req, res) => {
    requests++;
    const url = req.url!;
    if (unavailable.has(url)) {
      res.writeHead(503).end("fixture unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end(contents[url] ?? "missing");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  targets = [randomUUID(), randomUUID()];
  mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["research.fetch", "research.watch.create", "research.watch.check", "research.watch.review"],
    targetIds: [...targets, order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "10000",
  };
  await repo.createMandate(mandate);
  port = {
    execute: async (action) => {
      const response = await fetch((action.args as { url: string }).url);
      if (!response.ok) throw new DomainError("fixture_http_unavailable");
      return {
        observedAt: new Date().toISOString(),
        effectStatus: "succeeded",
        evidenceRefs: [],
        data: { content: await response.text() },
      };
    },
  };
  const research = new ResearchService(repo, directory, port),
    sources = await Promise.all(
      targets.map((targetId, index) =>
        research.fetchSource(scope, {
          targetId,
          url: base + (index === 0 ? "/one" : "/two"),
          title: `Source ${index + 1}`,
        }),
      ),
    );
  predecessor = await research.create(scope, {
    orderId: order.id,
    title: "Original recommendation",
    recommendation: "Use the supported release after checking its lifecycle.",
    reasons: [{ text: "Published lifecycle information.", sourceIds: sources.map((source) => source.id) }],
    comparison: "Version 1 and support lifecycle",
    methodology: "Read explicit fixture URLs",
    sources,
    assumptions: [],
    gaps: [],
    requiredDelivery: "internal",
  });
});
afterEach(async () => {
  await repo.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
function service() {
  return new ResearchWatch(repo, directory, new ResearchService(repo, directory, port), () => new Date(now));
}
async function definition() {
  return service().create(scope, {
    orderId: order.id,
    title: "Release lifecycle",
    relevantChanges: "Supported version and end-of-support changes",
    sources: targets.map((targetId, index) => ({
      targetId,
      url: base + (index === 0 ? "/one" : "/two"),
      title: `Source ${index + 1}`,
    })),
    cadenceSeconds: 60,
    budgetLimitUsdMicros: "10000",
    mandateId: mandate.id,
    mandateVersion: 1,
    predecessorArtifactId: predecessor.id,
  });
}
it("persists a scoped observation across restart and writes a real versioned change with bound lead assessment", async () => {
  const watch = await definition(),
    first = await service().check(scope, watch.id, { checkId: randomUUID() });
  expect(first.status).toBe("unchanged");
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  now += 61_000;
  contents["/one"] = "The release supports version 2.";
  const changed = await service().check(scope, watch.id, { checkId: randomUUID() });
  expect(changed.status).toBe("changed");
  expect(changed.recommendationStatus).toBe("review_required");
  expect(changed.diffs[0]).toMatchObject({
    removedExcerpt: "1",
    addedExcerpt: "2",
    beforeSha256: digest("The release supports version 1."),
    afterSha256: digest(contents["/one"]!),
  });
  const artifact = (await repo.getDocument<WatchArtifact>(scope, "artifact", changed.artifactVersionId!))!;
  expect(artifact.data).toMatchObject({
    predecessorId: predecessor.id,
    watchId: watch.id,
    version: 1,
    recommendationStatus: "review_required",
  });
  const content = await readFile(path.join(directory, "blobs", artifact.data.sha256), "utf8");
  expect(content).toContain("Vorher: 1");
  expect(content).toContain("Nachher: 2");
  expect(content).toContain("review_required");
  expect(digest(content)).toBe(artifact.data.sha256);
  await expect(
    service().review(scope, watch.id, changed.id, randomUUID(), { decision: "maintain", reason: "Untrusted reviewer" }),
  ).rejects.toMatchObject({ code: "watch_lead_required" });
  const review = await service().review(scope, watch.id, changed.id, order.leadEmployeeId, {
    decision: "revise",
    reason: "The source explicitly replaces version 1 by version 2.",
    recommendation: "Evaluate version 2 before migration.",
  });
  expect(review.artifactSha256).toBe(artifact.data.sha256);
  expect(review.companyKnowledgeChanged).toBe(false);
  expect(await repo.listDocuments(scope, "knowledge")).toHaveLength(0);
  expect((await repo.getDocument<ResearchReport>(scope, "artifact", predecessor.id))!.data.recommendation).toBe(
    predecessor.recommendation,
  );
});
it("keeps unavailable checks incomplete and preserves the last successful state without duplicate change templates", async () => {
  const watch = await definition();
  await service().check(scope, watch.id, { checkId: randomUUID() });
  const successful = (await repo.getDocument<WatchDefinition>(scope, "research-watch", watch.id))!.data
    .lastSuccessfulCheckAt;
  now += 61_000;
  contents["/one"] = "The release supports version 3.";
  unavailable.add("/two");
  const checkId = randomUUID(),
    checked = await service().check(scope, watch.id, { checkId });
  expect(checked.status).toBe("incomplete");
  expect(checked.failures).toContainEqual({ url: base + "/two", code: "fixture_http_unavailable" });
  expect(checked.artifactVersionId).toBeDefined();
  const count = requests;
  expect(await service().check(scope, watch.id, { checkId })).toEqual(checked);
  expect(requests).toBe(count);
  expect((await repo.getDocument<WatchDefinition>(scope, "research-watch", watch.id))!.data.lastSuccessfulCheckAt).toBe(
    successful,
  );
  expect(
    (await repo.getDocument<WatchArtifact>(scope, "artifact", checked.artifactVersionId!))!.data.completeness,
  ).toBe("incomplete");
  await expect(
    service().review(scope, watch.id, checked.id, order.leadEmployeeId, {
      decision: "maintain",
      reason: "Cannot infer safety from missing source",
    }),
  ).rejects.toMatchObject({ code: "watch_review_incomplete" });
  now += 61_000;
  const repeat = await service().check(scope, watch.id, { checkId: randomUUID() });
  expect(repeat.status).toBe("incomplete");
  expect(repeat.artifactVersionId).toBeUndefined();
  unavailable.delete("/two");
  now += 61_000;
  const recovered = await service().check(scope, watch.id, { checkId: randomUUID() });
  expect(recovered.status).toBe("changed");
  expect(recovered.artifactVersionId).toBeDefined();
  const finalArtifact = (await repo.getDocument<WatchArtifact>(scope, "artifact", recovered.artifactVersionId!))!.data;
  expect(finalArtifact).toMatchObject({
    version: 2,
    completeness: "complete",
    predecessorId: checked.artifactVersionId,
  });
  await expect(
    service().review(scope, watch.id, recovered.id, order.leadEmployeeId, {
      decision: "maintain",
      reason: "Both sources now accessible; reviewed the version change.",
    }),
  ).resolves.toMatchObject({ companyKnowledgeChanged: false });
});
it("records revoked mandates and unavailable tools as incomplete before any source request", async () => {
  const watch = await definition(),
    count = requests;
  await repo.revokeMandate(scope, mandate.id, 1);
  const blocked = await service().check(scope, watch.id, { checkId: randomUUID() });
  expect(blocked.status).toBe("incomplete");
  expect(blocked.failures.some((f) => f.code === "mandate_revoked")).toBe(true);
  expect(requests).toBe(count);
  expect(
    (await repo.getDocument<WatchDefinition>(scope, "research-watch", watch.id))!.data.lastSuccessfulCheckAt,
  ).toBeUndefined();
});
it("enforces cadence and atomic check ownership under concurrent calls", async () => {
  const watch = await definition(),
    before = requests;
  const results = await Promise.allSettled([
    service().check(scope, watch.id, { checkId: randomUUID() }),
    service().check(scope, watch.id, { checkId: randomUUID() }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(requests - before).toBe(2);
  expect(await repo.listDocuments(scope, "research-watch-check")).toHaveLength(1);
  await expect(service().check(scope, watch.id, { checkId: randomUUID() })).rejects.toMatchObject({
    code: "watch_not_due",
  });
  const otherScope = { ...scope, areaId: (await repo.snapshot(scope.companyId)).areas[1]!.id };
  await expect(service().check(otherScope, watch.id, { checkId: randomUUID() })).rejects.toMatchObject({
    code: "scope_denied",
  });
});
it("recovers an interrupted check after its lease expires without presenting an all-clear or repeating reads", async () => {
  const watch = await definition(),
    checkId = randomUUID(),
    startedAt = new Date(now - 700_000).toISOString();
  const interrupted: WatchCheck = {
    id: checkId,
    watchId: watch.id,
    orderId: order.id,
    startedAt,
    leaseExpiresAt: new Date(now - 1000).toISOString(),
    status: "running",
    sourceIds: [],
    diffs: [],
    failures: [],
    recommendationStatus: "not_reassessed",
  };
  await repo.transact(
    scope,
    [
      { kind: "research-watch", id: watch.id, data: { ...watch, activeCheckId: checkId }, expectedRevision: 1 },
      { kind: "research-watch-check", id: checkId, data: interrupted },
    ],
    { type: "fixture.crash", aggregateId: order.id },
  );
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const count = requests;
  const result = await service().check(scope, watch.id, { checkId });
  expect(result.status).toBe("incomplete");
  expect(result.failures.some((f) => f.code === "check_interrupted")).toBe(true);
  expect(requests).toBe(count);
  expect(
    (await repo.getDocument<WatchDefinition>(scope, "research-watch", watch.id))!.data.activeCheckId,
  ).toBeUndefined();
});
it("records connector setup failure and rejects a cost ceiling that cannot be enforced by the order ledger", async () => {
  const watch = await definition(),
    count = requests;
  const check = await new ResearchWatch(repo, directory).check(scope, watch.id, { checkId: randomUUID() });
  expect(check.status).toBe("incomplete");
  expect(check.failures.some((f) => f.code === "integration_not_configured")).toBe(true);
  expect(requests).toBe(count);
  await expect(
    service().create(scope, {
      orderId: watch.orderId,
      title: watch.title,
      relevantChanges: watch.relevantChanges,
      sources: watch.sources,
      cadenceSeconds: watch.cadenceSeconds,
      budgetLimitUsdMicros: "1",
      mandateId: watch.mandateId,
      mandateVersion: 1,
      predecessorArtifactId: predecessor.id,
    }),
  ).rejects.toMatchObject({ code: "watch_budget_must_match_order" });
});

it("exposes scoped watch checks through CEO-authenticated API and rejects a tool call from another order", async () => {
  const { createApp } = await import("../../apps/control/app.ts"),
    { createSession } = await import("../../apps/control/auth.ts"),
    { researchWatchTools } = await import("../../apps/control/research-watch-tools.ts"),
    { default: request } = await import("supertest");
  const watch = await definition(),
    app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" });
  await request(app).get(`/api/v1/orders/${order.id}/research/watches`).expect(401);
  let cookie = "";
  const csrf = await createSession(
    repo,
    {
      cookie: (name: string, value: string) => {
        cookie = `${name}=${value}`;
      },
    } as import("express").Response,
    false,
  );
  const list = await request(app).get(`/api/v1/orders/${order.id}/research/watches`).set("Cookie", cookie).expect(200);
  expect(list.body.items.map((item: { id: string }) => item.id)).toContain(watch.id);
  const checkId = randomUUID();
  const checked = await request(app)
    .post(`/api/v1/orders/${order.id}/research/watches/${watch.id}/check`)
    .set({ Cookie: cookie, "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() })
    .send({ checkId })
    .expect(200);
  expect(checked.body.status).toBe("incomplete");
  expect(checked.body.failures.some((failure: { code: string }) => failure.code === "integration_not_configured")).toBe(
    true,
  );
  const history = await request(app)
    .get(`/api/v1/orders/${order.id}/research/watches/${watch.id}/checks`)
    .set("Cookie", cookie)
    .expect(200);
  expect(history.body.items.map((item: { id: string }) => item.id)).toContain(checkId);
  const tool = researchWatchTools(repo, directory).find((tool) => tool.id === "research.watch.check")!;
  const action: import("../../packages/contracts/src/index.ts").ToolAction = {
    id: randomUUID(),
    scope,
    orderId: randomUUID(),
    runId: randomUUID(),
    toolId: tool.id,
    toolVersion: 1,
    args: {},
    argumentsSha256: "0".repeat(64),
    mandateId: mandate.id,
    mandateVersion: 1,
    status: "running",
    evidenceRefs: [],
  };
  await expect(tool.execute({ watchId: watch.id, checkId: randomUUID() }, action)).rejects.toMatchObject({
    code: "watch_binding_mismatch",
  });
});
