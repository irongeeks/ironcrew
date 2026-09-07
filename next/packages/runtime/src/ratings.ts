import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository, Document } from "../../persistence/src/index.ts";
import type { Scope, Order } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../../domain/src/index.ts";
import { shaUuid } from "./engine.ts";

type Row = Record<string, unknown>;
export const ratingInputSchema = z
  .object({
    orderId: z.uuid(),
    artifactVersionId: z.uuid(),
    modelTurnId: z.uuid(),
    quality: z.number().int().min(1).max(5),
    evidence: z.string().trim().min(1).max(10000),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type RatingInput = z.infer<typeof ratingInputSchema>;
export type RatingActor = { kind: "human" | "agent"; id: string };
export type ModelRating = RatingInput & {
  id: string;
  seriesId: string;
  version: number;
  modelId: string;
  orderKind: Order["kind"];
  artifactSha256: string;
  actionId: string;
  reviewerKind: "human" | "agent";
  reviewerId: string;
  createdAt: string;
};
export type RatingTarget = {
  orderId: string;
  artifactVersionId: string;
  artifactSha256: string;
  modelTurnId: string;
  modelId: string;
  actionId: string;
  latencyMs: number | null;
};
export type ModelRatingSummary = {
  modelId: string;
  human: { samples: number; qualityMean: number | null };
  agent: { samples: number; qualityMean: number | null };
  latency: { samples: number; meanMs: number | null };
  observedTurns: number;
};
type Head = { ratingId: string; version: number };
const records = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row => !!row && typeof row === "object" && !Array.isArray(row))
    : [];
const text = (row: Row, key: string) => (typeof row[key] === "string" ? (row[key] as string) : "");
function observedLatency(turn: Row): number | null {
  return typeof turn.latencyMs === "number" && Number.isFinite(turn.latencyMs) && turn.latencyMs >= 0
    ? turn.latencyMs
    : null;
}
function resultContainsArtifact(action: Row, artifact: Document<Row>) {
  if (action.id === artifact.id && action.toolId === "artifact.stage") return true;
  const result = action.result as Row | undefined;
  if (!result || typeof result !== "object") return false;
  // The persisted successful tool result must name this exact immutable version, never only a path/order.
  return (
    result.id === artifact.id ||
    result.artifactVersionId === artifact.id ||
    (result.data as Row | undefined)?.id === artifact.id
  );
}
function callMatches(turn: Row, action: Row) {
  const response = turn.response as Row | undefined,
    message = response?.message as Row | undefined;
  return records(message?.tool_calls).some((call) => {
    const fn = call.function as Row | undefined;
    if (!fn || call.id !== action.callId || fn.name !== text(action, "toolId").replaceAll(".", "__")) return false;
    try {
      return (
        sha256(JSON.parse(text(fn, "arguments"))) === action.argumentsSha256 &&
        sha256(action.args) === action.argumentsSha256
      );
    } catch {
      return false;
    }
  });
}
/** Explicit ratings are immutable. A passed check alone never produces a quality score. */
export class ModelRatings {
  private repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  async targets(scope: Scope, orderId: string): Promise<RatingTarget[]> {
    await this.repo.getOrder(scope, orderId);
    const [artifacts, actions, turns] = await Promise.all([
      this.repo.listDocuments<Row>(scope, "artifact"),
      this.repo.listDocuments<Row>(scope, "action"),
      this.repo.listDocuments<Row>(scope, "model-turn"),
    ]);
    const candidates: RatingTarget[] = [];
    for (const artifact of artifacts.filter((row) => row.data.orderId === orderId)) {
      if (!/^[a-f0-9]{64}$/.test(text(artifact.data, "sha256"))) continue;
      const provenance: RatingTarget[] = [];
      for (const action of actions.filter(
        (row) =>
          row.data.orderId === orderId && row.data.status === "succeeded" && resultContainsArtifact(row.data, artifact),
      )) {
        const matchingTurns = turns.filter(
          (turn) =>
            turn.data.runId === orderId &&
            turn.data.state === "complete" &&
            text(turn.data, "modelId") &&
            callMatches(turn.data, action.data) &&
            (!action.data.modelTurnId || action.data.modelTurnId === turn.id),
        );
        if (matchingTurns.length !== 1) continue;
        const turn = matchingTurns[0]!;
        provenance.push({
          orderId,
          artifactVersionId: artifact.id,
          artifactSha256: text(artifact.data, "sha256"),
          modelTurnId: turn.id,
          modelId: text(turn.data, "modelId"),
          actionId: action.id,
          latencyMs: observedLatency(turn.data),
        });
      }
      // More than one producing action is ambiguous; do not guess which model deserves the rating.
      if (provenance.length === 1) candidates.push(provenance[0]!);
    }
    return candidates;
  }
  async rate(scope: Scope, input: RatingInput, actor: RatingActor): Promise<ModelRating> {
    const body = ratingInputSchema.parse(input);
    z.object({ kind: z.enum(["human", "agent"]), id: z.uuid() })
      .strict()
      .parse(actor);
    const order = await this.repo.getOrder(scope, body.orderId),
      company = await this.repo.snapshot(scope.companyId);
    if (actor.kind === "human") {
      if (actor.id !== company.ceo.id) throw new DomainError("ceo_required", "Authenticated CEO required", 403);
    } else {
      if (!company.employees.some((employee) => employee.id === actor.id))
        throw new DomainError("reviewer_missing", "Reviewer missing", 403);
      const run = await this.repo.getDocument<Row>(scope, "run", order.id);
      const author = (run?.data.profileSnapshot as Row | undefined)?.employeeId ?? order.leadEmployeeId;
      if (author === actor.id) throw new DomainError("independent_review_required");
    }
    const target = (await this.targets(scope, body.orderId)).find(
      (row) => row.artifactVersionId === body.artifactVersionId && row.modelTurnId === body.modelTurnId,
    );
    if (!target) throw new DomainError("model_artifact_binding_missing");
    const seriesId = shaUuid(
      JSON.stringify([body.orderId, body.artifactVersionId, body.modelTurnId, actor.kind, actor.id]),
    );
    const head = await this.repo.getDocument<Head>(scope, "model-rating-head", seriesId);
    if ((head?.data.version ?? 0) !== body.expectedVersion) throw new DomainError("rating_version_conflict");
    const value: ModelRating = {
      ...body,
      id: randomUUID(),
      seriesId,
      version: body.expectedVersion + 1,
      modelId: target.modelId,
      orderKind: order.kind,
      artifactSha256: target.artifactSha256,
      actionId: target.actionId,
      reviewerKind: actor.kind,
      reviewerId: actor.id,
      createdAt: new Date().toISOString(),
    };
    await this.repo.transact(
      scope,
      [
        { kind: "model-rating", id: value.id, data: value, immutable: true },
        {
          kind: "model-rating-head",
          id: seriesId,
          data: { ratingId: value.id, version: value.version },
          expectedRevision: head?.revision ?? 0,
        },
      ],
      {
        type: "model.rated",
        aggregateId: body.orderId,
        data: { ratingId: value.id, artifactVersionId: body.artifactVersionId },
      },
    );
    return value;
  }
  async latest(companyId: string, orderId?: string): Promise<Document<ModelRating>[]> {
    const [ratings, heads] = await Promise.all([
      this.repo.listCompanyDocuments<ModelRating>(companyId, "model-rating"),
      this.repo.listCompanyDocuments<Head>(companyId, "model-rating-head"),
    ]);
    const activeIds = new Set(heads.map((head) => head.data.ratingId));
    return ratings.filter((rating) => activeIds.has(rating.id) && (!orderId || rating.data.orderId === orderId));
  }
  async summaries(companyId: string, options: { orderKind?: Order["kind"] } = {}): Promise<ModelRatingSummary[]> {
    const [ratings, turns, orders] = await Promise.all([
      this.latest(companyId),
      this.repo.listCompanyDocuments<Row>(companyId, "model-turn"),
      this.repo.listAllOrders(companyId),
    ]);
    const orderKinds = new Map(orders.map((order) => [order.id, order.kind]));
    const groups = new Map<string, { human: number[]; agent: number[]; latency: number[]; turns: number }>();
    const group = (modelId: string) => {
      if (!groups.has(modelId)) groups.set(modelId, { human: [], agent: [], latency: [], turns: 0 });
      return groups.get(modelId)!;
    };
    for (const { data: rating } of ratings)
      if (!options.orderKind || rating.orderKind === options.orderKind)
        group(rating.modelId)[rating.reviewerKind].push(rating.quality);
    for (const { data: turn } of turns) {
      if (
        turn.state !== "complete" ||
        !text(turn, "modelId") ||
        !orderKinds.has(text(turn, "runId")) ||
        (options.orderKind && orderKinds.get(text(turn, "runId")) !== options.orderKind)
      )
        continue;
      const item = group(text(turn, "modelId"));
      item.turns++;
      const latency = observedLatency(turn);
      if (latency !== null) item.latency.push(latency);
    }
    const mean = (values: number[]) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return [...groups.entries()].map(([modelId, values]) => ({
      modelId,
      human: { samples: values.human.length, qualityMean: mean(values.human) },
      agent: { samples: values.agent.length, qualityMean: mean(values.agent) },
      latency: { samples: values.latency.length, meanMs: mean(values.latency) },
      observedTurns: values.turns,
    }));
  }
}
/** Routing consumes human quality only. Missing latency stays absent, never a fabricated observation. */
export function ratingRoutingStats(
  summaries: ModelRatingSummary[],
): Record<string, { quality: number; samples: number; latencyMs?: number }> {
  return Object.fromEntries(
    summaries
      .filter((item) => item.human.samples > 0 && item.human.qualityMean !== null)
      .map((item) => [
        item.modelId,
        {
          quality: item.human.qualityMean!,
          samples: item.human.samples,
          ...(item.latency.meanMs !== null ? { latencyMs: item.latency.meanMs } : {}),
        },
      ]),
  );
}
