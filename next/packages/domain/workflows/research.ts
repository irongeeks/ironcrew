import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, sha256 as bindingHash } from "../src/index.ts";
import { scopeSchema, type Scope } from "../../contracts/src/index.ts";
import type { Repository } from "../../persistence/src/index.ts";
import type { IntegrationService, AuthorizedIntegrationAction } from "../../integrations/src/service.ts";
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const sourceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    url: z.url(),
    observedAt: z.iso.datetime(),
    status: z.enum(["available", "unavailable"]),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    excerpt: z.string().max(20000).optional(),
    failureCode: z.string().optional(),
  })
  .strict();
const statementSchema = z.object({ text: z.string().min(1), sourceIds: z.array(z.string()).min(1) }).strict();
export const reportSchema = z
  .object({
    orderId: z.uuid(),
    title: z.string().min(1),
    recommendation: z.string().min(1),
    reasons: z.array(statementSchema).min(1),
    comparison: z.string(),
    methodology: z.string().min(1),
    sources: z.array(sourceSchema).min(1),
    assumptions: z.array(z.string()),
    gaps: z.array(z.string()),
    requiredDelivery: z.enum(["internal", "nextcloud", "gdrive", "git"]),
    predecessorId: z.uuid().optional(),
  })
  .strict();
export type ResearchSource = z.infer<typeof sourceSchema>;
export type ResearchReportInput = z.infer<typeof reportSchema>;
export interface ResearchReport extends ResearchReportInput {
  id: string;
  scope: Scope;
  sha256: string;
  bytes: number;
  createdAt: string;
  completeness: "complete" | "incomplete";
  delivery: "staged";
  mediaType: "text/markdown";
  canonicalStore: "internal";
  artifactId: string;
}
export interface ResearchDelivery {
  id: string;
  artifactVersionId: string;
  state: "pending" | "approval" | "delivered" | "conflict" | "failed" | "effect_unknown";
  actionId?: string;
  actionHash?: string;
  target: "internal" | "nextcloud" | "gdrive" | "git";
  externalId?: string;
  externalRevision?: string;
  errorCode?: string;
  gitCommit?: string;
  gitStageActionId?: string;
  gitStageHash?: string;
}
export interface ResearchDeliveryInput {
  targetId: string;
  nativeFormat?: "google-doc";
  targetConfigSha256?: string;
  path?: string;
  folderId?: string;
  expectedRevision?: string;
  expectedRemoteHead?: string | null;
  expectedFileSha256?: string | null;
}
/** Source text is evidence, never authority. Every external action crosses the integration authorization port. */
export class ResearchService {
  private readonly repo: Repository;
  private readonly directory: string;
  private readonly integrations?: Pick<IntegrationService, "execute">;
  constructor(repo: Repository, directory: string, integrations?: Pick<IntegrationService, "execute">) {
    this.repo = repo;
    this.directory = directory;
    this.integrations = integrations;
  }

  async fetchSource(scope: Scope, input: { targetId: string; url: string; title: string }): Promise<ResearchSource> {
    scopeSchema.parse(scope);
    if (!this.integrations) throw new DomainError("integration_not_configured");
    const url = z.url().parse(input.url);
    const id = randomUUID();
    try {
      const result = await this.integrations.execute({
        id,
        scope,
        targetId: input.targetId,
        toolId: "research.fetch",
        args: { url },
      });
      const data = z.object({ content: z.unknown() }).passthrough().parse(result.data);
      const content = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
      const source: ResearchSource = {
        id,
        title: input.title,
        url,
        observedAt: result.observedAt,
        status: "available",
        contentSha256: hash(content),
        excerpt: content.slice(0, 20000),
      };
      // Retain the actual source, not just a truncated excerpt and an unverifiable hash.
      await mkdir(join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
      const original = join(this.directory, "blobs", source.contentSha256!);
      try {
        await writeFile(original, content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hash(await readFile(original)) !== source.contentSha256) throw new DomainError("blob_corrupt");
      }
      await this.repo.putDocument(scope, "research-source", id, source, { immutable: true });
      return source;
    } catch (error) {
      const source: ResearchSource = {
        id,
        title: input.title,
        url,
        observedAt: new Date().toISOString(),
        status: "unavailable",
        failureCode:
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "source_unavailable",
      };
      await this.repo.putDocument(scope, "research-source", id, source, { immutable: true });
      return source;
    }
  }
  async create(scope: Scope, input: ResearchReportInput): Promise<ResearchReport> {
    scopeSchema.parse(scope);
    const parsed = reportSchema.parse(input);
    const order = await this.repo.getOrder(scope, parsed.orderId);
    if (order.kind !== "research") throw new DomainError("research_order_required");
    for (const source of parsed.sources) {
      const recorded = await this.repo.getDocument<ResearchSource>(scope, "research-source", source.id);
      if (!recorded || bindingHash(recorded.data) !== bindingHash(source))
        throw new DomainError("source_evidence_missing");
    }
    const sources = new Map(parsed.sources.map((s) => [s.id, s]));
    if (sources.size !== parsed.sources.length) throw new DomainError("duplicate_source");
    for (const reason of parsed.reasons)
      for (const id of reason.sourceIds)
        if (!sources.has(id) || sources.get(id)!.status !== "available")
          throw new DomainError("claim_source_unavailable");
    if (parsed.predecessorId) {
      const prior = await this.repo.getDocument<ResearchReport>(scope, "artifact", parsed.predecessorId);
      if (!prior || prior.data.orderId !== order.id) throw new DomainError("predecessor_scope_mismatch");
    }
    const id = randomUUID(),
      createdAt = new Date().toISOString(),
      completeness =
        parsed.sources.some((s) => s.status === "unavailable") || parsed.gaps.length ? "incomplete" : "complete";
    const content = renderResearch({ ...parsed, id, createdAt, completeness });
    const sha256 = hash(content);
    await mkdir(join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
    const blob = join(this.directory, "blobs", sha256);
    try {
      await writeFile(blob, content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hash(await readFile(blob)) !== sha256) throw new DomainError("blob_corrupt");
    }
    const artifact: ResearchReport = {
      ...parsed,
      id,
      scope,
      sha256,
      bytes: Buffer.byteLength(content),
      createdAt,
      completeness,
      delivery: "staged",
      mediaType: "text/markdown",
      canonicalStore: "internal",
      artifactId: order.id,
    };
    await this.repo.transact(
      scope,
      [
        { kind: "artifact", id, data: artifact, immutable: true },
        {
          kind: "research-delivery",
          id,
          data: {
            id,
            artifactVersionId: id,
            state: parsed.requiredDelivery === "internal" ? "delivered" : "pending",
            target: parsed.requiredDelivery,
          } satisfies ResearchDelivery,
        },
      ],
      { type: "research.version_created", aggregateId: order.id, data: { artifactVersionId: id, completeness } },
    );
    return artifact;
  }
  async deliver(scope: Scope, artifactVersionId: string, input: ResearchDeliveryInput): Promise<ResearchDelivery> {
    const artifact = await this.repo.getDocument<ResearchReport>(scope, "artifact", artifactVersionId);
    if (!artifact) throw new DomainError("artifact_missing");
    const state = await this.repo.getDocument<ResearchDelivery>(scope, "research-delivery", artifactVersionId);
    if (!state) throw new DomainError("delivery_missing");
    if (state.data.state === "delivered") return state.data;
    if (state.data.state === "effect_unknown") throw new DomainError("reconciliation_required");
    if (!this.integrations) throw new DomainError("integration_not_configured");
    const content = await readFile(join(this.directory, "blobs", artifact.data.sha256), "utf8");
    if (hash(content) !== artifact.data.sha256) throw new DomainError("blob_corrupt");
    if (state.data.target === "git") return this.deliverGit(scope, artifact.data, state, input, content);
    if (input.nativeFormat && state.data.target !== "gdrive") throw new DomainError("native_delivery_target_mismatch");
    const args =
      state.data.target === "nextcloud"
        ? {
            path: z.string().min(1).parse(input.path),
            content,
            mediaType: "text/markdown",
            ...(input.expectedRevision ? { expectedEtag: input.expectedRevision } : { createOnly: true }),
          }
        : input.nativeFormat === "google-doc"
          ? {
              folderId: z.string().min(1).parse(input.folderId),
              title: artifact.data.title.slice(0, 200),
              text: content,
              targetConfigSha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(input.targetConfigSha256),
            }
          : {
              folderId: z.string().min(1).parse(input.folderId),
              name: `research-${artifactVersionId}.md`,
              content,
              mediaType: "text/markdown",
            };
    const actionHash = bindingHash({ targetId: input.targetId, args });
    if (state.data.state === "approval" && state.data.actionHash !== actionHash)
      throw new DomainError("delivery_approval_binding_changed");
    if (state.data.state === "conflict" && (!input.expectedRevision || state.data.actionHash === actionHash))
      throw new DomainError("conflict_resolution_required");
    const actionId = state.data.state === "approval" ? state.data.actionId! : randomUUID();
    const pending: ResearchDelivery = { ...state.data, actionId, actionHash };
    const action: AuthorizedIntegrationAction = {
      id: actionId,
      scope,
      targetId: input.targetId,
      toolId:
        state.data.target === "nextcloud"
          ? "nextcloud.write"
          : input.nativeFormat === "google-doc"
            ? "gdocs.create"
            : "gdrive.create",
      args,
    };
    await this.repo.putDocument(
      scope,
      "research-delivery",
      artifactVersionId,
      { ...pending, state: "effect_unknown" },
      { expectedRevision: state.revision },
    );
    try {
      const result = await this.integrations.execute(action);
      if (result.effectStatus !== "succeeded" || !result.externalId) throw new DomainError("delivery_unconfirmed");
      const data = result.data as Record<string, unknown>;
      const delivered: ResearchDelivery = {
        ...pending,
        state: "delivered",
        externalId: result.externalId,
        externalRevision:
          typeof data.etag === "string" ? data.etag : typeof data.version === "string" ? data.version : undefined,
      };
      await this.repo.putDocument(scope, "research-delivery", artifactVersionId, delivered, {
        expectedRevision: state.revision + 1,
      });
      return delivered;
    } catch (error) {
      const code =
        typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "delivery_failed";
      const effect =
        (error as { effectStatus?: string; effect?: string }).effectStatus ?? (error as { effect?: string }).effect;
      const status =
        code === "approval_required"
          ? "approval"
          : code === "conflict"
            ? "conflict"
            : effect === "failed" || code === "integration_failed"
              ? "failed"
              : "effect_unknown";
      const failed: ResearchDelivery = { ...pending, state: status, errorCode: code };
      await this.repo.putDocument(scope, "research-delivery", artifactVersionId, failed, {
        expectedRevision: state.revision + 1,
      });
      return failed;
    }
  }
  private async deliverGit(
    scope: Scope,
    artifact: ResearchReport,
    initial: { data: ResearchDelivery; revision: number },
    input: ResearchDeliveryInput,
    content: string,
  ): Promise<ResearchDelivery> {
    const revisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const stageArgs = {
      expectedHead: revisionSchema.parse(input.expectedRevision),
      message: `Research report ${artifact.id}: ${artifact.title}`.slice(0, 1000),
      changes: [
        {
          path: input.path ?? `reports/research-${artifact.id}.md`,
          content,
          expectedSha256: input.expectedFileSha256 ?? null,
        },
      ],
    };
    const expectedRemoteHead = revisionSchema.nullable().parse(input.expectedRemoteHead ?? null);
    const stageHash = bindingHash({ targetId: input.targetId, args: stageArgs });
    if (initial.data.gitCommit && initial.data.gitStageHash !== stageHash)
      throw new DomainError("delivery_staged_binding_changed");
    const requestHash = bindingHash({ stageHash, expectedRemoteHead });
    if (initial.data.state === "approval" && initial.data.actionHash !== requestHash)
      throw new DomainError("delivery_approval_binding_changed");
    if (initial.data.state === "conflict" && initial.data.actionHash === requestHash)
      throw new DomainError("conflict_resolution_required");
    let delivery = initial.data;
    let revision = initial.revision;
    const persist = async (next: ResearchDelivery) => {
      const stored = await this.repo.putDocument(scope, "research-delivery", artifact.id, next, {
        expectedRevision: revision,
      });
      delivery = next;
      revision = stored.revision;
    };
    const fail = async (error: unknown) => {
      const details = error as { code?: string; effectStatus?: string; effect?: string };
      const code = details.code ?? "delivery_failed";
      const status =
        code === "approval_required"
          ? "approval"
          : (details.effectStatus ?? details.effect) === "effect_unknown"
            ? "effect_unknown"
            : code === "conflict"
              ? "conflict"
              : (details.effectStatus ?? details.effect) === "failed"
                ? "failed"
                : "effect_unknown";
      await persist({ ...delivery, state: status, errorCode: code });
      return delivery;
    };
    if (!delivery.gitCommit) {
      const stageActionId = randomUUID();
      await persist({
        ...delivery,
        state: "effect_unknown",
        gitStageActionId: stageActionId,
        gitStageHash: stageHash,
        actionHash: requestHash,
      });
      try {
        const staged = await this.integrations!.execute({
          id: stageActionId,
          scope,
          targetId: input.targetId,
          toolId: "git.stage",
          args: stageArgs,
        });
        if (staged.effectStatus !== "succeeded") throw new DomainError("git_stage_unconfirmed");
        const commit = revisionSchema.parse((staged.data as { commit?: string }).commit);
        await persist({ ...delivery, state: "pending", gitCommit: commit });
      } catch (error) {
        return fail(error);
      }
    }
    const pushActionId = initial.data.state === "approval" ? initial.data.actionId! : randomUUID();
    await persist({ ...delivery, state: "effect_unknown", actionId: pushActionId, actionHash: requestHash });
    try {
      const pushed = await this.integrations!.execute({
        id: pushActionId,
        scope,
        targetId: input.targetId,
        toolId: "git.push",
        args: { commit: delivery.gitCommit!, expectedRemoteHead },
      });
      if (pushed.effectStatus !== "succeeded" || !pushed.externalId) throw new DomainError("delivery_unconfirmed");
      await persist({
        ...delivery,
        state: "delivered",
        externalId: pushed.externalId,
        externalRevision: delivery.gitCommit,
        errorCode: undefined,
      });
      return delivery;
    } catch (error) {
      return fail(error);
    }
  }
  async readiness(scope: Scope, artifactVersionId: string) {
    const artifact = await this.repo.getDocument<ResearchReport>(scope, "artifact", artifactVersionId),
      delivery = await this.repo.getDocument<ResearchDelivery>(scope, "research-delivery", artifactVersionId);
    if (!artifact || !delivery) throw new DomainError("artifact_missing");
    const reviews = (
      await this.repo.listDocuments<{ artifactVersionId: string; verdict: string; createdAt: string }>(scope, "review")
    )
      .filter((r) => r.data.artifactVersionId === artifactVersionId)
      .sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt));
    return {
      complete:
        artifact.data.completeness === "complete" &&
        delivery.data.state === "delivered" &&
        reviews.at(-1)?.data.verdict === "passed",
      completeness: artifact.data.completeness,
      delivery: delivery.data.state,
    };
  }
}
export function renderResearch(
  report: ResearchReportInput & { id: string; createdAt: string; completeness: string },
): string {
  const bullet = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join("\n") : "- Keine angegeben.");
  return `# ${report.title}\n\nVersion: ${report.id} · ${report.createdAt}\nStatus: ${report.completeness}\n\n## Empfehlung\n\n${report.recommendation}\n\n## Wesentliche Gründe\n\n${bullet(report.reasons.map((r) => `${r.text} [${r.sourceIds.join(", ")}]`))}\n\n## Vergleich\n\n${report.comparison}\n\n## Methodik\n\n${report.methodology}\n\n## Annahmen\n\n${bullet(report.assumptions)}\n\n## Lücken und Unsicherheiten\n\n${bullet(report.gaps)}\n\n## Quellen\n\n${report.sources.map((s) => `- [${s.id}] ${s.title} — ${s.url}\n  Abruf: ${s.observedAt}; Status: ${s.status}; SHA-256: ${s.contentSha256 ?? "nicht verfügbar"}`).join("\n")}\n`;
}
