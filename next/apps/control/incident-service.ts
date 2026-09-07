import { oauthBrokerOptions, recoveryGeneration } from "./oauth-broker.ts";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { scopeSchema, type Scope, type ToolAction, type Mandate } from "../../packages/contracts/src/index.ts";
import { DomainError, sameScope, sha256 } from "../../packages/domain/src/index.ts";
import { IncidentWorkflow, type Incident } from "../../packages/domain/workflows/incident.ts";
import { ManagedActions, type ActionRequest } from "../../packages/domain/workflows/actions.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { ServiceBroker, type BrokerRunner } from "../../packages/integrations/src/service-broker.ts";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";
import { ProtonPassResolver, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { readConfiguration, type Configuration } from "./configuration.ts";
export const healthProfileSchema = z
  .object({
    targetId: z.uuid(),
    scope: scopeSchema,
    url: z.url().refine((value) => {
      const u = new URL(value);
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.hash && !u.search;
    }),
    expectedStatus: z.number().int().min(200).max(299).default(200),
    contains: z.array(z.string().min(1).max(200)).min(1).max(20),
    trustedCaPem: z.string().min(40).max(20000).optional(),
    timeoutMs: z.number().int().min(100).max(30000).default(5000),
    observationSeconds: z.number().int().min(2).max(86400),
    checkIntervalSeconds: z.number().int().min(1).max(300),
    maxCheckGapSeconds: z.number().int().min(1).max(600),
  })
  .strict()
  .refine(
    (p) => p.checkIntervalSeconds <= p.maxCheckGapSeconds && p.maxCheckGapSeconds < p.observationSeconds,
    "Check gap must be shorter than observation",
  );
export type HealthProfile = z.infer<typeof healthProfileSchema> & {
  fingerprint: string;
  configuredBy: string;
  configuredAt: string;
};
export const incidentActionSchema = z
  .object({ actionId: z.uuid(), mandateId: z.uuid(), mandateVersion: z.number().int().positive().default(1) })
  .strict();
export const repairParameters = z
  .object({ targetId: z.uuid(), targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const checkParameters = z
  .object({ targetId: z.uuid(), healthProfileSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const messageParameters = z
  .object({
    targetId: z.uuid(),
    targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
    to: z.email(),
    subject: z.string().min(1).max(200),
    content: z.string().min(1).max(100000),
    incidentState: z.enum(["investigating", "repairing", "observing", "resolved", "blocked"]),
  })
  .strict();
type Envelope = z.infer<typeof incidentActionSchema>;
type ObservationJob = {
  scope: Scope;
  orderId: string;
  profile: HealthProfile;
  mandateId: string;
  mandateVersion: number;
  state: "active" | "resolved" | "blocked" | "recurrence";
  nextCheckAt: string;
  lastCheckAt: string;
  endsAt: string;
  reason?: string;
};
export type IncidentServiceOptions = {
  repo: Repository;
  directory: string;
  configuration?: () => Promise<Configuration>;
  runner?: BrokerRunner;
  secrets?: SecretResolver;
  now?: () => Date;
};
class RuntimeActions extends ManagedActions {
  readonly runtimeAction: ToolAction;
  constructor(repo: Repository, directory: string, action: ToolAction) {
    super(repo, directory);
    this.runtimeAction = action;
  }
  override async perform(request: ActionRequest, execute: (action: ToolAction) => Promise<unknown>) {
    const stored = await this.repo.getDocument<ToolAction & { targetId: string }>(
      request.scope,
      "action",
      this.runtimeAction.id,
    );
    if (
      !stored ||
      stored.data.status !== "running" ||
      stored.data.toolId !== request.toolId ||
      stored.data.orderId !== request.orderId ||
      stored.data.targetId !== request.targetId ||
      stored.data.argumentsSha256 !== sha256(this.runtimeAction.args) ||
      stored.data.mandateId !== request.mandateId ||
      stored.data.mandateVersion !== request.mandateVersion
    )
      throw new IntegrationError(
        "authorization",
        "Runtimeauftrag stimmt nicht mit der gespeicherten Störungsaktion überein.",
      );
    await this.repo.assertAuthorized(request.scope, {
      action: stored.data,
      targetId: request.targetId,
      effect: request.effect,
      requireApproval: request.requireApproval,
    });
    return { state: "succeeded" as const, id: stored.id, data: await execute(stored.data) };
  }
}
export class IncidentService {
  readonly repo: Repository;
  readonly directory: string;
  readonly now: () => Date;
  readonly configuration: () => Promise<Configuration>;
  readonly runner?: BrokerRunner;
  readonly secrets: SecretResolver;
  private ticking = false;
  constructor(options: IncidentServiceOptions) {
    this.repo = options.repo;
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner;
    this.configuration = options.configuration ?? (() => readConfiguration(options.directory));
    this.secrets = options.secrets ?? {
      resolve: async (ref, reason) => {
        const c = await this.configuration();
        if (!c.proton) throw new DomainError("secret_provider_not_configured");
        return new ProtonPassResolver({
          executable: c.proton.executable,
          environment: {
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            SYSTEMROOT: process.env.SYSTEMROOT,
            PATH: path.dirname(c.proton.executable),
            ...(c.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: c.proton.sessionDirectory } : {}),
          },
        }).resolve(ref, reason);
      },
    };
  }
  private runtimeInput(runtime: ToolAction | undefined, parsed: Envelope & Record<string, unknown>) {
    if (!runtime) return;
    const { actionId, mandateId, mandateVersion, ...parameters } = parsed;
    if (
      runtime.id !== actionId ||
      runtime.mandateId !== mandateId ||
      runtime.mandateVersion !== mandateVersion ||
      sha256(runtime.args) !== sha256(parameters)
    )
      throw new IntegrationError(
        "authorization",
        "Runtimeparameter wurden außerhalb des gespeicherten Auftrags verändert.",
      );
  }
  private workflow() {
    return new IncidentWorkflow(this.repo, this.now);
  }
  private actions(runtime?: ToolAction) {
    return runtime
      ? new RuntimeActions(this.repo, path.join(this.directory, "receipts"), runtime)
      : new ManagedActions(this.repo, path.join(this.directory, "receipts"));
  }
  async profiles(scope: Scope, companyWide = false) {
    return (
      companyWide
        ? await this.repo.listCompanyDocuments<HealthProfile>(scope.companyId, "incident-health-profile")
        : await this.repo.listDocuments<HealthProfile>(scope, "incident-health-profile")
    ).map((r) => ({
      ...r.data,
      revision: r.revision,
    }));
  }
  async configureHealth(scope: Scope, ceoId: string, input: unknown, expectedRevision = 0) {
    if ((await this.repo.snapshot(scope.companyId)).ceo.id !== ceoId) throw new DomainError("ceo_required");
    const parsed = healthProfileSchema.parse(input),
      config = await this.configuration();
    if (
      parsed.scope.companyId !== scope.companyId ||
      !config.serviceTargets.some((t) => t.id === parsed.targetId && sameScope(t.scope, parsed.scope))
    )
      throw new DomainError("incident_target_denied");
    const profile = {
      ...parsed,
      fingerprint: sha256(parsed),
      configuredBy: ceoId,
      configuredAt: this.now().toISOString(),
    };
    return this.repo.putDocument(parsed.scope, "incident-health-profile", parsed.targetId, profile, {
      expectedRevision,
    });
  }
  async status(scope: Scope, id: string) {
    await this.repo.getOrder(scope, id);
    const incident = await this.required(scope, id);
    const config = await this.configuration();
    const healthProfile = await this.repo.getDocument<HealthProfile>(
      scope,
      "incident-health-profile",
      incident.data.targetId,
    );
    return {
      incident: incident.data,
      observation: (await this.repo.getDocument(scope, "incident-observation", id))?.data,
      healthProfile: healthProfile ? { ...healthProfile.data, revision: healthProfile.revision } : undefined,
      serviceTargets: config.serviceTargets
        .filter((target) => sameScope(target.scope, scope))
        .map((target) => ({
          id: target.id,
          kind: target.kind,
          resourceName: target.resourceName,
          configSha256: sha256(target),
        })),
      mailTargets: config.mailConnections
        .filter((target) => sameScope(target.scope, scope) && target.enabledTools.includes("mail.send"))
        .map((target) => ({ id: target.id, from: target.from, host: target.host, configSha256: sha256(target) })),
      pendingActions: (await this.repo.listDocuments<ToolAction & { targetId: string }>(scope, "action"))
        .filter(
          (record) =>
            record.data.orderId === id &&
            ["incident.repair", "incident.check", "incident.customer_message"].includes(record.data.toolId),
        )
        .map((record) => ({
          id: record.id,
          toolId: record.data.toolId,
          status: record.data.status,
          mandateId: record.data.mandateId,
          mandateVersion: record.data.mandateVersion,
          args: record.data.args,
          targetId: record.data.targetId,
          revision: record.revision,
        })),
    };
  }
  private async required(scope: Scope, id: string) {
    const record = await this.repo.getDocument<Incident>(scope, "incident", id);
    if (!record) throw new DomainError("incident_not_found");
    return record;
  }
  private async enabled() {
    const config = await this.configuration();
    if (!config.liveExecutionEnabled) throw new DomainError("integration_not_configured");
    return config;
  }
  private async authorize(
    scope: Scope,
    actionId: string,
    targetId: string,
    effect: "read" | "external_change" | "external_send",
    approval: boolean,
    durationSeconds = 1,
  ) {
    const stored = await this.repo.getDocument<ToolAction>(scope, "action", actionId);
    if (!stored || stored.data.status !== "running")
      throw new IntegrationError("authorization", "Aktiver Störungsauftrag fehlt.");
    try {
      await this.repo.assertAuthorized(scope, {
        action: stored.data,
        targetId,
        effect,
        requireApproval: approval,
        durationSeconds,
      });
    } catch {
      throw new IntegrationError("authorization", "Störungsmandat ist abgelaufen, gesperrt oder zu eng.");
    }
    return stored.data;
  }
  async repair(scope: Scope, id: string, input: unknown, runtime?: ToolAction) {
    const parsed = incidentActionSchema.extend(repairParameters.shape).parse(input),
      incident = await this.required(scope, id),
      config = await this.enabled(),
      target = config.serviceTargets.find((t) => t.id === parsed.targetId && sameScope(t.scope, scope));
    this.runtimeInput(runtime, parsed);
    if (!target || target.id !== incident.data.targetId || sha256(target) !== parsed.targetConfigSha256)
      throw new DomainError("incident_target_changed");
    return this.workflow().repair(
      scope,
      id,
      this.actions(runtime),
      {
        id: parsed.actionId,
        toolId: "incident.repair",
        effect: "external_change",
        mandateId: parsed.mandateId,
        mandateVersion: parsed.mandateVersion,
        requireApproval: true,
        args: {
          targetId: target.id,
          targetConfigSha256: sha256(target),
          operation: "restart",
          resourceName: target.resourceName,
        },
      },
      async () => {
        const latest = (await this.enabled()).serviceTargets.find((t) => t.id === target.id);
        if (!latest || sha256(latest) !== sha256(target))
          throw new IntegrationError("authorization", "Dienstziel wurde nach Freigabe geändert.");
        const action = await this.authorize(scope, parsed.actionId, target.id, "external_change", true);
        const observation = await this.repo.getDocument<ObservationJob>(scope, "incident-observation", id);
        if (observation?.data.state === "active")
          await this.repo.putDocument(
            scope,
            "incident-observation",
            id,
            { ...observation.data, state: "blocked", reason: "repair_started" },
            { expectedRevision: observation.revision },
          );
        const result = await new ServiceBroker(
          target,
          {
            perform: async (request, execute) => {
              if (request.targetId !== target.id || !sameScope(request.scope, scope))
                throw new IntegrationError("authorization", "Brokerziel passt nicht.");
              return { id: action.id, state: "succeeded", data: await execute(action) };
            },
          },
          this.runner,
        ).execute(
          { id: action.id, orderId: id, mandateId: parsed.mandateId, mandateVersion: parsed.mandateVersion },
          "restart",
        );
        return result.data;
      },
    );
  }
  private async profile(scope: Scope, id: string, expected: string) {
    const p = await this.repo.getDocument<HealthProfile>(scope, "incident-health-profile", id);
    if (!p || p.data.fingerprint !== expected) throw new DomainError("health_profile_changed");
    return p.data;
  }
  private async probe(profile: HealthProfile): Promise<{ ok: boolean; evidence: string }> {
    return new Promise((resolve) => {
      const url = new URL(profile.url);
      let done = false;
      const finish = (ok: boolean, evidence: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok, evidence });
      };
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          ...(url.protocol === "https:" ? { rejectUnauthorized: true, ca: profile.trustedCaPem } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let count = 0;
          res.on("data", (chunk: Buffer) => {
            count += chunk.length;
            if (count > 1024 * 1024) {
              res.destroy();
              finish(false, "health_response_limit");
            } else chunks.push(chunk);
          });
          res.on("error", () => finish(false, "health_response_interrupted"));
          res.on("end", () => {
            const body = Buffer.concat(chunks),
              ok =
                res.statusCode === profile.expectedStatus &&
                profile.contains.every((text) => body.toString("utf8").includes(text));
            finish(
              ok,
              JSON.stringify({
                url: profile.url,
                status: res.statusCode,
                bodySha256: createHash("sha256").update(body).digest("hex"),
                bytes: body.length,
                checks: ["expected_status", "configured_content"],
                tlsVerified: url.protocol === "https:",
                observedAt: this.now().toISOString(),
              }),
            );
          });
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(false, "health_timeout");
      }, profile.timeoutMs);
      req.on("error", () => finish(false, "health_connection_failed"));
      req.end();
    });
  }
  private async checkedProbe(scope: Scope, profile: HealthProfile, actionId: string, previousCheckAt?: string) {
    const result = await this.probe(profile);
    await this.profile(scope, profile.targetId, profile.fingerprint);
    await this.authorize(scope, actionId, profile.targetId, "read", false, profile.observationSeconds);
    if (previousCheckAt && this.now().getTime() - Date.parse(previousCheckAt) > profile.maxCheckGapSeconds * 1000)
      return { ok: false, evidence: "observation_gap_during_probe" };
    return result;
  }
  private async observationMandate(scope: Scope, request: Envelope, profile: HealthProfile) {
    const mandate = await this.repo.getDocument<Mandate>(
      scope,
      "mandate",
      `${request.mandateId}:${request.mandateVersion}`,
    );
    if (
      !mandate ||
      Date.parse(mandate.data.expiresAt) < this.now().getTime() + profile.observationSeconds * 1000 ||
      mandate.data.maxDurationSeconds < profile.observationSeconds
    )
      throw new IntegrationError("authorization", "Mandat muss das vollständige Beobachtungsfenster abdecken.");
  }
  async check(scope: Scope, id: string, input: unknown, runtime?: ToolAction) {
    const parsed = incidentActionSchema.extend(checkParameters.shape).parse(input),
      incident = await this.required(scope, id);
    this.runtimeInput(runtime, parsed);
    if (incident.data.targetId !== parsed.targetId) throw new DomainError("incident_target_denied");
    const profile = await this.profile(scope, parsed.targetId, parsed.healthProfileSha256);
    return this.actions(runtime).perform(
      {
        id: parsed.actionId,
        scope,
        orderId: id,
        toolId: "incident.check",
        effect: "read",
        targetId: parsed.targetId,
        mandateId: parsed.mandateId,
        mandateVersion: parsed.mandateVersion,
        args: {
          targetId: parsed.targetId,
          healthProfileSha256: profile.fingerprint,
          observationSeconds: profile.observationSeconds,
        },
      },
      async () => {
        await this.enabled();
        await this.profile(scope, parsed.targetId, profile.fingerprint);
        await this.observationMandate(scope, parsed, profile);
        await this.authorize(scope, parsed.actionId, parsed.targetId, "read", false, profile.observationSeconds);
        const job = await this.repo.getDocument<ObservationJob>(scope, "incident-observation", id);
        if (job?.data.state === "active")
          throw new IntegrationError("authorization", "Ein Beobachtungsfenster ist bereits aktiv.");
        const old = await this.required(scope, id);
        if (old.data.state === "observing")
          await this.repo.putDocument(
            scope,
            "incident",
            id,
            { ...old.data, state: "investigating", observationEndsAt: undefined },
            { expectedRevision: old.revision },
          );
        const result = await this.workflow().check(scope, id, profile.observationSeconds, () =>
            this.checkedProbe(scope, profile, parsed.actionId),
          ),
          now = this.now();
        if (result.data.state === "observing")
          await this.repo.putDocument(
            scope,
            "incident-observation",
            id,
            {
              scope,
              orderId: id,
              profile,
              mandateId: parsed.mandateId,
              mandateVersion: parsed.mandateVersion,
              state: "active",
              lastCheckAt: now.toISOString(),
              nextCheckAt: new Date(now.getTime() + profile.checkIntervalSeconds * 1000).toISOString(),
              endsAt: result.data.observationEndsAt!,
            } satisfies ObservationJob,
            { expectedRevision: job?.revision ?? 0 },
          );
        return {
          incidentState: result.data.state,
          observationEndsAt: result.data.observationEndsAt,
          requiresObservation: result.data.state === "observing",
        };
      },
    );
  }
  async tick(companyScope: Scope) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of await this.repo.listCompanyDocuments<ObservationJob>(
        companyScope.companyId,
        "incident-observation",
      )) {
        const scope = job.data.scope;
        if (job.data.state !== "active" || Date.parse(job.data.nextCheckAt) > this.now().getTime()) continue;
        let result: Awaited<ReturnType<IncidentWorkflow["check"]>> | undefined;
        try {
          await this.enabled();
          await this.repo.assertDispatchAllowed(scope.companyId);
          await this.profile(scope, job.data.profile.targetId, job.data.profile.fingerprint);
          if (this.now().getTime() - Date.parse(job.data.lastCheckAt) > job.data.profile.maxCheckGapSeconds * 1000)
            throw new DomainError("observation_gap");
          const actionId = randomUUID(),
            args = {
              targetId: job.data.profile.targetId,
              healthProfileSha256: job.data.profile.fingerprint,
              observationEndsAt: job.data.endsAt,
              observationSeconds: job.data.profile.observationSeconds,
            };
          const outcome = await this.actions().perform(
            {
              id: actionId,
              scope,
              orderId: job.data.orderId,
              toolId: "incident.check",
              effect: "read",
              targetId: job.data.profile.targetId,
              mandateId: job.data.mandateId,
              mandateVersion: job.data.mandateVersion,
              args,
            },
            async () => {
              await this.authorize(
                scope,
                actionId,
                job.data.profile.targetId,
                "read",
                false,
                job.data.profile.observationSeconds,
              );
              result = await this.workflow().check(scope, job.data.orderId, job.data.profile.observationSeconds, () =>
                this.checkedProbe(scope, job.data.profile, actionId, job.data.lastCheckAt),
              );
              return { incidentState: result.data.state };
            },
          );
          if (outcome.state !== "succeeded" || !result) throw new DomainError("observation_mandate_denied");
          const now = this.now();
          await this.repo.putDocument(
            scope,
            "incident-observation",
            job.id,
            {
              ...job.data,
              state:
                result.data.state === "resolved"
                  ? "resolved"
                  : result.data.state === "observing"
                    ? "active"
                    : "recurrence",
              lastCheckAt: now.toISOString(),
              nextCheckAt: new Date(now.getTime() + job.data.profile.checkIntervalSeconds * 1000).toISOString(),
            },
            { expectedRevision: job.revision },
          );
        } catch (error) {
          await this.repo.putDocument(
            scope,
            "incident-observation",
            job.id,
            {
              ...job.data,
              state: "blocked",
              reason: error instanceof DomainError ? error.code : "observation_unavailable",
            },
            { expectedRevision: job.revision },
          );
          const current = await this.required(scope, job.data.orderId);
          if (current.data.state === "observing")
            await this.repo.putDocument(
              scope,
              "incident",
              job.data.orderId,
              { ...current.data, state: "investigating", observationEndsAt: undefined },
              { expectedRevision: current.revision },
            );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  async customerMessage(scope: Scope, id: string, input: unknown, runtime?: ToolAction) {
    const parsed = incidentActionSchema.extend(messageParameters.shape).parse(input),
      config = await this.enabled(),
      target = config.mailConnections.find(
        (t) => t.id === parsed.targetId && sameScope(t.scope, scope) && t.enabledTools.includes("mail.send"),
      );
    this.runtimeInput(runtime, parsed);
    if (!target || sha256(target) !== parsed.targetConfigSha256) throw new DomainError("mail_target_changed");
    return this.workflow().customerMessage(
      scope,
      id,
      this.actions(runtime),
      {
        id: parsed.actionId,
        toolId: "incident.customer_message",
        targetId: parsed.targetId,
        mandateId: parsed.mandateId,
        mandateVersion: parsed.mandateVersion,
        args: {
          targetId: target.id,
          targetConfigSha256: sha256(target),
          from: target.from,
          to: parsed.to,
          subject: parsed.subject,
          content: parsed.content,
          incidentState: parsed.incidentState,
        },
      },
      async () => {
        const current = await this.required(scope, id),
          latest = (await this.enabled()).mailConnections.find((t) => t.id === target.id);
        if (current.data.state !== parsed.incidentState || !latest || sha256(latest) !== sha256(target))
          throw new IntegrationError("authorization", "Nachrichtenstand oder Mailziel wurde nach Freigabe geändert.");
        await this.authorize(scope, parsed.actionId, target.id, "external_send", true);
        return new MailConnector(
          target,
          this.secrets,
          async () => {
            const beforeSend = await this.required(scope, id);
            const currentTarget = (await this.enabled()).mailConnections.find((t) => t.id === target.id);
            if (
              beforeSend.data.state !== parsed.incidentState ||
              !currentTarget ||
              sha256(currentTarget) !== sha256(target)
            )
              throw new IntegrationError("authorization", "Kundennachricht ist nicht mehr aktuell.");
            await this.authorize(scope, parsed.actionId, target.id, "external_send", true);
          },
          {
            ...oauthBrokerOptions(this.repo, this.directory, this.secrets),
            oauthGeneration: () => recoveryGeneration(this.repo, scope),
          },
        ).send({
          id: parsed.actionId,
          scope,
          targetId: target.id,
          toolId: "mail.send",
          args: { to: [parsed.to], subject: parsed.subject, text: parsed.content },
        });
      },
    );
  }
}
