import { shaUuid } from "../../packages/runtime/src/engine.ts";
import type { WorkerServer } from "./worker-server.ts";
import type { Express, Request, Response, NextFunction } from "express";
import { registerResearchWatchRoutes } from "./research-watch-routes.ts";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope, Order } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { WebsiteWorkflow, siteRevisionInputSchema } from "../../packages/domain/workflows/website.ts";
import { FinanceWorkflow, invoiceSchema, voucherInputSchema } from "../../packages/domain/workflows/finance.ts";
import { correctionInputSchema } from "../../packages/domain/workflows/finance-corrections.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import { Scheduler, Channels } from "../../packages/domain/workflows/automation.ts";
import { ResearchService, type ResearchReportInput } from "../../packages/domain/workflows/research.ts";
import { KnowledgeService } from "../../packages/domain/workflows/knowledge.ts";
import { workflowIntegrationPort, configuredExecutionPort, readConfiguration } from "./configuration.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest, Workspace } from "../../packages/tools/workspace.ts";

export type MutationHandler = (
  handler: (req: Request, res: Response) => Promise<unknown>,
) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
export function registerWorkflowRoutes(
  app: Express,
  options: {
    repo: Repository;
    directory: string;
    workers?: () => Promise<WorkerServer | undefined>;
    context: (res: Response) => Scope;
    order: (req: Request, res: Response) => Promise<Order>;
    mutate: MutationHandler;
  },
) {
  const { repo, directory, context, order, mutate } = options;
  registerResearchWatchRoutes(app, options);
  const website = new WebsiteWorkflow(repo, directory, () => configuredExecutionPort(directory, options.workers)),
    finance = new FinanceWorkflow(repo, directory),
    incident = new IncidentWorkflow(repo),
    scheduler = new Scheduler(repo),
    channels = new Channels(repo);
  async function voucherScope(req: Request, res: Response) {
    const id = z.uuid().parse(req.params.id),
      voucher = (await repo.listCompanyDocuments(context(res).companyId, "voucher")).find((d) => d.id === id);
    if (!voucher) throw new DomainError("voucher_not_found", "voucher_not_found", 404);
    return voucher.scope;
  }
  app.get("/api/v1/orders/:id/workflow", async (req, res) => {
    const o = await order(req, res);
    const doc = await repo.getDocument(
      o.scope,
      o.kind === "research" ? "research" : o.kind === "finance" ? "finance-workflow" : o.kind,
      o.id,
    );
    res.json(doc ? { ...(doc.data as object), revision: doc.revision } : { kind: o.kind, state: "not_started" });
  });
  app.post(
    "/api/v1/orders/:id/plan",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z
        .object({ steps: z.array(z.string().min(1)).min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1) })
        .parse(req.body);
      const revision = Number(req.header("If-Match")?.replaceAll('"', ""));
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new DomainError("revision_required", "revision_required", 428);
      return repo.commitPlan(o.scope, o.id, revision, b);
    }),
  );
  app.post(
    "/api/v1/orders/:id/website",
    mutate(async (req, res) => {
      const o = await order(req, res);
      if (o.kind !== "website") throw new DomainError("workflow_kind_mismatch");
      const b = z
        .object({ briefing: z.string().min(1), stack: z.enum(["static", "react", "wordpress"]).default("static") })
        .parse(req.body);
      return website.create(o.scope, o.id, b.briefing, b.stack);
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/concepts",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.concepts(o.scope, o.id, req.body.concepts);
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/select",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.select(o.scope, o.id, z.uuid().parse(req.body.conceptId));
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/build",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const ceo = await repo.getIdentity();
      if (!ceo) throw new DomainError("ceo_required");
      return website.build(o.scope, o.id, {
        scope: o.scope,
        orderId: o.id,
        authority: { kind: "ceo", ceoId: ceo.id, requestId: shaUuid(req.header("Idempotency-Key")!) },
      });
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/pins",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.pin(o.scope, o.id, req.body);
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/pins/:pinId/resolve",
    mutate(async (req, res) => {
      const o = await order(req, res),
        setup = await repo.snapshot(o.scope.companyId);
      const b = z.object({ artifactVersionId: z.uuid(), evidence: z.string().min(1) }).parse(req.body);
      return website.resolvePin(o.scope, o.id, z.uuid().parse(req.params.pinId), { ...b, reviewerId: setup.ceo.id });
    }),
  );
  app.get("/api/v1/orders/:id/website/pins", async (req, res) => {
    const o = await order(req, res);
    const pins = await repo.listDocuments<{ orderId: string }>(o.scope, "site-pin");
    res.json({ items: pins.filter((p) => p.data.orderId === o.id).map((p) => p.data), nextCursor: null });
  });
  app.post(
    "/api/v1/orders/:id/website/feedback/submit",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.submitFeedback(
        o.scope,
        o.id,
        z
          .object({ pinIds: z.array(z.uuid()).min(1).max(50) })
          .strict()
          .parse(req.body).pinIds,
      );
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/revision",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.revise(o.scope, o.id, siteRevisionInputSchema.parse(req.body));
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/review",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z
        .object({
          artifactVersionId: z.uuid(),
          checks: z
            .array(z.object({ name: z.string().min(1), passed: z.boolean(), evidence: z.string().min(1) }))
            .min(1),
        })
        .parse(req.body);
      const setup = await repo.snapshot(o.scope.companyId);
      return website.review(o.scope, o.id, { ...b, reviewerKind: "ceo", reviewerId: setup.ceo.id });
    }),
  );
  app.post(
    "/api/v1/orders/:id/website/accept",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return website.accept(o.scope, o.id, z.uuid().parse(req.body.artifactVersionId));
    }),
  );
  app.post(
    "/api/v1/orders/:id/finance/vouchers",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return finance.ingest(o.scope, o.id, voucherInputSchema.parse(req.body));
    }),
  );
  app.get("/api/v1/finance", async (_req, res) => {
    const companyId = context(res).companyId;
    const [snapshots, vouchers] = await Promise.all([
      repo.listCompanyDocuments<Record<string, unknown>>(companyId, "finance-snapshot"),
      repo.listCompanyDocuments<Record<string, unknown>>(companyId, "voucher"),
    ]);
    res.json({
      items: snapshots.map((d) => ({ ...d.data, scope: d.scope })),
      vouchers: vouchers.map((d) => ({ ...d.data, scope: d.scope, revision: d.revision })),
      nextCursor: null,
      bankImport: { available: false, reason: "bank_format_unconfigured" },
    });
  });
  app.get("/api/v1/finance/vouchers/:id/original", async (req, res) => {
    const scope = await voucherScope(req, res),
      id = z.uuid().parse(req.params.id);
    const voucher = await repo.getDocument<{ originalSha256: string; originalMediaType: string }>(scope, "voucher", id);
    if (!voucher) throw new DomainError("voucher_not_found", "voucher_not_found", 404);
    const hash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(voucher.data.originalSha256),
      content = await readFile(path.join(directory, "blobs", hash));
    if (digest(content) !== hash) throw new DomainError("original_blob_corrupt");
    const extension =
      ({ "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as Record<string, string>)[
        voucher.data.originalMediaType
      ] ?? "bin";
    res
      .set({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="voucher-${id}.${extension}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      .send(content);
  });
  app.post(
    "/api/v1/finance/snapshot",
    mutate(async (req, res) => finance.snapshot(context(res), z.array(invoiceSchema).parse(req.body.invoices))),
  );
  app.post(
    "/api/v1/finance/vouchers/:id/payment",
    mutate(async (req, res) =>
      finance.preparePayment(
        await voucherScope(req, res),
        z.uuid().parse(req.params.id),
        z
          .object({
            recipient: z.string().min(1),
            bankAccount: z.string().min(1),
            reference: z.string().min(1),
            amountMinor: z.string().regex(/^\d+$/),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/finance/vouchers/:id/correction",
    mutate(async (req, res) =>
      finance.correction(
        await voucherScope(req, res),
        z.uuid().parse(req.params.id),
        correctionInputSchema.parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/incidents",
    mutate(async (req, res) =>
      incident.ingest(
        context(res),
        z
          .object({
            provider: z.string(),
            accountId: z.string(),
            eventId: z.string(),
            targetId: z.uuid(),
            summary: z.string().min(1),
            budgetLimitUsdMicros: z.string().regex(/^\d+$/),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/orders/:id/incident",
    mutate(async (req, res) => {
      const o = await order(req, res);
      if (o.kind !== "incident") throw new DomainError("workflow_kind_mismatch");
      const targetId = z.uuid().parse(req.body.targetId);
      return repo.putDocument(o.scope, "incident", o.id, {
        id: o.id,
        orderId: o.id,
        targetId,
        state: "investigating",
        cause: { status: "unknown", explanation: "Noch kein Ursachenbeleg" },
        timeline: [{ at: new Date().toISOString(), kind: "alarm", targetId, data: { summary: o.goal } }],
      });
    }),
  );
  app.post(
    "/api/v1/orders/:id/incident/diagnosis",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return incident.diagnose(
        o.scope,
        o.id,
        z
          .object({
            evidence: z.string(),
            causeStatus: z.enum(["unknown", "suspected", "confirmed"]),
            explanation: z.string(),
          })
          .parse(req.body),
      );
    }),
  );
  app.post(
    "/api/v1/orders/:id/incident/prevention",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z.object({ goal: z.string().min(1), budgetLimitUsdMicros: z.string().regex(/^\d+$/) }).parse(req.body);
      return incident.prevention(o.scope, o.id, b.goal, b.budgetLimitUsdMicros);
    }),
  );
  app.post(
    "/api/v1/schedules",
    mutate(async (req, res) =>
      scheduler.create(
        context(res),
        z
          .object({
            cron: z.string(),
            timezone: z.string(),
            enabled: z.boolean(),
            goal: z.string().min(1),
            kind: z.enum(["website", "incident", "finance", "research"]),
            leadEmployeeId: z.uuid(),
            budgetLimitUsdMicros: z.string().regex(/^\d+$/),
            mandateId: z.uuid(),
            maxActiveOrders: z.number().int().min(1).max(3).default(3),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/channels/challenge",
    mutate(async (req, res) => {
      const c = context(res);
      const scope = req.body.scope
        ? (await import("../../packages/contracts/src/index.ts")).scopeSchema.parse(req.body.scope)
        : c;
      if (scope.companyId !== c.companyId) throw new DomainError("scope_denied", undefined, 403);
      await repo.listDocuments(scope, "channel-identity");
      return channels.challenge(scope, z.enum(["discord", "telegram"]).parse(req.body.provider));
    }),
  );
  app.get("/api/v1/orders/:id/research", async (req, res) => {
    const o = await order(req, res);
    const reports = await repo.listDocuments<{ orderId: string }>(o.scope, "artifact");
    const deliveries = await repo.listDocuments<{ artifactVersionId: string }>(o.scope, "research-delivery");
    res.json({
      items: reports
        .filter((r) => r.data.orderId === o.id)
        .map((r) => ({ ...r.data, deliveryRecord: deliveries.find((d) => d.data.artifactVersionId === r.id)?.data })),
      nextCursor: null,
    });
  });
  app.get("/api/v1/orders/:id/research/sources", async (req, res) => {
    const o = await order(req, res);
    res.json({ items: (await repo.listDocuments(o.scope, "research-source")).map((d) => d.data), nextCursor: null });
  });
  app.post(
    "/api/v1/orders/:id/research/sources",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z
        .object({
          targetId: z.uuid(),
          url: z.url(),
          title: z.string().min(1),
          mandateId: z.uuid(),
          mandateVersion: z.number().int().positive().default(1),
        })
        .parse(req.body);
      const port = await workflowIntegrationPort(repo, directory, o.scope, o.id, b.mandateId, b.mandateVersion);
      return new ResearchService(repo, directory, port).fetchSource(o.scope, b);
    }),
  );
  app.post(
    "/api/v1/orders/:id/research",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return new ResearchService(repo, directory).create(o.scope, {
        ...req.body,
        orderId: o.id,
      } as ResearchReportInput);
    }),
  );
  app.post(
    "/api/v1/orders/:id/research/deliver",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z
        .object({
          artifactVersionId: z.uuid(),
          targetId: z.uuid(),
          nativeFormat: z.literal("google-doc").optional(),
          targetConfigSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          path: z.string().optional(),
          folderId: z.string().optional(),
          expectedRevision: z.string().optional(),
          expectedRemoteHead: z.string().nullable().optional(),
          expectedFileSha256: z.string().nullable().optional(),
          mandateId: z.uuid(),
          mandateVersion: z.number().int().positive().default(1),
        })
        .parse(req.body);
      const port = await workflowIntegrationPort(repo, directory, o.scope, o.id, b.mandateId, b.mandateVersion);
      if (b.nativeFormat === "google-doc" && !b.targetConfigSha256) {
        const connection = (await readConfiguration(directory)).connections.find((c) => c.id === b.targetId);
        if (!connection || connection.provider !== "gdrive") throw new DomainError("target_not_configured");
        b.targetConfigSha256 = sha256(connection);
      }
      return new ResearchService(repo, directory, port).deliver(o.scope, b.artifactVersionId, b);
    }),
  );
  app.post(
    "/api/v1/knowledge",
    mutate(async (req, res) => {
      const b = z
        .object({
          title: z.string(),
          content: z.string(),
          type: z.enum(["specialist", "company_rule"]),
          leadEmployeeId: z.uuid(),
          sourceArtifactVersionIds: z.array(z.uuid()),
          supersedesId: z.uuid().optional(),
        })
        .parse(req.body);
      return new KnowledgeService(repo).propose(context(res), b);
    }),
  );
  app.post(
    "/api/v1/knowledge/:id/decision",
    mutate(async (req, res) => {
      const scope = context(res),
        setup = await repo.snapshot(scope.companyId);
      return new KnowledgeService(repo).decide(
        scope,
        z.uuid().parse(req.params.id),
        Number(req.header("If-Match")),
        { kind: "ceo", id: setup.ceo.id },
        z.enum(["approve", "reject"]).parse(req.body.decision),
      );
    }),
  );
  app.get("/api/v1/artifacts/:id/package", async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      artifact = (await repo.listCompanyDocuments(context(res).companyId, "artifact")).find((a) => a.id === id);
    if (!artifact) throw new DomainError("artifact_not_found", undefined, 404);
    const result = await website.packageArchive(artifact.scope, id);
    res
      .set({
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="ironcrew-site-${id}.tar.gz"`,
        "X-Content-SHA256": result.sha256,
        "X-Package-SHA256": result.packageSha256!,
        "Cache-Control": "no-store",
      })
      .send(result.content);
  });
  app.get("/api/v1/artifacts/:id/download", async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      setup = await repo.snapshot(context(res).companyId);
    const scopes = [
      ...setup.areas.map((a) => ({ companyId: a.companyId, areaId: a.id })),
      ...(await repo.listAllOrders(setup.company.id)).map((o) => o.scope),
    ];
    for (const scope of scopes) {
      let artifact;
      try {
        artifact = await repo.getDocument<{ sha256: string; mediaType: string }>(scope, "artifact", id);
      } catch {
        continue;
      }
      if (!artifact) continue;
      const hash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(artifact.data.sha256);
      const content = await readFile(await new Workspace(path.join(directory, "blobs")).resolve(hash));
      if (digest(content) !== hash) throw new DomainError("artifact_content_changed");
      res
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="ironcrew-${id}.bin"`,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-SHA256": hash,
          "Cache-Control": "no-store",
        })
        .send(content);
      return;
    }
    throw new DomainError("artifact_not_found", "artifact_not_found", 404);
  });
}
