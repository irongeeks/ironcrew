import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { microsSchema, type Scope, type Mandate, type ToolAction } from "../../contracts/src/index.ts";
import { Repository, type Mutation } from "../../persistence/src/index.ts";
import { DomainError, sha256, sameScope } from "../src/index.ts";
import { digest } from "../../tools/workspace.ts";
import { shaUuid } from "../../runtime/src/engine.ts";
import { ResearchService, renderResearch, type ResearchReport, type ResearchSource } from "./research.ts";

export const researchWatchCreateSchema = z
  .object({
    orderId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    relevantChanges: z.string().trim().min(1).max(5000),
    sources: z
      .array(z.object({ targetId: z.uuid(), url: z.url(), title: z.string().trim().min(1).max(300) }).strict())
      .min(1)
      .max(16),
    cadenceSeconds: z.number().int().min(60).max(31_536_000),
    budgetLimitUsdMicros: microsSchema,
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive(),
    predecessorArtifactId: z.uuid(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (value) => new Set(value.sources.map((source) => source.url)).size === value.sources.length,
    "Duplicate source URL",
  );
export type ResearchWatchInput = z.input<typeof researchWatchCreateSchema>;
export type WatchDefinition = z.output<typeof researchWatchCreateSchema> & {
  id: string;
  scope: Scope;
  createdAt: string;
  nextCheckAt: string;
  baselineSourceIds: string[];
  latestArtifactId: string;
  lastChangeFingerprint?: string;
  activeCheckId?: string;
  lastCheckId?: string;
  lastSuccessfulCheckAt?: string;
  lastStatus?: WatchCheck["status"];
};
export type SourceDiff = {
  url: string;
  beforeSourceId: string;
  afterSourceId: string;
  beforeSha256: string;
  afterSha256: string;
  removedExcerpt: string;
  addedExcerpt: string;
  truncated: boolean;
  interpretation: "review_required";
};
export type WatchCheck = {
  id: string;
  watchId: string;
  orderId: string;
  startedAt: string;
  leaseExpiresAt: string;
  completedAt?: string;
  status: "running" | "unchanged" | "changed" | "incomplete";
  sourceIds: string[];
  diffs: SourceDiff[];
  failures: { url?: string; code: string }[];
  artifactVersionId?: string;
  reservationId?: string;
  recommendationStatus: "review_required" | "not_reassessed";
};
export type WatchArtifact = ResearchReport & {
  previousRecommendation: string;
  watchId: string;
  checkId: string;
  version: number;
  recommendationStatus: "review_required";
  diffs: SourceDiff[];
};
export const watchReviewSchema = z
  .object({
    decision: z.enum(["maintain", "revise", "irrelevant"]),
    reason: z.string().trim().min(1).max(10000),
    recommendation: z.string().trim().min(1).max(10000).optional(),
  })
  .strict()
  .refine((value) => value.decision !== "revise" || !!value.recommendation, "A revised recommendation is required");

/** An observation produces evidence for a lead decision; it cannot activate company knowledge or permissions. */
export class ResearchWatch {
  readonly repo: Repository;
  readonly directory: string;
  readonly sources: Pick<ResearchService, "fetchSource">;
  readonly now: () => Date;
  constructor(
    repo: Repository,
    directory: string,
    sources?: Pick<ResearchService, "fetchSource">,
    now = () => new Date(),
  ) {
    this.repo = repo;
    this.directory = directory;
    this.sources = sources ?? new ResearchService(repo, directory);
    this.now = now;
  }
  async create(scope: Scope, input: ResearchWatchInput) {
    const parsed = researchWatchCreateSchema.parse(input),
      order = await this.repo.getOrder(scope, parsed.orderId);
    if (order.kind !== "research") throw new DomainError("research_order_required");
    if (parsed.budgetLimitUsdMicros !== order.budgetLimitUsdMicros)
      throw new DomainError("watch_budget_must_match_order");
    const mandate = await this.repo.getDocument<Mandate>(
      scope,
      "mandate",
      `${parsed.mandateId}:${parsed.mandateVersion}`,
    );
    if (!mandate || !sameScope(mandate.data.scope, scope) || !mandate.data.allowedToolIds.includes("research.fetch"))
      throw new DomainError("watch_mandate_invalid");
    if (
      BigInt(parsed.budgetLimitUsdMicros) > BigInt(order.budgetLimitUsdMicros) ||
      BigInt(parsed.budgetLimitUsdMicros) > BigInt(mandate.data.maxCostUsdMicros)
    )
      throw new DomainError("watch_budget_exceeded");
    for (const source of parsed.sources) await this.authorize(scope, parsed, source);
    const previous = await this.repo.getDocument<ResearchReport>(scope, "artifact", parsed.predecessorArtifactId);
    if (!previous || !Array.isArray(previous.data.sources)) throw new DomainError("watch_predecessor_missing");
    const baseline: ResearchSource[] = [];
    for (const source of parsed.sources) {
      const referenced = previous.data.sources.find(
        (record) => record.url === source.url && record.status === "available",
      );
      const recorded = referenced
        ? await this.repo.getDocument<ResearchSource>(scope, "research-source", referenced.id)
        : null;
      if (
        !recorded ||
        recorded.data.url !== source.url ||
        recorded.data.status !== "available" ||
        !recorded.data.contentSha256 ||
        recorded.data.contentSha256 !== referenced?.contentSha256
      )
        throw new DomainError("watch_baseline_missing");
      baseline.push(recorded.data);
    }
    const id = randomUUID(),
      createdAt = this.now().toISOString();
    const definition: WatchDefinition = {
      ...parsed,
      id,
      scope,
      createdAt,
      nextCheckAt: createdAt,
      baselineSourceIds: baseline.map((source) => source.id),
      latestArtifactId: parsed.predecessorArtifactId,
    };
    await this.repo.transact(
      scope,
      [
        { kind: "research-watch", id, data: definition },
        { kind: "research-watch-definition", id, data: definition, immutable: true },
      ],
      { type: "research.watch_created", aggregateId: parsed.orderId, data: { watchId: id } },
    );
    return definition;
  }
  private async authorize(
    scope: Scope,
    watch: Pick<WatchDefinition, "orderId" | "mandateId" | "mandateVersion">,
    source: { targetId: string; url: string },
  ) {
    const args = { url: source.url },
      id = randomUUID();
    const action: ToolAction = {
      id,
      orderId: watch.orderId,
      runId: watch.orderId,
      scope,
      toolId: "research.fetch",
      toolVersion: 1,
      args,
      argumentsSha256: sha256(args),
      mandateId: watch.mandateId,
      mandateVersion: watch.mandateVersion,
      status: "proposed",
      evidenceRefs: [],
    };
    await this.repo.assertAuthorized(scope, { action, targetId: source.targetId, effect: "read", costUsdMicros: "0" });
  }
  async check(scope: Scope, id: string, input: { checkId: string }): Promise<WatchCheck> {
    z.uuid().parse(id);
    z.uuid().parse(input.checkId);
    let definition = await this.repo.getDocument<WatchDefinition>(scope, "research-watch", id);
    if (!definition) throw new DomainError("watch_not_found");
    const prior = await this.repo.getDocument<WatchCheck>(scope, "research-watch-check", input.checkId);
    if (prior) {
      if (prior.data.watchId !== id) throw new DomainError("idempotency_conflict");
      if (prior.data.status !== "running" || Date.parse(prior.data.leaseExpiresAt) > this.now().getTime())
        return prior.data;
      return this.finish(scope, definition, prior.data, [], [{ code: "check_interrupted" }]);
    }
    if (!definition.data.enabled) throw new DomainError("watch_disabled");
    if (definition.data.activeCheckId) {
      const active = await this.repo.getDocument<WatchCheck>(
        scope,
        "research-watch-check",
        definition.data.activeCheckId,
      );
      if (active?.data.status === "running" && Date.parse(active.data.leaseExpiresAt) <= this.now().getTime())
        await this.finish(scope, definition, active.data, [], [{ code: "check_interrupted" }]);
      throw new DomainError("watch_check_in_progress");
    }
    if (Date.parse(definition.data.nextCheckAt) > this.now().getTime()) throw new DomainError("watch_not_due");
    const startedAt = this.now().toISOString(),
      reservationId = shaUuid(`watch:${input.checkId}`);
    const check: WatchCheck = {
      id: input.checkId,
      watchId: id,
      orderId: definition.data.orderId,
      startedAt,
      leaseExpiresAt: new Date(this.now().getTime() + 600_000).toISOString(),
      status: "running",
      sourceIds: [],
      diffs: [],
      failures: [],
      recommendationStatus: "not_reassessed",
    };
    try {
      for (const source of definition.data.sources) await this.authorize(scope, definition.data, source);
      const budget = await this.repo.budget(scope.companyId);
      // Source reads and the deterministic diff have no model charge. Record the
      // zero-cost check in the shared ledger; model-based lead review is billed by Runtime.
      await this.repo.reserveAndTransact(
        scope,
        {
          id: reservationId,
          periodId: budget.periodId,
          orderId: check.orderId,
          amountUsdMicros: "0",
          mandateId: definition.data.mandateId,
          mandateVersion: definition.data.mandateVersion,
        },
        [
          {
            kind: "research-watch",
            id,
            data: { ...definition.data, activeCheckId: check.id },
            expectedRevision: definition.revision,
          },
          { kind: "research-watch-check", id: check.id, data: { ...check, reservationId }, expectedRevision: 0 },
        ],
        { type: "research.watch_check_started", aggregateId: check.orderId, data: { watchId: id, checkId: check.id } },
      );
      check.reservationId = reservationId;
    } catch (error) {
      if (error instanceof DomainError && ["revision_conflict", "immutable_document"].includes(error.code)) throw error;
      return this.finish(
        scope,
        definition,
        check,
        [],
        [{ code: error instanceof DomainError ? error.code : "watch_unavailable" }],
      );
    }
    definition = (await this.repo.getDocument<WatchDefinition>(scope, "research-watch", id))!;
    const observations = await Promise.all(
      definition.data.sources.map(async (source) => {
        try {
          await this.authorize(scope, definition.data, source);
          const observed = await this.sources.fetchSource(scope, source);
          const record = await this.repo.getDocument<ResearchSource>(scope, "research-source", observed.id);
          if (!record || record.data.url !== source.url || sha256(record.data) !== sha256(observed))
            throw new DomainError("source_evidence_missing");
          return { source: record.data };
        } catch (error) {
          return {
            failure: { url: source.url, code: error instanceof DomainError ? error.code : "source_unavailable" },
          };
        }
      }),
    );
    return this.finish(
      scope,
      definition,
      check,
      observations.flatMap((result) => (result.source ? [result.source] : [])),
      observations.flatMap((result) => (result.failure ? [result.failure] : [])),
    );
  }
  private async finish(
    scope: Scope,
    definition: { data: WatchDefinition; revision: number },
    check: WatchCheck,
    sources: ResearchSource[],
    failures: { url?: string; code: string }[],
  ): Promise<WatchCheck> {
    const existing = await this.repo.getDocument<WatchCheck>(scope, "research-watch-check", check.id);
    if (existing && existing.data.status !== "running") return existing.data;
    const current = await this.repo.getDocument<WatchDefinition>(scope, "research-watch", definition.data.id);
    if (!current || current.revision !== definition.revision) throw new DomainError("revision_conflict");
    const baseline = (
      await Promise.all(
        definition.data.baselineSourceIds.map((id) =>
          this.repo.getDocument<ResearchSource>(scope, "research-source", id),
        ),
      )
    ).map((doc) => doc?.data);
    const diffs: SourceDiff[] = [];
    for (const source of sources) {
      if (source.status !== "available" || !source.contentSha256) {
        failures.push({ url: source.url, code: source.failureCode ?? "source_unavailable" });
        continue;
      }
      const previous = baseline.find((prior) => prior?.url === source.url);
      if (!previous?.contentSha256) {
        failures.push({ url: source.url, code: "baseline_unavailable" });
        continue;
      }
      if (previous.contentSha256 !== source.contentSha256) diffs.push(sourceDiff(previous, source));
    }
    for (const source of definition.data.sources)
      if (!sources.some((observed) => observed.url === source.url) && !failures.some((f) => f.url === source.url))
        failures.push({ url: source.url, code: "source_not_checked" });
    const completedAt = this.now().toISOString(),
      result: WatchCheck = {
        ...check,
        completedAt,
        status: failures.length ? "incomplete" : diffs.length ? "changed" : "unchanged",
        sourceIds: sources.map((source) => source.id),
        diffs,
        failures,
        recommendationStatus: diffs.length ? "review_required" : "not_reassessed",
      };
    const mutations: Mutation[] = [];
    const previous = await this.repo.getDocument<ResearchReport & Partial<WatchArtifact>>(
      scope,
      "artifact",
      definition.data.latestArtifactId,
    );
    if (!previous) throw new DomainError("watch_predecessor_missing");
    const fingerprint = sha256(
      diffs.map((diff) => ({ url: diff.url, beforeSha256: diff.beforeSha256, afterSha256: diff.afterSha256 })),
    );
    if (
      diffs.length &&
      (fingerprint !== definition.data.lastChangeFingerprint ||
        previous.data.completeness !== (failures.length ? "incomplete" : "complete"))
    ) {
      const reviews = await this.repo.listDocuments<{
        artifactVersionId: string;
        decision: string;
        recommendation?: string;
      }>(scope, "research-watch-review");
      const priorReview = reviews.find((review) => review.data.artifactVersionId === previous.id);
      const previousRecommendation =
        priorReview?.data.decision === "revise"
          ? priorReview.data.recommendation!
          : (previous.data.previousRecommendation ?? previous.data.recommendation);
      const id = shaUuid(`watch-artifact:${check.id}`),
        allSources = [
          ...sources,
          ...baseline.filter(
            (source): source is ResearchSource => !!source && !sources.some((current) => current.id === source.id),
          ),
        ];
      const artifactInput = {
        orderId: check.orderId,
        title: `${definition.data.title}: Änderungsvorlage`,
        recommendation: `Fachliche Bewertung erforderlich (review_required). Bisherige Empfehlung: ${previousRecommendation}. Ihre weitere Gültigkeit ist durch diese Quellenprüfung nicht bestätigt.`,
        reasons: diffs.map((diff) => ({
          text: `Die Quelle ${diff.url} hat einen anderen belegten Inhalts-Hash (${diff.beforeSha256} → ${diff.afterSha256}). Inhaltliche Relevanz noch ungeprüft.`,
          sourceIds: [diff.beforeSourceId, diff.afterSourceId],
        })),
        comparison: diffs
          .map(
            (diff) =>
              `${diff.url}\nVorher: ${diff.removedExcerpt || "[keine Änderung im gespeicherten Auszug]"}\nNachher: ${diff.addedExcerpt || "[keine Änderung im gespeicherten Auszug]"}${diff.truncated ? "\nAuszug begrenzt; vollständige Bedeutung nicht bewertet." : ""}`,
          )
          .join("\n\n"),
        methodology:
          "Explizit mandatierte Quellen erneut abgerufen; SHA-256 der vollständigen Abrufantwort verglichen, gespeicherte Auszüge gegenübergestellt. Layoutänderungen sind keine automatisch relevante Empfehlung. Keine automatische Regel- oder Befugnisänderung.",
        sources: allSources,
        assumptions: [],
        gaps: failures.map((f) => `${f.url ?? "Prüfung"}: ${f.code}`),
        requiredDelivery: "internal" as const,
        predecessorId: previous.id,
      };
      const content = renderResearch({
          ...artifactInput,
          id,
          createdAt: completedAt,
          completeness: failures.length ? "incomplete" : "complete",
        }),
        sha = digest(content);
      await mkdir(path.join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
      try {
        await writeFile(path.join(this.directory, "blobs", sha), content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (digest(await readFile(path.join(this.directory, "blobs", sha))) !== sha)
          throw new DomainError("blob_corrupt");
      }
      const version =
        (await this.repo.listDocuments<WatchArtifact>(scope, "artifact")).filter(
          (artifact) => artifact.data.watchId === definition.data.id,
        ).length + 1;
      const artifact: WatchArtifact = {
        ...artifactInput,
        id,
        scope,
        sha256: sha,
        bytes: Buffer.byteLength(content),
        createdAt: completedAt,
        completeness: failures.length ? "incomplete" : "complete",
        delivery: "staged",
        mediaType: "text/markdown",
        canonicalStore: "internal",
        artifactId: definition.data.orderId,
        watchId: definition.data.id,
        checkId: check.id,
        version,
        recommendationStatus: "review_required",
        previousRecommendation,
        diffs,
      };
      result.artifactVersionId = id;
      mutations.push(
        { kind: "artifact", id, data: artifact, immutable: true },
        { kind: "research-delivery", id, data: { id, artifactVersionId: id, state: "delivered", target: "internal" } },
      );
    }
    const updated: WatchDefinition = {
      ...definition.data,
      activeCheckId: undefined,
      lastCheckId: check.id,
      lastStatus: result.status,
      nextCheckAt: new Date(this.now().getTime() + definition.data.cadenceSeconds * 1000).toISOString(),
      baselineSourceIds: failures.length
        ? definition.data.baselineSourceIds
        : definition.data.sources.map(
            (target) =>
              sources.find(
                (source) => source.url === target.url && source.status === "available" && !!source.contentSha256,
              )?.id ?? baseline.find((source) => source?.url === target.url)!.id,
          ),
      latestArtifactId: result.artifactVersionId ?? definition.data.latestArtifactId,
      ...(result.artifactVersionId ? { lastChangeFingerprint: fingerprint } : {}),
      ...(result.status === "incomplete" ? {} : { lastSuccessfulCheckAt: completedAt }),
    };
    mutations.push(
      { kind: "research-watch-check", id: check.id, data: result, expectedRevision: existing?.revision ?? 0 },
      { kind: "research-watch", id: definition.data.id, data: updated, expectedRevision: definition.revision },
    );
    const event = {
      type: "research.watch_checked",
      aggregateId: check.orderId,
      data: { watchId: definition.data.id, checkId: check.id, status: result.status },
    };
    if (check.reservationId)
      await this.repo.settleAndTransact(
        scope,
        { reservationId: check.reservationId, actualMicros: "0" },
        mutations,
        event,
      );
    else await this.repo.transact(scope, mutations, event);
    return result;
  }
  async review(
    scope: Scope,
    watchId: string,
    checkId: string,
    reviewerId: string,
    input: z.input<typeof watchReviewSchema>,
    reviewerKind: "employee" | "ceo" = "employee",
  ) {
    const parsed = watchReviewSchema.parse(input),
      watch = await this.repo.getDocument<WatchDefinition>(scope, "research-watch", watchId),
      check = await this.repo.getDocument<WatchCheck>(scope, "research-watch-check", checkId);
    if (!watch || !check || check.data.watchId !== watchId || !check.data.artifactVersionId)
      throw new DomainError("watch_review_missing");
    const order = await this.repo.getOrder(scope, watch.data.orderId);
    if (reviewerKind === "ceo") {
      const setup = await this.repo.snapshot(scope.companyId);
      if (setup.ceo.id !== reviewerId) throw new DomainError("ceo_required", undefined, 403);
    } else if (order.leadEmployeeId !== reviewerId) throw new DomainError("watch_lead_required", undefined, 403);
    if (check.data.status === "incomplete") throw new DomainError("watch_review_incomplete");
    const artifact = await this.repo.getDocument<WatchArtifact>(scope, "artifact", check.data.artifactVersionId);
    if (!artifact) throw new DomainError("artifact_missing");
    const id = shaUuid(`watch-review:${checkId}`),
      review = {
        id,
        watchId,
        checkId,
        artifactVersionId: artifact.id,
        artifactSha256: artifact.data.sha256,
        reviewerId,
        reviewerKind,
        ...parsed,
        createdAt: this.now().toISOString(),
        companyKnowledgeChanged: false,
      };
    const prior = await this.repo.getDocument<typeof review>(scope, "research-watch-review", id);
    if (prior) {
      const old = { ...prior.data, createdAt: undefined },
        next = { ...review, createdAt: undefined };
      if (sha256(old) !== sha256(next)) throw new DomainError("watch_review_conflict");
      return prior.data;
    }
    await this.repo.putDocument(scope, "research-watch-review", id, review, { immutable: true });
    return review;
  }
}
function sourceDiff(before: ResearchSource, after: ResearchSource): SourceDiff {
  const old = before.excerpt ?? "",
    next = after.excerpt ?? "";
  let prefix = 0,
    suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const removed = old.slice(prefix, old.length - suffix),
    added = next.slice(prefix, next.length - suffix);
  return {
    url: after.url,
    beforeSourceId: before.id,
    afterSourceId: after.id,
    beforeSha256: before.contentSha256!,
    afterSha256: after.contentSha256!,
    removedExcerpt: removed.slice(0, 5000),
    addedExcerpt: added.slice(0, 5000),
    truncated:
      removed.length > 5000 || added.length > 5000 || old.length >= 20000 || next.length >= 20000 || old === next,
    interpretation: "review_required",
  };
}
