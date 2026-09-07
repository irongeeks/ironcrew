import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, sameScope } from "../src/index.ts";
import type { Scope } from "../../contracts/src/index.ts";
import type { Repository } from "../../persistence/src/index.ts";
export const knowledgeSchema = z
  .object({
    title: z.string().min(1),
    content: z.string().min(1),
    type: z.enum(["specialist", "company_rule"]),
    leadEmployeeId: z.uuid(),
    sourceArtifactVersionIds: z.array(z.uuid()).min(1),
    supersedesId: z.uuid().optional(),
  })
  .strict();
export interface KnowledgeEntry extends z.infer<typeof knowledgeSchema> {
  id: string;
  scope: Scope;
  status: "proposed" | "lead_reviewed" | "active" | "rejected";
  version: number;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}
export type Reviewer = { kind: "ceo"; id: string } | { kind: "employee"; id: string };
/** Caller identity must be supplied by authenticated application context, never copied from request JSON. */
export class KnowledgeService {
  private readonly repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  async propose(scope: Scope, input: z.infer<typeof knowledgeSchema>) {
    const data = knowledgeSchema.parse(input),
      setup = await this.repo.snapshot(scope.companyId);
    if (!setup.employees.some((e) => e.id === data.leadEmployeeId)) throw new DomainError("lead_missing");
    for (const id of data.sourceArtifactVersionIds)
      if (!(await this.repo.getDocument(scope, "artifact", id))) throw new DomainError("knowledge_source_missing");
    let version = 1;
    if (data.supersedesId) {
      const old = await this.repo.getDocument<KnowledgeEntry>(scope, "knowledge", data.supersedesId);
      if (!old || !sameScope(old.data.scope, scope)) throw new DomainError("knowledge_scope_mismatch");
      version = old.data.version + 1;
    }
    const entry: KnowledgeEntry = {
      ...data,
      id: randomUUID(),
      scope,
      status: "proposed",
      version,
      createdAt: new Date().toISOString(),
    };
    return this.repo.putDocument(scope, "knowledge", entry.id, entry, {
      expectedRevision: 0,
      eventType: "knowledge.proposed",
    });
  }
  async decide(scope: Scope, id: string, revision: number, reviewer: Reviewer, decision: "approve" | "reject") {
    const current = await this.repo.getDocument<KnowledgeEntry>(scope, "knowledge", id);
    if (!current) throw new DomainError("knowledge_missing");
    if (current.revision !== revision) throw new DomainError("revision_conflict");
    if (!sameScope(scope, current.data.scope)) throw new DomainError("knowledge_scope_mismatch");
    if (["active", "rejected"].includes(current.data.status)) throw new DomainError("knowledge_already_decided");
    const setup = await this.repo.snapshot(scope.companyId);
    if (reviewer.kind === "ceo" && reviewer.id !== setup.ceo.id) throw new DomainError("ceo_required");
    if (reviewer.kind === "employee" && reviewer.id !== current.data.leadEmployeeId)
      throw new DomainError("knowledge_lead_required");
    if (decision === "approve" && reviewer.kind === "ceo" && current.data.status !== "lead_reviewed")
      throw new DomainError("lead_review_required");
    const status =
      decision === "reject"
        ? "rejected"
        : current.data.type === "company_rule" && reviewer.kind === "employee"
          ? "lead_reviewed"
          : "active";
    return this.repo.putDocument(
      scope,
      "knowledge",
      id,
      { ...current.data, status, reviewedBy: reviewer.id, reviewedAt: new Date().toISOString() },
      { expectedRevision: revision, eventType: "knowledge." + status },
    );
  }
  async reviewArtifact(
    scope: Scope,
    input: {
      artifactVersionId: string;
      reviewer: Reviewer;
      authorEmployeeId: string;
      verdict: "passed" | "changes_requested";
      evidenceRefs: string[];
      summary: string;
    },
  ) {
    const body = z
      .object({
        artifactVersionId: z.uuid(),
        authorEmployeeId: z.uuid(),
        verdict: z.enum(["passed", "changes_requested"]),
        evidenceRefs: z.array(z.string().min(1)).min(1),
        summary: z.string().min(1),
      })
      .parse(input);
    const artifact = await this.repo.getDocument<{ orderId: string }>(scope, "artifact", body.artifactVersionId);
    if (!artifact) throw new DomainError("artifact_missing");
    const order = await this.repo.getOrder(scope, artifact.data.orderId);
    if (order.leadEmployeeId !== body.authorEmployeeId) throw new DomainError("review_author_mismatch");
    for (const ref of body.evidenceRefs)
      if (!(await this.repo.getDocument(scope, "artifact", ref))) throw new DomainError("review_evidence_missing");
    const setup = await this.repo.snapshot(scope.companyId);
    if (input.reviewer.kind === "ceo") {
      if (input.reviewer.id !== setup.ceo.id) throw new DomainError("ceo_required");
    } else {
      if (!setup.employees.some((e) => e.id === input.reviewer.id)) throw new DomainError("reviewer_missing");
      if (input.reviewer.id === body.authorEmployeeId) throw new DomainError("independent_review_required");
    }
    const id = randomUUID();
    return this.repo.putDocument(
      scope,
      "review",
      id,
      {
        ...body,
        id,
        orderId: artifact.data.orderId,
        reviewerId: input.reviewer.id,
        reviewerKind: input.reviewer.kind === "ceo" ? "human" : "agent",
        createdAt: new Date().toISOString(),
      },
      { immutable: true, eventType: "artifact.reviewed" },
    );
  }
  async reviewSample(scope: Scope, artifactVersionId: string) {
    const reviews = (
      await this.repo.listDocuments<{ artifactVersionId: string; reviewerKind: "human" | "agent"; verdict: string }>(
        scope,
        "review",
      )
    ).filter((r) => r.data.artifactVersionId === artifactVersionId);
    return {
      artifactVersionId,
      humanCount: reviews.filter((r) => r.data.reviewerKind === "human").length,
      agentCount: reviews.filter((r) => r.data.reviewerKind === "agent").length,
      passedCount: reviews.filter((r) => r.data.verdict === "passed").length,
    };
  }
}
