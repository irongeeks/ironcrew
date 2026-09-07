import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { ModelRatings, ratingRoutingStats, type RatingInput } from "../../packages/runtime/src/ratings.ts";
let repo: Repository, directory: string, setup: SetupResult, scope: Scope, ratings: ModelRatings;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-rating-unit-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  setup = await repo.setup({
    companyName: "Rating unit fixture",
    ceoName: "Fixture CEO",
    passwordHash: "not-a-login",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  ratings = new ModelRatings(repo);
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
/** Synthetic persisted provenance for a unit test; no paid call, provider result or measured production latency claimed. */
async function fixture(latencyMs?: number) {
  const order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Unit-only rating provenance",
    budgetLimitUsdMicros: "0",
    leadEmployeeId: setup.employees[0]!.id,
  });
  const artifactVersionId = randomUUID(),
    modelTurnId = randomUUID(),
    args = { path: "fixture.txt", mediaType: "text/plain" };
  await repo.putDocument(
    scope,
    "artifact",
    artifactVersionId,
    { id: artifactVersionId, orderId: order.id, sha256: "a".repeat(64), mediaType: "text/plain" },
    { immutable: true },
  );
  await repo.putDocument(scope, "action", artifactVersionId, {
    id: artifactVersionId,
    orderId: order.id,
    runId: order.id,
    toolId: "artifact.stage",
    callId: "unit-only-call",
    args,
    argumentsSha256: sha256(args),
    status: "succeeded",
    result: { id: artifactVersionId },
  });
  await repo.putDocument(scope, "model-turn", modelTurnId, {
    id: modelTurnId,
    runId: order.id,
    modelId: "unit/fixture-model",
    state: "complete",
    ...(latencyMs === undefined ? {} : { latencyMs }),
    response: {
      message: {
        tool_calls: [{ id: "unit-only-call", function: { name: "artifact__stage", arguments: JSON.stringify(args) } }],
      },
    },
  });
  const body: RatingInput = {
    orderId: order.id,
    artifactVersionId,
    modelTurnId,
    quality: 2,
    evidence: "Explicit human assessment of fixture content",
    expectedVersion: 0,
  };
  return body;
}
it("requires an explicit 1..5 quality score and does not infer quality from passed checks", async () => {
  const body = await fixture();
  await repo.putDocument(
    scope,
    "review",
    randomUUID(),
    { orderId: body.orderId, artifactVersionId: body.artifactVersionId, verdict: "passed" },
    { immutable: true },
  );
  expect(await ratings.summaries(scope.companyId)).toEqual([
    {
      modelId: "unit/fixture-model",
      human: { samples: 0, qualityMean: null },
      agent: { samples: 0, qualityMean: null },
      latency: { samples: 0, meanMs: null },
      observedTurns: 1,
    },
  ]);
  expect(ratingRoutingStats(await ratings.summaries(scope.companyId))).toEqual({});
  for (const quality of [0, 6, 2.5])
    await expect(ratings.rate(scope, { ...body, quality }, { kind: "human", id: setup.ceo.id })).rejects.toThrow();
  await expect(ratings.rate(scope, { ...body, evidence: " " }, { kind: "human", id: setup.ceo.id })).rejects.toThrow();
});
it("versioned corrections remain immutable and count only the newest human assessment after restart", async () => {
  const body = await fixture(),
    first = await ratings.rate(scope, body, { kind: "human", id: setup.ceo.id });
  await expect(ratings.rate(scope, { ...body, quality: 5 }, { kind: "human", id: setup.ceo.id })).rejects.toThrow(
    "rating_version_conflict",
  );
  const second = await ratings.rate(
    scope,
    { ...body, quality: 4, evidence: "Reviewed again with explicit changed judgement", expectedVersion: 1 },
    { kind: "human", id: setup.ceo.id },
  );
  expect(second.version).toBe(2);
  expect(first.id).not.toBe(second.id);
  expect((await repo.getDocument(scope, "model-rating", first.id))!.data).toMatchObject({ quality: 2, version: 1 });
  await repo.close();
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  ratings = new ModelRatings(repo);
  expect(await ratings.latest(scope.companyId)).toHaveLength(1);
  expect((await ratings.summaries(scope.companyId))[0]!.human).toEqual({ samples: 1, qualityMean: 4 });
  expect(ratingRoutingStats(await ratings.summaries(scope.companyId))).toEqual({
    "unit/fixture-model": { quality: 4, samples: 1 },
  });
});
it("separates human and independent agent samples and uses observed turn latency once", async () => {
  const body = await fixture(312.5);
  await ratings.rate(scope, body, { kind: "human", id: setup.ceo.id });
  await ratings.rate(
    scope,
    { ...body, quality: 5, evidence: "Independent agent fixture assessment" },
    { kind: "agent", id: setup.employees[1]!.id },
  );
  const summary = (await ratings.summaries(scope.companyId))[0]!;
  expect(summary).toMatchObject({
    human: { samples: 1, qualityMean: 2 },
    agent: { samples: 1, qualityMean: 5 },
    latency: { samples: 1, meanMs: 312.5 },
    observedTurns: 1,
  });
  expect(ratingRoutingStats([summary])).toEqual({ "unit/fixture-model": { quality: 2, samples: 1, latencyMs: 312.5 } });
  expect(await ratings.summaries(scope.companyId, { orderKind: "website" })).toEqual([]);
  await expect(ratings.rate(scope, body, { kind: "agent", id: setup.employees[0]!.id })).rejects.toThrow(
    "independent_review_required",
  );
  await expect(ratings.rate(scope, body, { kind: "human", id: setup.employees[1]!.id })).rejects.toThrow(
    "Authenticated CEO required",
  );
});
it("refuses nonexistent, manual and ambiguous artifact to model-turn bindings", async () => {
  const body = await fixture();
  await expect(
    ratings.rate(scope, { ...body, modelTurnId: randomUUID() }, { kind: "human", id: setup.ceo.id }),
  ).rejects.toThrow("model_artifact_binding_missing");
  const manualId = randomUUID();
  await repo.putDocument(
    scope,
    "artifact",
    manualId,
    { orderId: body.orderId, sha256: "b".repeat(64) },
    { immutable: true },
  );
  await expect(
    ratings.rate(scope, { ...body, artifactVersionId: manualId }, { kind: "human", id: setup.ceo.id }),
  ).rejects.toThrow("model_artifact_binding_missing");
  const turn = await repo.getDocument(scope, "model-turn", body.modelTurnId);
  const otherTurnId = randomUUID();
  await repo.putDocument(scope, "model-turn", otherTurnId, { ...(turn!.data as object), id: otherTurnId });
  expect(await ratings.targets(scope, body.orderId)).toEqual([]);
});
it("rejects changed tool arguments and cross-scope provenance instead of assigning a guessed model", async () => {
  const body = await fixture(),
    action = await repo.getDocument(scope, "action", body.artifactVersionId);
  await repo.putDocument(
    scope,
    "action",
    body.artifactVersionId,
    { ...(action!.data as object), args: { path: "different.txt" } },
    { expectedRevision: action!.revision },
  );
  expect(await ratings.targets(scope, body.orderId)).toEqual([]);
  const other = await repo.createArea(scope.companyId, { name: "Other", visibility: "private" });
  await expect(
    ratings.rate({ ...scope, areaId: other.id }, body, { kind: "human", id: setup.ceo.id }),
  ).rejects.toThrow();
});
it("concurrent submissions cannot inflate a single reviewer series", async () => {
  const body = await fixture();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => ratings.rate(scope, body, { kind: "human", id: setup.ceo.id })),
  );
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await repo.listDocuments(scope, "model-rating")).toHaveLength(1);
  expect((await ratings.summaries(scope.companyId))[0]!.human.samples).toBe(1);
});
