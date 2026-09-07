import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
let repo: Repository,
  directory: string,
  scope: Scope,
  web: WebsiteWorkflow,
  orderId: string,
  version: string,
  ceoId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ic-site-feedback-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  const setup = await repo.setup({
    companyName: "Feedback fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  ceoId = setup.ceo.id;
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  orderId = (await repo.createOrder(scope, { kind: "website", goal: "Versioned feedback", budgetLimitUsdMicros: "0" }))
    .id;
  web = new WebsiteWorkflow(repo, directory);
  await web.create(scope, orderId, "Source brief");
  const concepts = await web.concepts(scope, orderId, [
    { name: "A", rationale: "Clear", html: "<!doctype html><h1>Before</h1>" },
    { name: "B", rationale: "Dense", html: "<!doctype html><h1>Alternative</h1>" },
  ]);
  await web.select(scope, orderId, concepts.data.concepts[0]!.id);
  version = (await web.build(scope, orderId)).id;
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const pin = (comment: string, deferDispatch = true) =>
  web.pin(scope, orderId, {
    artifactVersionId: version,
    viewport: { width: 390, height: 650 },
    anchor: "viewport-point:80,65",
    comment,
    deferDispatch,
  });
it("collects point feedback without dispatch, then submits one scoped batch to both chat and model inbox", async () => {
  const a = await pin("Heading too long"),
    b = await pin("Change contact placement");
  expect(await repo.listDocuments(scope, "run-inbox")).toHaveLength(0);
  await expect(
    web.resolvePin(scope, orderId, a.id, { artifactVersionId: version, evidence: "Not submitted", reviewerId: ceoId }),
  ).rejects.toThrow("feedback_not_submitted");
  const submitted = await web.submitFeedback(scope, orderId, [a.id, b.id]);
  expect(submitted.pinIds).toEqual([a.id, b.id]);
  const messages = await repo.listDocuments<{ content: string }>(scope, "message");
  expect(messages).toHaveLength(1);
  expect(messages[0]!.data.content).toContain("Heading too long");
  const inbox = await repo.listDocuments<{ content: string }>(scope, "run-inbox");
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.data.content).toContain(version);
  expect(inbox[0]!.data.content).toContain("viewport-point:80,65");
  await expect(web.submitFeedback(scope, orderId, [a.id, b.id])).rejects.toThrow("feedback_not_draft");
  expect(await repo.listDocuments(scope, "message")).toHaveLength(1);
});
it("records chat change requests in the same list and builds a traceable revision without changing previous bytes", async () => {
  const feedback = await web.pin(scope, orderId, {
    artifactVersionId: version,
    viewport: { width: 1440, height: 650 },
    anchor: "general",
    comment: "Shorten heading",
    source: "chat",
  });
  expect(feedback.data.state).toBe("open");
  expect(await repo.listDocuments(scope, "run-inbox")).toHaveLength(1);
  const before = await web.preview(version);
  const revised = await web.revise(scope, orderId, {
    expectedArtifactVersionId: version,
    html: "<!doctype html><h1>After</h1>",
    changeDescription: "Shortened as requested",
    feedbackIds: [feedback.id],
  });
  expect(revised.data.acceptedVersionId).toBeUndefined();
  const built = await web.build(scope, orderId);
  expect(built.predecessorArtifactVersionId).toBe(version);
  expect(built.sourceRevisionId).toBe(revised.data.sourceRevisionId);
  expect((await web.preview(built.id)).toString()).toContain("After");
  expect(await web.preview(version)).toEqual(before);
  await web.resolvePin(scope, orderId, feedback.id, {
    artifactVersionId: built.id,
    evidence: "Compared original and new heading",
    reviewerId: ceoId,
  });
  const recorded = await repo.getDocument<{ artifactVersionId: string; resolvedArtifactVersionId: string }>(
    scope,
    "site-pin",
    feedback.id,
  );
  expect(recorded!.data.artifactVersionId).toBe(version);
  expect(recorded!.data.resolvedArtifactVersionId).toBe(built.id);
  await expect(
    web.revise(scope, orderId, { expectedArtifactVersionId: version, html: "stale", changeDescription: "stale" }),
  ).rejects.toThrow("stale_artifact");
});

const review = (id: string) =>
  web.review(scope, orderId, {
    artifactVersionId: id,
    reviewerId: ceoId,
    reviewerKind: "ceo",
    checks: ["mobile", "functional", "quality"].map((name) => ({
      name,
      passed: true,
      evidence: "Actually checked fixture",
    })),
  });
it("does not review or resolve the predecessor while a changed source awaits a build", async () => {
  await web.revise(scope, orderId, {
    expectedArtifactVersionId: version,
    html: "<h1>Unbuilt change</h1>",
    changeDescription: "Pending revision",
  });
  const feedback = await pin("Old version feedback", false);
  expect((await repo.getDocument(scope, "website", orderId))?.data).toMatchObject({ state: "selected" });
  await expect(review(version)).rejects.toThrow("site_build_required");
  await expect(
    web.resolvePin(scope, orderId, feedback.id, {
      artifactVersionId: version,
      evidence: "Premature",
      reviewerId: ceoId,
    }),
  ).rejects.toThrow("pin_resolution_invalid");
  await expect(web.accept(scope, orderId, version)).rejects.toThrow("acceptance_checks_required");
  const next = await web.build(scope, orderId);
  await review(next.id);
});
it("submitting a previously collected batch invalidates intervening acceptance atomically", async () => {
  const draft = await pin("Deferred request");
  await review(version);
  await web.accept(scope, orderId, version);
  await web.submitFeedback(scope, orderId, [draft.id]);
  expect((await repo.getDocument(scope, "website", orderId))?.data).toMatchObject({ state: "built" });
  expect(
    (await repo.getDocument<{ acceptedVersionId?: string }>(scope, "website", orderId))?.data.acceptedVersionId,
  ).toBeUndefined();
  await expect(web.accept(scope, orderId, version)).rejects.toThrow("acceptance_checks_required");
});
it("selecting another concept clears unrelated source-revision provenance", async () => {
  const revised = await web.revise(scope, orderId, {
    expectedArtifactVersionId: version,
    html: "<h1>Revision</h1>",
    changeDescription: "Change",
  });
  await web.select(scope, orderId, revised.data.concepts[1]!.id);
  const next = await web.build(scope, orderId);
  expect(next.sourceRevisionId).toBeUndefined();
  expect((await web.preview(next.id)).toString()).toContain("Alternative");
});
