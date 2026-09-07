import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { ResearchService, type ResearchReportInput } from "../../packages/domain/workflows/research.ts";
import { KnowledgeService } from "../../packages/domain/workflows/knowledge.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";
let repo: Repository, dir: string, scope: Scope, setup: SetupResult, input: ResearchReportInput;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ironcrew-research-"));
  repo = await Repository.open(join(dir, "company.sqlite"));
  setup = await repo.setup({
    companyName: "Iron Geeks",
    ceoName: "Robert",
    passwordHash: "fixture",
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "100",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0].id };
  const order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Vergleiche Ablageoptionen",
    budgetLimitUsdMicros: "100",
  });
  input = {
    orderId: order.id,
    title: "Wissensablage",
    recommendation: "Versionierte interne Ablage verwenden.",
    reasons: [{ text: "Versionen sind nachvollziehbar.", sourceIds: ["source-1"] }],
    comparison: "Interne Ablage und externe Kopie erfüllen unterschiedliche Aufgaben.",
    methodology: "Dokumentierte Funktionsmerkmale verglichen.",
    sources: [
      {
        id: "source-1",
        title: "Geprüfte Testquelle",
        url: "https://example.org/source",
        observedAt: new Date().toISOString(),
        status: "available",
        contentSha256: "a".repeat(64),
      },
    ],
    assumptions: ["Interne Nutzung"],
    gaps: [],
    requiredDelivery: "internal",
  };
  await repo.putDocument(scope, "research-source", "source-1", input.sources[0], { immutable: true });
});
afterEach(async () => {
  await repo.close();
  await rm(dir, { recursive: true, force: true });
});
describe("RES / KNOW durable version and authority gates", () => {
  it("writes a real immutable report and preserves source evidence, assumptions and gaps across restart", async () => {
    const service = new ResearchService(repo, dir);
    const report = await service.create(scope, input);
    const text = await readFile(join(dir, "blobs", report.sha256), "utf8");
    expect(text).toContain("## Empfehlung");
    expect(text).toContain("https://example.org/source");
    expect(text).toContain("Interne Nutzung");
    await expect(repo.putDocument(scope, "artifact", report.id, { changed: true })).rejects.toBeDefined();
    await repo.close();
    repo = await Repository.open(join(dir, "company.sqlite"));
    expect((await repo.getDocument(scope, "artifact", report.id))?.data).toMatchObject({ sha256: report.sha256 });
    expect((await new ResearchService(repo, dir).readiness(scope, report.id)).complete).toBe(false);
  });
  it("rejects unsupported claims and keeps inaccessible sources visibly incomplete", async () => {
    const service = new ResearchService(repo, dir);
    await expect(
      service.create(scope, { ...input, reasons: [{ text: "Unbelegt", sourceIds: ["missing"] }] }),
    ).rejects.toMatchObject({ code: "claim_source_unavailable" });
    const unavailable = {
      id: "missing",
      title: "Nicht erreichbar",
      url: "https://example.org/missing",
      observedAt: new Date().toISOString(),
      status: "unavailable" as const,
    };
    await repo.putDocument(scope, "research-source", "missing", unavailable, { immutable: true });
    const report = await service.create(scope, { ...input, sources: [...input.sources, unavailable] });
    expect(report.completeness).toBe("incomplete");
  });
  it("records unknown external effects and refuses blind duplicate upload after restart", async () => {
    let calls = 0;
    const service = new ResearchService(repo, dir, {
      execute: async () => {
        calls++;
        throw new IntegrationError("timeout", "fixture", "effect_unknown");
      },
    });
    const report = await service.create(scope, { ...input, requiredDelivery: "nextcloud" });
    const delivery = await service.deliver(scope, report.id, { targetId: "fixture", path: "research.md" });
    expect(delivery.state).toBe("effect_unknown");
    await repo.close();
    repo = await Repository.open(join(dir, "company.sqlite"));
    await expect(
      new ResearchService(repo, dir, {
        execute: async () => {
          calls++;
          throw new Error("must not call");
        },
      }).deliver(scope, report.id, { targetId: "fixture", path: "research.md" }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(calls).toBe(1);
  });
  it("reports upload conflicts without completion and requires independent review plus confirmed delivery", async () => {
    const failure = new ResearchService(repo, dir, {
      execute: async () => {
        throw new IntegrationError("conflict", "fixture");
      },
    });
    const artifact = await failure.create(scope, { ...input, requiredDelivery: "nextcloud" });
    expect((await failure.deliver(scope, artifact.id, { targetId: "fixture", path: "report.md" })).state).toBe(
      "conflict",
    );
    expect((await failure.readiness(scope, artifact.id)).complete).toBe(false);
    const success = new ResearchService(repo, dir, {
      execute: async () => ({
        observedAt: new Date().toISOString(),
        effectStatus: "succeeded",
        externalId: "https://nextcloud.example/report.md",
        evidenceRefs: ["fixture-evidence"],
        data: { etag: "v1" },
      }),
    });
    expect(
      (await success.deliver(scope, artifact.id, { targetId: "fixture", path: "report-v2.md", expectedRevision: "v1" }))
        .state,
    ).toBe("delivered");
    const knowledge = new KnowledgeService(repo);
    await knowledge.reviewArtifact(scope, {
      artifactVersionId: artifact.id,
      authorEmployeeId: setup.employees[0].id,
      reviewer: { kind: "employee", id: setup.employees[7].id },
      verdict: "passed",
      evidenceRefs: [artifact.id],
      summary: "Empfehlung und Quellenbindung geprüft.",
    });
    expect((await success.readiness(scope, artifact.id)).complete).toBe(true);
  });
  it("resumes an approved delivery with the same persisted action ID and blocks changed arguments", async () => {
    const ids: string[] = [];
    let approved = false;
    const service = new ResearchService(repo, dir, {
      execute: async (action) => {
        ids.push(action.id);
        if (!approved) throw new DomainError("approval_required");
        return {
          observedAt: new Date().toISOString(),
          effectStatus: "succeeded",
          externalId: "fixture:delivered",
          evidenceRefs: [],
          data: { etag: "v2" },
        };
      },
    });
    const artifact = await service.create(scope, { ...input, requiredDelivery: "nextcloud" });
    expect((await service.deliver(scope, artifact.id, { targetId: "fixture", path: "report.md" })).state).toBe(
      "approval",
    );
    await expect(
      service.deliver(scope, artifact.id, { targetId: "fixture", path: "different.md" }),
    ).rejects.toMatchObject({ code: "delivery_approval_binding_changed" });
    approved = true;
    expect((await service.deliver(scope, artifact.id, { targetId: "fixture", path: "report.md" })).state).toBe(
      "delivered",
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });
  it("keeps a single correction proposed, requires assigned lead review and CEO approval for company rules", async () => {
    const report = await new ResearchService(repo, dir).create(scope, input),
      knowledge = new KnowledgeService(repo);
    const entry = await knowledge.propose(scope, {
      title: "Quellenstand dokumentieren",
      content: "Recherche nennt den Quellenzeitpunkt.",
      type: "company_rule",
      leadEmployeeId: setup.employees[6].id,
      sourceArtifactVersionIds: [report.id],
    });
    expect(entry.data.status).toBe("proposed");
    await expect(
      knowledge.decide(scope, entry.id, 1, { kind: "ceo", id: setup.ceo.id }, "approve"),
    ).rejects.toMatchObject({ code: "lead_review_required" });
    await expect(
      knowledge.decide(scope, entry.id, 1, { kind: "employee", id: setup.employees[1].id }, "approve"),
    ).rejects.toMatchObject({ code: "knowledge_lead_required" });
    const reviewed = await knowledge.decide(
      scope,
      entry.id,
      1,
      { kind: "employee", id: setup.employees[6].id },
      "approve",
    );
    expect(reviewed.data.status).toBe("lead_reviewed");
    const active = await knowledge.decide(scope, entry.id, 2, { kind: "ceo", id: setup.ceo.id }, "approve");
    expect(active.data.status).toBe("active");
    expect(await repo.listDocuments({ ...scope, areaId: setup.areas[1].id }, "knowledge")).toHaveLength(0);
  });
  it("separates human and agent review samples and rejects self review", async () => {
    const report = await new ResearchService(repo, dir).create(scope, input),
      knowledge = new KnowledgeService(repo),
      base = {
        artifactVersionId: report.id,
        authorEmployeeId: setup.employees[0].id,
        verdict: "passed" as const,
        evidenceRefs: [report.id],
        summary: "Quellen geprüft.",
      };
    await expect(
      knowledge.reviewArtifact(scope, { ...base, reviewer: { kind: "employee", id: setup.employees[0].id } }),
    ).rejects.toMatchObject({ code: "independent_review_required" });
    await knowledge.reviewArtifact(scope, { ...base, reviewer: { kind: "employee", id: setup.employees[7].id } });
    await knowledge.reviewArtifact(scope, { ...base, reviewer: { kind: "ceo", id: setup.ceo.id } });
    expect(await knowledge.reviewSample(scope, report.id)).toEqual({
      artifactVersionId: report.id,
      humanCount: 1,
      agentCount: 1,
      passedCount: 2,
    });
  });
});
