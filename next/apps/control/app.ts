import { APP_VERSION } from "../../packages/contracts/src/version.ts";
import { registerMailInboxRoutes } from "./mail-inbox-routes.ts";
import { configuredMailInboxService } from "./mail-inbox-configured.ts";
import { registerReleaseFeedRoutes } from "./release-feed-routes.ts";
import { FinanceService } from "./finance-service.ts";
import { registerFinanceRoutes } from "./finance-routes.ts";
import { registerFinanceCorrectionRoutes } from "./finance-correction-routes.ts";
import { registerIntegrationCostRoutes } from "./integration-cost-routes.ts";
import { IntegrationCostService } from "./integration-costs.ts";
import { ModelCostService } from "./model-cost-service.ts";
import { registerModelCostRoutes } from "./model-cost-routes.ts";
import { registerEntityRoutes } from "./entity-routes.ts";
import { WebsiteCareService } from "./website-care-service.ts";
import { registerWebsiteCareRoutes } from "./website-care-routes.ts";
import { IncidentService } from "./incident-service.ts";
import { registerIncidentRoutes } from "./incident-routes.ts";
import { HostingService } from "./hosting-service.ts";
import { registerHostingRoutes } from "./hosting-routes.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BackupResult } from "../../packages/operations/src/index.ts";
import { MaintenanceService, type OnlineBackup } from "./maintenance-service.ts";
import { registerMaintenanceRoutes } from "./maintenance-routes.ts";
import { Worker } from "node:worker_threads";
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Repository } from "../../packages/persistence/src/index.ts";
import type { Order, Mandate } from "../../packages/contracts/src/index.ts";
import {
  scopeSchema,
  orderCreateSchema,
  mandateSchema,
  microsSchema,
  setupSchema,
} from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { Runtime, shaUuid } from "../../packages/runtime/src/engine.ts";
import { coordinationOrders, coordinationSchema, type Coordination } from "../../packages/runtime/src/coordination.ts";
import {
  authMiddleware,
  defaultScope,
  sessionContext,
  createSession,
  login,
  verifySetupToken,
  consumeSetupToken,
  hashPassword,
  passwordSchema,
  type AuthContext,
} from "./auth.ts";

import { configSchema, readConfiguration, saveConfiguration, configuredRuntime } from "./configuration.ts";
import { route as selectModel, type Model } from "../../packages/runtime/src/openrouter.ts";

import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { registerRatingRoutes } from "./rating-routes.ts";
import { registerAdminRoutes } from "./admin-routes.ts";
import { ModelRatings, ratingRoutingStats } from "../../packages/runtime/src/ratings.ts";
import type { WorkerServer } from "./worker-server.ts";

import { refreshCatalog } from "./catalog.ts";
import { registerChannelRoutes } from "./channel-routes.ts";

type Options = {
  repo: Repository;
  directory: string;
  publicOrigin: string;
  runtime?: Runtime;
  webDirectory?: string;
  workers?: () => Promise<WorkerServer | undefined>;
  workerConnectUrl?: string;
  releaseIdentity?: { version: string; releaseManifestSha256: string };
  updateExecutor?: import("./maintenance-service.ts").MaintenanceOptions["updateExecutor"];
  updateConfigurationFingerprint?: () => Promise<string>;
  hostingService?: HostingService;
  incidentService?: IncidentService;
  modelCostService?: ModelCostService;
  websiteCareService?: WebsiteCareService;
};
export function createApp(options: Options) {
  const { repo, directory, publicOrigin } = options;
  const app = express();
  const instanceId = randomUUID();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'"],
          "frame-src": ["'self'", "http://127.0.0.1:8792"],
          "worker-src": ["'self'", "blob:"],
        },
      },
    }),
  );
  let activeWrites = 0,
    activeHandlers = 0,
    shuttingDown = false,
    maintenance = false,
    runtimeUpdating = false;
  const writeOwner = new AsyncLocalStorage<boolean>();
  const beginWrite = () => {
    if (maintenance) throw new DomainError("maintenance_active", "maintenance_active", 423);
    activeHandlers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        activeHandlers--;
      }
    };
  };
  const tracked =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      let release: (() => void) | undefined;
      try {
        release = beginWrite();
        await writeOwner.run(true, () => handler(req, res));
      } catch (error) {
        next(error);
      } finally {
        release?.();
      }
    };
  app.locals.canRunMaintenance = () =>
    !maintenance && !runtimeUpdating && !shuttingDown && activeWrites === 0 && activeHandlers === 0;
  app.locals.runAdministrativeTask = async (operation: () => Promise<unknown>) => {
    if (!app.locals.canRunMaintenance()) return false;
    const release = beginWrite();
    try {
      await operation();
      return true;
    } finally {
      release();
    }
  };
  app.locals.drainWrites = async () => {
    shuttingDown = true;
    maintenance = true;
    while (activeWrites > 0 || activeHandlers > 0 || runtimeUpdating)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-ID", res.locals.requestId as string);
    next();
  });
  app.use("/api/v1", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (maintenance) return next(new DomainError("maintenance_active", "maintenance_active", 423));
    activeWrites++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeWrites--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
  // These bounded HTTPS streams use one-time worker transfer tickets, not browser sessions.
  // Keep them ahead of the JSON parser, and include their complete stream lifetime in shutdown/backup drains.
  const transfer = async (req: Request, res: Response, next: NextFunction) => {
    let release: (() => void) | undefined;
    try {
      release = beginWrite();
      const workers = await options.workers?.();
      if (!workers) throw new DomainError("worker_transport_unavailable", "worker_transport_unavailable", 503);
      await workers.handleTransfer(req, res);
    } catch (error) {
      next(error);
    } finally {
      release?.();
    }
  };
  app.post("/api/v1/worker-transfers/:jobId/start", transfer);
  app.get("/api/v1/worker-transfers/:jobId/input/:index", transfer);
  app.put("/api/v1/worker-transfers/:jobId/output/:index", transfer);
  registerChannelRoutes(app, {
    beginWrite,
    repo,
    directory,
    assertWritable: () => {
      if (maintenance) throw new DomainError("maintenance_active", "maintenance_active", 423);
    },
  });
  app.use(express.json({ limit: "12mb" }));
  app.locals.getRuntime = () => (runtimeUpdating ? undefined : options.runtime);
  const auth = authMiddleware(repo, publicOrigin);
  const context = (res: Response) => (res.locals.auth as AuthContext).scope;
  const list = (res: Response, items: unknown[], req?: Request) => {
    const after = Number(req?.query.cursor ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new DomainError("cursor_invalid", "cursor_invalid", 400);
    const limit = Math.min(100, Number(req?.query.limit ?? 100));
    if (!Number.isSafeInteger(limit) || limit < 1) throw new DomainError("limit_invalid", "limit_invalid", 400);
    res.json({
      items: items.slice(after, after + limit),
      nextCursor: after + limit < items.length ? String(after + limit) : null,
    });
  };
  const revision = (req: Request) => {
    const value = Number(req.header("If-Match")?.replaceAll('"', ""));
    if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("revision_required", "revision_required", 428);
    return value;
  };
  async function order(req: Request, res: Response): Promise<Order> {
    const id = z.uuid().parse(req.params.id);
    const all = await repo.listAllOrders(context(res).companyId);
    const found = all.find((o) => o.id === id);
    if (!found) throw new DomainError("order_not_found", "order_not_found", 404);
    return repo.getOrder(found.scope, id);
  }
  type RequestReceipt = {
    hash: string;
    state: string;
    response?: unknown;
    error?: { code: string; status: number };
    oneTime?: boolean;
  };
  const mutate =
    (handler: (req: Request, res: Response) => Promise<unknown>, settings?: { oneTime?: boolean }) =>
    async (req: Request, res: Response, next: NextFunction) => {
      let release: (() => void) | undefined;
      try {
        release = beginWrite();
        const key = req.header("Idempotency-Key");
        if (!key || key.length > 200)
          throw new DomainError("idempotency_key_required", "idempotency_key_required", 400);
        const scope = context(res),
          id = shaUuid(key),
          hash = sha256({
            method: req.method,
            path: req.originalUrl,
            body: req.body ?? null,
            ifMatch: req.header("If-Match") ?? null,
          });
        const prior = await repo.getDocument<RequestReceipt>(scope, "request", id);
        if (prior) {
          if (prior.data.hash !== hash) throw new DomainError("idempotency_conflict");
          if (prior.data.state === "failed" && prior.data.error)
            throw new DomainError(prior.data.error.code, prior.data.error.code, prior.data.error.status);
          if (prior.data.state === "complete") {
            if (prior.data.oneTime)
              throw new DomainError("credential_already_issued", "credential_already_issued", 410);
            return void res.json(prior.data.response);
          }
          throw new DomainError("request_effect_unknown");
        }
        await repo.putDocument(scope, "request", id, { hash, state: "started" });
        let result: unknown;
        try {
          result = await writeOwner.run(true, () => handler(req, res));
        } catch (error) {
          const known =
            error instanceof z.ZodError
              ? { code: "validation_failed", status: 400 }
              : error instanceof DomainError && error.status >= 400 && error.status < 500
                ? { code: error.code, status: error.status }
                : undefined;
          if (known)
            await repo.putDocument(
              scope,
              "request",
              id,
              { hash, state: "failed", error: known },
              { expectedRevision: 1 },
            );
          throw error;
        }
        const response = settings?.oneTime ? { credentialIssued: true } : result;
        await repo.putDocument(
          scope,
          "request",
          id,
          { hash, state: "complete", response, ...(settings?.oneTime ? { oneTime: true } : {}) },
          { expectedRevision: 1 },
        );
        res.json(result);
      } catch (error) {
        next(error);
      } finally {
        release?.();
      }
    };
  app.get("/api/v1/health", async (_req, res) =>
    res.json({
      status: "ok",
      database: await repo.health(),
      version: options.releaseIdentity?.version ?? APP_VERSION,
      ...(options.releaseIdentity ? { releaseManifestSha256: options.releaseIdentity.releaseManifestSha256 } : {}),
      instanceId,
    }),
  );
  app.get("/api/v1/session", async (req, res) => {
    const setup = await repo.setupState();
    if (!setup) return void res.json({ authenticated: false, setupRequired: true });
    const ctx = await sessionContext(repo, req);
    res.json({ authenticated: !!ctx, csrfToken: ctx?.csrf, setupRequired: false });
  });
  const loginLimit = rateLimit({
    windowMs: 900_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.post(
    "/api/v1/session",
    loginLimit,
    tracked(async (req, res) => {
      const body = z.object({ password: passwordSchema }).parse(req.body);
      const origin = req.header("Origin");
      if (origin && origin !== publicOrigin) throw new DomainError("origin_denied", "origin_denied", 403);
      await login(repo, body.password);
      res.json({ authenticated: true, csrfToken: await createSession(repo, res, publicOrigin.startsWith("https:")) });
    }),
  );
  app.delete(
    "/api/v1/session",
    auth,
    tracked(async (_req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const doc = await repo.getDocument<Record<string, unknown>>(ctx.scope, "session", ctx.sessionId);
      if (doc)
        await repo.putDocument(
          ctx.scope,
          "session",
          ctx.sessionId,
          { ...doc.data, revoked: true },
          { expectedRevision: doc.revision },
        );
      res.clearCookie("ironcrew_session", { path: "/" });
      res.json({ authenticated: false });
    }),
  );
  app.get("/api/v1/setup", async (req, res) => {
    const setup = await repo.setupState();
    if (setup) {
      const ctx = await sessionContext(repo, req);
      if (!ctx) throw new DomainError("unauthorized", "unauthorized", 401);
      const progress = await repo.getDocument(ctx.scope, "setup-progress", setup.company.id);
      res.json(progress?.data ?? { step: 1, data: {} });
    } else {
      await verifySetupToken(directory, req.header("X-Setup-Token") ?? "");
      let progress: unknown = { step: 0, data: {} };
      try {
        progress = JSON.parse(await readFile(path.join(directory, "setup-progress.json"), "utf8"));
      } catch {
        /* No saved setup progress yet. */
      }
      res.json(progress);
    }
  });
  app.post(
    "/api/v1/setup",
    loginLimit,
    tracked(async (req, res) => {
      if (await repo.setupState()) throw new DomainError("already_setup");
      const b = z
        .object({
          token: z.string(),
          companyName: setupSchema.shape.companyName,
          ceoName: setupSchema.shape.ceoName,
          password: passwordSchema,
          timezone: setupSchema.shape.timezone,
          locale: z.enum(["de", "en"]).default("de"),
        })
        .parse(req.body);
      await verifySetupToken(directory, b.token);
      const passwordHash = await hashPassword(b.password);
      await consumeSetupToken(directory);
      const setup = await repo.setup({
        companyName: b.companyName,
        ceoName: b.ceoName,
        passwordHash,
        timezone: b.timezone,
        budgetLimitUsdMicros: "0",
      });
      const scope = await defaultScope(repo);
      await repo.putDocument(scope, "company-settings", setup.company.id, {
        locale: b.locale,
        name: b.companyName,
        timezone: b.timezone,
      });
      res.json({
        ...setup,
        csrfToken: await createSession(repo, res, publicOrigin.startsWith("https:")),
        authenticated: true,
      });
    }),
  );
  app.patch(
    "/api/v1/setup",
    tracked(async (req, res) => {
      const parsed = z
        .object({ step: z.number().int().min(0).max(8), data: z.record(z.string(), z.unknown()) })
        .parse(req.body);
      if (Object.keys(parsed.data).some((k) => /password|token|secret(?!ref)/i.test(k)))
        throw new DomainError("setup_secret_forbidden");
      const setup = await repo.setupState();
      if (!setup) {
        await verifySetupToken(directory, req.header("X-Setup-Token") ?? "");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, "setup-progress.json"), JSON.stringify(parsed), { mode: 0o600 });
        res.json(parsed);
      } else {
        await new Promise<void>((resolve, reject) => auth(req, res, (e) => (e ? reject(e) : resolve())));
        const scope = context(res);
        const prior = await repo.getDocument(scope, "setup-progress", setup.company.id);
        await repo.putDocument(scope, "setup-progress", setup.company.id, parsed, {
          expectedRevision: prior?.revision ?? 0,
        });
        res.json(parsed);
      }
    }),
  );
  app.use("/api/v1", auth);
  app.get("/api/v1/company", async (_req, res) => {
    const setup = await repo.snapshot(context(res).companyId);
    const settings = await repo.getDocument<Record<string, unknown>>(
      context(res),
      "company-settings",
      setup.company.id,
    );
    res.json({ ...setup.company, ...settings?.data, revision: settings?.revision ?? 1, ceo: setup.ceo });
  });
  app.patch(
    "/api/v1/company",
    mutate(async (req, res) => {
      const b = z
        .object({
          name: z.string().min(1).optional(),
          locale: z.enum(["de", "en"]).optional(),
          timezone: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      if (b.timezone) new Intl.DateTimeFormat("en", { timeZone: b.timezone });
      const scope = context(res);
      const prior = await repo.getDocument<Record<string, unknown>>(scope, "company-settings", scope.companyId);
      return repo.putDocument(
        scope,
        "company-settings",
        scope.companyId,
        { ...prior?.data, ...b },
        { expectedRevision: revision(req) },
      );
    }),
  );
  app.get("/api/v1/employees", async (req, res) => {
    const setup = await repo.snapshot(context(res).companyId);
    const overlays = await repo.listDocuments<Record<string, unknown>>(context(res), "employee-profile");
    list(
      res,
      setup.employees.map((e) => {
        const overlay = overlays.find((o) => o.id === e.id);
        return { ...e, ...overlay?.data, revision: (overlay?.revision ?? 0) + 1 };
      }),
      req,
    );
  });
  app.patch(
    "/api/v1/employees/:id",
    mutate(async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        scope = context(res);
      const setup = await repo.snapshot(scope.companyId);
      if (!setup.employees.some((e) => e.id === id)) throw new DomainError("employee_not_found");
      const b = z
        .object({
          displayName: z.string().min(1),
          persona: z.string(),
          appearance: z.string(),
          modelOverride: z.string().nullable().optional(),
        })
        .partial()
        .strict()
        .parse(req.body);
      const prior = await repo.getDocument<Record<string, unknown>>(scope, "employee-profile", id);
      const expected = revision(req);
      if (expected !== (prior?.revision ?? 0) + 1) throw new DomainError("revision_conflict");
      const updated = await repo.putDocument(
        scope,
        "employee-profile",
        id,
        { ...prior?.data, ...b },
        { expectedRevision: expected - 1 },
      );
      return { ...updated, revision: updated.revision + 1 };
    }),
  );
  app.get("/api/v1/areas", async (req, res) => list(res, (await repo.snapshot(context(res).companyId)).areas, req));
  app.post(
    "/api/v1/areas",
    mutate(async (req, res) =>
      repo.createArea(
        context(res).companyId,
        z.object({ name: z.string().min(1), visibility: z.enum(["company", "private"]) }).parse(req.body),
      ),
    ),
  );
  app.get("/api/v1/orders", async (req, res) => {
    let orders = await repo.listAllOrders(context(res).companyId);
    if (req.query.status) orders = orders.filter((o) => o.status === req.query.status);
    list(res, await coordinationOrders(repo, orders), req);
  });
  app.post(
    "/api/v1/orders",
    mutate(async (req, res) => {
      const scope = scopeSchema.parse(req.body.scope);
      if (scope.companyId !== context(res).companyId) throw new DomainError("scope_denied", "scope_denied", 403);
      return repo.createOrder(scope, orderCreateSchema.parse(req.body));
    }),
  );
  app.get("/api/v1/orders/:id", async (req, res) =>
    res.json((await coordinationOrders(repo, [await order(req, res)]))[0]),
  );
  app.get("/api/v1/orders/:id/coordination", async (req, res) => {
    const o = await order(req, res);
    const records = await repo.listDocuments<Coordination>(o.scope, "coordination");
    list(
      res,
      records.filter((d) => d.data.orderId === o.id).map((d) => coordinationSchema.parse(d.data)),
      req,
    );
  });
  app.post(
    "/api/v1/orders/:id/transition",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const b = z
        .object({
          status: z.enum(["planning", "ready", "paused", "running", "cancelled", "reviewing", "completed"]),
          planVersion: z.number().int().positive().optional(),
        })
        .parse(req.body);
      return repo.updateOrder(o.scope, o.id, revision(req), b);
    }),
  );
  app.patch(
    "/api/v1/orders/:id/lead",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return repo.changeLead(o.scope, o.id, revision(req), z.uuid().parse(req.body.leadEmployeeId));
    }),
  );
  app.post(
    "/api/v1/orders/:id/model-response/discard",
    mutate(async (req, res) => {
      if (runtimeUpdating || !options.runtime) throw new DomainError("model_not_configured");
      const o = await order(req, res);
      const { turnId } = z.object({ turnId: z.uuid() }).strict().parse(req.body);
      const identity = await repo.getIdentity();
      if (!identity || identity.companyId !== context(res).companyId)
        throw new DomainError("ceo_required", undefined, 403);
      return options.runtime.discardModelResponse(o.scope, o.id, turnId, revision(req), identity.id);
    }),
  );
  app.post(
    "/api/v1/orders/:id/run",
    mutate(async (req, res) => {
      if (runtimeUpdating) throw new DomainError("runtime_updating");
      if (!options.runtime) throw new DomainError("model_not_configured", "model_not_configured", 409);
      const o = await order(req, res);
      if (await repo.getDocument(o.scope, "run", o.id)) return options.runtime.resume(o.scope, o.id);
      const b = z
        .object({
          mandateId: z.uuid(),
          mandateVersion: z.number().int().positive().default(1),
          modelId: z.string().optional(),
        })
        .parse(req.body);
      const mandate = await repo.getDocument<Mandate>(o.scope, "mandate", b.mandateId + ":" + b.mandateVersion);
      if (!mandate) throw new DomainError("mandate_missing");
      const budget = await repo.budget(o.scope.companyId),
        tools = await options.runtime.localTools(o.id, o.scope);
      const config = await readConfiguration(directory);
      const profile = await repo.getDocument<{ modelOverride?: string | null }>(
        context(res),
        "employee-profile",
        o.leadEmployeeId,
      );
      const ratingStats = ratingRoutingStats(
        await new ModelRatings(repo).summaries(o.scope.companyId, { orderKind: o.kind }),
      );
      const selection = selectModel(
        options.runtime.models,
        {
          messages: [{ role: "user", content: o.goal }],
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.id.replaceAll(".", "__"),
              description: t.description,
              parameters: z.toJSONSchema(t.schema),
            },
          })),
          max_tokens: 4096,
        },
        budget.availableUsdMicros,
        b.modelId ?? profile?.data.modelOverride ?? config.openrouter?.modelOverride,
        ratingStats,
      );
      if (!selection.selected) throw new DomainError("no_routable_model");
      await repo.putDocument(
        o.scope,
        "model-selection",
        randomUUID(),
        {
          orderId: o.id,
          modelId: selection.selected.model.id,
          estimatedUsdMicros: selection.selected.cost,
          score: selection.selected.score,
          samples: selection.selected.samples,
          reason: "Capability/context/budget gates; 50% quality, 30% cost, 20% latency. Missing quality neutral.",
          at: new Date().toISOString(),
        },
        { immutable: true },
      );
      return options.runtime.start(o.scope, o.id, mandate.data, selection.selected.model.id);
    }),
  );
  for (const [url, kind] of [
    ["messages", "message"],
    ["artifacts", "artifact"],
    ["reviews", "review"],
  ] as const) {
    app.get(`/api/v1/orders/:id/${url}`, async (req, res) => {
      const o = await order(req, res);
      const docs = await repo.listDocuments<Record<string, unknown>>(o.scope, kind);
      list(
        res,
        docs.filter((d) => d.data.orderId === o.id).map((d) => ({ ...d.data, revision: d.revision })),
        req,
      );
    });
  }
  app.post(
    "/api/v1/orders/:id/messages",
    mutate(async (req, res) => {
      const o = await order(req, res);
      const content = z.string().trim().min(1).max(20000).parse(req.body.content);
      return Runtime.appendMessage(repo, o.scope, o.id, content);
    }),
  );
  app.get("/api/v1/orders/:id/events", async (req, res) => {
    const o = await order(req, res);
    list(
      res,
      (await repo.events(o.scope, 0, 1000)).filter((e) => e.aggregateId === o.id),
      req,
    );
  });
  app.get("/api/v1/company/messages", async (req, res) =>
    list(
      res,
      (await repo.listDocuments(context(res), "ceo-message")).map((d) => d.data),
      req,
    ),
  );
  app.post(
    "/api/v1/company/messages",
    mutate(async (req, res) => {
      const id = randomUUID();
      return (
        await repo.putDocument(
          context(res),
          "ceo-message",
          id,
          {
            id,
            role: "user",
            content: z.string().trim().min(1).max(20000).parse(req.body.content),
            createdAt: new Date().toISOString(),
          },
          { immutable: true },
        )
      ).data;
    }),
  );
  app.get("/api/v1/configuration", async (_req, res) => res.json(await readConfiguration(directory)));
  app.put(
    "/api/v1/configuration",
    mutate(async (req, res) => {
      const config = configSchema.parse(req.body);
      if (
        [...config.connections, ...config.gitConnections, ...config.serviceTargets, ...config.mailConnections].some(
          (c) => c.scope.companyId !== context(res).companyId,
        )
      )
        throw new DomainError("scope_denied");
      if (config.remoteWorkerId) {
        const worker = await repo.getDocument<{ revoked: boolean; capabilities: string[] }>(
          await defaultScope(repo),
          "worker",
          config.remoteWorkerId,
        );
        if (!worker || worker.data.revoked || !worker.data.capabilities.includes("workspace.execute"))
          throw new DomainError("remote_worker_unavailable");
        if (!(await options.workers?.())) throw new DomainError("remote_worker_tls_required");
      }
      if (runtimeUpdating || activeWrites !== 1 || activeHandlers !== 1 || options.runtime?.active.size)
        throw new DomainError("runtime_busy");
      runtimeUpdating = true;
      const previousRuntime = options.runtime;
      if (previousRuntime) previousRuntime.acceptingRuns = false;
      try {
        const cached = await repo.listDocuments<Model>(context(res), "model");
        const runtime = await configuredRuntime(
          repo,
          directory,
          config,
          cached.map((d) => d.data),
          options.workers,
        );
        await saveConfiguration(directory, config);
        options.runtime = runtime;
        return { saved: true, liveExecutionEnabled: config.liveExecutionEnabled, runtimeReady: !!runtime };
      } finally {
        if (options.runtime === previousRuntime && previousRuntime) previousRuntime.acceptingRuns = true;
        runtimeUpdating = false;
      }
    }),
  );
  const backupInput = z
    .object({
      ageExecutable: z.string().min(1),
      recipient: z.string().startsWith("age1"),
      outputDirectory: z.string().min(1),
    })
    .strict();
  const performOnlineBackup = async (b: Parameters<OnlineBackup>[0]) => {
    const allowedWrites = writeOwner.getStore() ? 1 : 0;
    if (
      maintenance ||
      activeWrites !== allowedWrites ||
      activeHandlers !== allowedWrites ||
      runtimeUpdating ||
      options.runtime?.active.size
    )
      throw new DomainError("backup_busy");
    maintenance = true;
    const scope = await defaultScope(repo);
    let prior: Awaited<ReturnType<typeof repo.getDocument<Record<string, unknown>>>> | null = null,
      paused = false;
    let releaseBackground: (() => void) | undefined;
    try {
      releaseBackground = await app.locals.pauseBackground?.();
      prior = await repo.getDocument<Record<string, unknown>>(scope, "recovery-state", scope.companyId);
      await repo.putDocument(
        scope,
        "recovery-state",
        scope.companyId,
        { ...prior?.data, dispatchPaused: true, schedulesPaused: true, reason: "backup_snapshot" },
        { expectedRevision: prior?.revision ?? 0 },
      );
      paused = true;
      const actions = await repo.listCompanyDocuments<{ status: string }>(scope.companyId, "action");
      if (
        activeWrites !== allowedWrites ||
        activeHandlers !== allowedWrites ||
        options.runtime?.active.size ||
        actions.some((a) => ["running", "dispatched"].includes(a.data.status))
      )
        throw new DomainError("backup_busy");
      await mkdir(path.join(directory, "blobs"), { recursive: true, mode: 0o700 });
      const config = await readConfiguration(directory);
      const result = await new Promise<BackupResult>((resolve, reject) => {
        const worker = new Worker(
          new URL(import.meta.url.endsWith(".ts") ? "./backup-worker.ts" : "./backup-worker.js", import.meta.url),
          {
            workerData: {
              databasePath: path.join(directory, "company.sqlite"),
              blobDirectory: path.join(directory, "blobs"),
              outputDirectory: path.resolve(b.outputDirectory),
              ageExecutable: path.resolve(b.ageExecutable),
              recipient: b.recipient,
              appVersion: options.releaseIdentity?.version ?? APP_VERSION,
              configuration: config,
            },
          },
        );
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new DomainError("backup_timeout"));
        }, 600_000);
        timer.unref();
        worker.once("exit", () => {
          clearTimeout(timer);
          reject(new DomainError("backup_worker_exited"));
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once("message", (m: { result?: BackupResult; error?: string }) => {
          clearTimeout(timer);
          void worker.terminate();
          if (m.error) reject(new DomainError(m.error));
          else resolve(m.result!);
        });
      });
      const id = randomUUID();
      const record = (
        await repo.putDocument(
          scope,
          "backup",
          id,
          {
            id,
            archivePath: result.archivePath,
            sha256: result.sha256,
            createdAt: result.manifest.createdAt,
            state: "verified_archive",
            restoreTested: false,
          },
          { immutable: true },
        )
      ).data;
      return { result, record };
    } finally {
      try {
        if (paused) {
          const current = await repo.getDocument(scope, "recovery-state", scope.companyId);
          if (current)
            await repo.putDocument(
              scope,
              "recovery-state",
              scope.companyId,
              prior?.data ?? { dispatchPaused: false, schedulesPaused: false },
              { expectedRevision: current.revision },
            );
        }
      } finally {
        maintenance = shuttingDown;
        releaseBackground?.();
      }
    }
  };
  const maintenanceService = new MaintenanceService({
    repo,
    directory,
    onlineBackup: async (input) => (await performOnlineBackup(input)).result,
    currentVersion: options.releaseIdentity?.version,
    updateExecutor: options.updateExecutor,
    updateConfigurationFingerprint: options.updateConfigurationFingerprint,
  });
  registerMailInboxRoutes(app, {
    service: configuredMailInboxService(repo, directory),
    mutate,
    context: async (res) => ({ companyId: context(res).companyId, ceoId: (await repo.getIdentity())!.id }),
  });
  registerIntegrationCostRoutes(app, {
    service: new IntegrationCostService(repo),
    mutate,
    context: async (res) => ({ companyId: context(res).companyId, ceoId: (await repo.getIdentity())!.id }),
  });
  registerModelCostRoutes(app, {
    service:
      options.modelCostService ??
      new ModelCostService({
        repo,
        directory,
        isRunActive: (orderId) => runtimeUpdating || Boolean(options.runtime?.active.has(orderId)),
      }),
    mutate,
    context: async (res) => ({ companyId: context(res).companyId, ceoId: (await repo.getIdentity())!.id }),
  });
  app.locals.maintenanceService = maintenanceService;
  registerReleaseFeedRoutes(app, {
    repo,
    directory,
    currentVersion: options.releaseIdentity?.version,
    maintenance: maintenanceService,
    mutate,
    context: async (res) => ({ scope: context(res), ceoId: (await repo.getIdentity())!.id }),
  });
  registerMaintenanceRoutes(app, {
    service: maintenanceService,
    mutate,
    context: async (res) => ({ scope: context(res), ceoId: (await repo.getIdentity())!.id }),
  });
  app.post(
    "/api/v1/backups",
    mutate(async (req) => (await performOnlineBackup(backupInput.parse(req.body))).record),
  );
  app.get("/api/v1/recovery", async (_req, res) =>
    res.json(
      (await repo.getDocument(context(res), "recovery-state", context(res).companyId))?.data ?? {
        dispatchPaused: false,
        schedulesPaused: false,
      },
    ),
  );
  app.post(
    "/api/v1/recovery/resume",
    mutate(async (req, res) => {
      z.object({ reviewedExternalEffects: z.literal(true) }).parse(req.body);
      const scope = context(res);
      for (const o of await repo.listAllOrders(scope.companyId)) {
        const actions = await repo.listDocuments<{ status: string }>(o.scope, "action");
        if (actions.some((a) => ["effect_unknown", "running", "dispatched"].includes(a.data.status)))
          throw new DomainError("effects_unreconciled");
      }
      const budget = await repo.budget(scope.companyId);
      if (BigInt(budget.unreconciledUsdMicros) > 0n) throw new DomainError("usage_unreconciled");
      const current = await repo.getDocument<Record<string, unknown>>(scope, "recovery-state", scope.companyId);
      if (!current) throw new DomainError("recovery_not_pending");
      return repo.putDocument(
        scope,
        "recovery-state",
        scope.companyId,
        {
          ...current.data,
          dispatchPaused: false,
          schedulesPaused: false,
          reviewedExternalEffects: true,
          resumedAt: new Date().toISOString(),
        },
        { expectedRevision: current.revision },
      );
    }),
  );
  app.post(
    "/api/v1/models/refresh",
    mutate(async (_req, res) => {
      if (runtimeUpdating) throw new DomainError("runtime_busy");
      const { models, observedAt } = await refreshCatalog(repo, context(res));
      if (options.runtime) options.runtime.models = models;
      return { count: models.length, observedAt };
    }),
  );
  app.get("/api/v1/budget", async (_req, res) => res.json(await repo.budget(context(res).companyId)));
  app.post(
    "/api/v1/budget",
    mutate(async (req, res) =>
      repo.setBudget(
        context(res).companyId,
        z
          .object({
            limitUsdMicros: microsSchema,
            startsAt: z.iso.datetime(),
            endsAt: z.iso.datetime(),
            renewal: z.enum(["none", "fixed_duration"]).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/mandates",
    mutate(async (req, res) => {
      const m = mandateSchema.parse(req.body);
      if (m.scope.companyId !== context(res).companyId) throw new DomainError("scope_denied");
      return repo.createMandate(m);
    }),
  );
  app.get("/api/v1/approvals", async (req, res) => {
    const results = await repo.listCompanyDocuments<Record<string, unknown>>(
      context(res).companyId,
      "approval-request",
    );
    list(
      res,
      results.map((d) => ({ ...d.data, revision: d.revision })),
      req,
    );
  });
  app.post(
    "/api/v1/approvals/:id/decision",
    mutate(async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        decision = z.enum(["approved", "denied"]).parse(req.body.decision);
      const pending = (await repo.listCompanyDocuments(context(res).companyId, "approval-request")).find(
        (d) => d.id === id,
      );
      if (!pending) throw new DomainError("approval_not_found", "approval_not_found", 404);
      return repo.decideApproval(pending.scope, id, revision(req), decision);
    }),
  );
  for (const group of [
    "workers",
    "integrations",
    "schedules",
    "knowledge",
    "backups",
    "mandates",
    "models",
    "projects",
  ])
    app.get("/api/v1/" + group, async (req, res) => {
      const kind =
        group === "mandates"
          ? "mandate"
          : group === "models"
            ? "model"
            : group === "knowledge"
              ? "knowledge"
              : group.slice(0, -1);
      const items = (await repo.listCompanyDocuments<Record<string, unknown>>(context(res).companyId, kind)).map(
        (d) => ({ id: d.id, ...d.data, revision: d.revision }),
      );
      list(
        res,
        items.map((item) => {
          const safe = { ...item } as Record<string, unknown>;
          delete safe.credentialHash;
          return safe;
        }),
        req,
      );
    });
  app.get("/api/v1/events", async (req, res) => {
    let after = Number(req.header("Last-Event-ID") ?? req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new DomainError("cursor_invalid");
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    let closed = false,
      busy = false;
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const events = await repo.eventsForCompany(context(res).companyId, after, 100);
        for (const e of events) {
          if (e.sequence <= after) continue;
          res.write(
            `id: ${e.sequence}\nevent: update\ndata: ${JSON.stringify({ type: e.type, aggregateId: e.aggregateId })}\n\n`,
          );
          after = e.sequence;
        }
        res.write(": heartbeat\n\n");
      } catch {
        res.write("event: stale\ndata: {}\n\n");
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
    await tick();
  });
  registerWorkflowRoutes(app, { repo, directory, context, order, mutate, workers: options.workers });
  registerFinanceRoutes(app, { service: new FinanceService({ repo, directory }), context, mutate });
  registerFinanceCorrectionRoutes(app, { repo, directory, context, mutate });
  registerEntityRoutes(app, { repo, context, mutate });
  registerWebsiteCareRoutes(app, {
    service: options.websiteCareService ?? new WebsiteCareService({ repo, directory }),
    order,
    ceo: async () => (await repo.getIdentity())!.id,
    mutate,
  });
  registerRatingRoutes(app, { repo, context, mutate });
  registerAdminRoutes(app, { repo, directory, context, mutate });
  registerIncidentRoutes(app, {
    service: options.incidentService ?? new IncidentService({ repo, directory }),
    context: async (res) => ({ scope: context(res), ceoId: (await repo.getIdentity())!.id }),
    order,
    mutate,
  });
  registerHostingRoutes(app, {
    service: options.hostingService ?? new HostingService({ repo, directory }),
    context: async (res) => ({ scope: context(res), ceoId: (await repo.getIdentity())!.id }),
    order,
    mutate,
  });
  app.get("/api/v1/workers/status", async (_req, res) => {
    const workers = await options.workers?.();
    res.json({
      tlsConfigured: !!workers,
      connectUrl: workers
        ? (options.workerConnectUrl ?? publicOrigin.replace(/^https:/, "wss:") + "/api/v1/workers/connect")
        : null,
      capabilities: ["workspace.read", "workspace.apply_patch", "workspace.test_fixture", "workspace.execute"],
    });
  });
  app.post(
    "/api/v1/workers/:id/rotate",
    mutate(
      async (req) => {
        const workers = await options.workers?.();
        if (!workers) throw new DomainError("worker_tls_required");
        return workers.rotate(z.uuid().parse(req.params.id));
      },
      { oneTime: true },
    ),
  );
  app.post(
    "/api/v1/workers/:id/revoke",
    mutate(async (req) => {
      const workers = await options.workers?.();
      if (!workers) throw new DomainError("worker_tls_required");
      await workers.revoke(z.uuid().parse(req.params.id));
      return { revoked: true };
    }),
  );
  app.post(
    "/api/v1/workers/enroll",
    mutate(
      async (req, _res) => {
        const workers = await options.workers?.();
        if (!workers) throw new DomainError("worker_tls_required");
        const b = z
          .object({
            name: z.string().min(1),
            capabilities: z.array(z.string()).min(1),
            maxConcurrent: z.number().int().min(1).max(16).default(1),
          })
          .parse(req.body);
        return workers.enroll(b.name, b.capabilities, b.maxConcurrent);
      },
      { oneTime: true },
    ),
  );
  if (options.webDirectory) {
    app.use(express.static(options.webDirectory));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(options.webDirectory!, "index.html")));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const code =
      error instanceof DomainError ? error.code : error instanceof z.ZodError ? "validation_failed" : "internal_error";
    res
      .status(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .json({ code, messageKey: "errors." + code, requestId: res.locals.requestId, retryable: false });
  });
  return app;
}
