import { createHash } from "node:crypto";
import { z } from "zod";
import { scopeSchema, type Scope, type ToolAction } from "../../packages/contracts/src/index.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import {
  integrationPriceSchema,
  type IntegrationPrice,
  type MeteredIntegrationRequest,
} from "../../packages/integrations/src/pricing.ts";
import { checkResponse, IntegrationError, type HttpResponse } from "../../packages/integrations/src/transport.ts";

export const integrationChargeSchema = z
  .object({
    actionId: z.uuid(),
    reservationId: z.uuid(),
    orderId: z.uuid(),
    targetId: z.uuid(),
    argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    configurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    price: integrationPriceSchema,
    status: z.enum(["dispatched", "settled", "unreconciled", "cancelled"]),
    createdAt: z.iso.datetime(),
    settledAt: z.iso.datetime().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    responseSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    actualUsdMicros: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .optional(),
    reconciliationEvidenceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type IntegrationCharge = z.infer<typeof integrationChargeSchema>;

export const integrationChargeResultSchema = integrationChargeSchema
  .extend({ scope: scopeSchema, revision: z.number().int().positive() })
  .strict();
export const integrationChargesResultSchema = z.object({ charges: z.array(integrationChargeResultSchema) }).strict();
export const integrationReconcileInputSchema = z
  .object({
    actualUsdMicros: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
    evidence: z
      .object({
        mediaType: z.enum(["application/pdf", "application/json", "text/plain", "text/csv"]),
        contentBase64: z
          .string()
          .min(4)
          .max(700000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .refine((value) => Buffer.from(value, "base64").toString("base64") === value),
        description: z.string().min(1).max(1000),
      })
      .strict(),
  })
  .strict();

/** One action is exactly one potentially billable HTTP attempt. No provider response is stored here. */
export class IntegrationCostService {
  readonly repo: Repository;
  readonly now: () => number;
  constructor(repo: Repository, now: () => number = Date.now) {
    this.repo = repo;
    this.now = now;
  }
  private price(value: unknown): IntegrationPrice {
    const result = integrationPriceSchema.safeParse(value);
    if (!result.success) throw new DomainError("integration_price_missing");
    if (this.now() < Date.parse(result.data.validFrom) || this.now() >= Date.parse(result.data.expiresAt))
      throw new DomainError("integration_price_expired");
    return result.data;
  }
  readonly request: MeteredIntegrationRequest = async ({ action, connection, execute }) => {
    if (
      action.toolId !== "research.search" ||
      connection.provider !== "brave" ||
      connection.id !== action.targetId ||
      sha256(connection.scope) !== sha256(action.scope)
    )
      throw new DomainError("integration_cost_binding_invalid");
    const price = this.price(connection.pricing),
      scope = action.scope;
    const stored = await this.repo.getDocument<ToolAction & { targetId?: string }>(scope, "action", action.id);
    if (
      !stored ||
      stored.data.toolId !== action.toolId ||
      sha256(stored.data.scope) !== sha256(scope) ||
      !["running", "dispatched"].includes(stored.data.status)
    )
      throw new DomainError("integration_cost_action_invalid");
    const suppliedHash = sha256(action.args),
      wrappedHash = sha256({ targetId: action.targetId, parameters: action.args });
    if (
      stored.data.argumentsSha256 !== sha256(stored.data.args) ||
      !(
        stored.data.argumentsSha256 === wrappedHash ||
        (stored.data.argumentsSha256 === suppliedHash && stored.data.targetId === action.targetId)
      )
    )
      throw new DomainError("integration_cost_arguments_changed");
    const previous = await this.repo.getDocument<IntegrationCharge>(scope, "integration-charge", action.id);
    if (previous)
      throw new IntegrationError(
        "conflict",
        "Dieser Suchversuch hat bereits einen Kostenbeleg; keine automatische Wiederholung.",
        "effect_unknown",
      );
    const priceId = `${connection.id}:${price.id}:${price.version}`;
    let registered = await this.repo.getDocument<IntegrationPrice>(scope, "integration-price", priceId);
    if (!registered) {
      try {
        registered = await this.repo.putDocument(scope, "integration-price", priceId, price, {
          immutable: true,
          expectedRevision: 0,
        });
      } catch (error) {
        registered = await this.repo.getDocument<IntegrationPrice>(scope, "integration-price", priceId);
        if (!registered) throw error;
      }
    }
    if (sha256(registered.data) !== sha256(price)) throw new DomainError("integration_price_version_conflict");
    const budget = await this.repo.budget(scope.companyId);
    const charge: IntegrationCharge = {
      actionId: action.id,
      reservationId: action.id,
      orderId: stored.data.orderId,
      targetId: connection.id,
      argumentsSha256: stored.data.argumentsSha256,
      configurationSha256: sha256(connection),
      price,
      status: "dispatched",
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.repo.assertAuthorized(scope, {
      action: stored.data,
      targetId: action.targetId,
      effect: "read",
      costUsdMicros: price.requestUsdMicros,
    });
    await this.repo.reserveAndTransact(
      scope,
      {
        id: action.id,
        periodId: budget.periodId,
        orderId: stored.data.orderId,
        actionId: action.id,
        mandateId: stored.data.mandateId,
        mandateVersion: stored.data.mandateVersion,
        amountUsdMicros: price.requestUsdMicros,
      },
      [{ kind: "integration-charge", id: action.id, data: charge, expectedRevision: 0 }],
      {
        type: "integration.cost.reserved",
        aggregateId: action.id,
        data: { targetId: connection.id, priceId, amountUsdMicros: price.requestUsdMicros },
      },
    );
    // Fresh authorization after persistence, immediately before network dispatch. A known predispatch failure can release funds.
    try {
      this.price(connection.pricing);
      await this.repo.assertDispatchAllowed(scope.companyId);
      await this.repo.assertAuthorized(scope, {
        action: stored.data,
        targetId: action.targetId,
        effect: "read",
        costUsdMicros: price.requestUsdMicros,
      });
    } catch (error) {
      await this.finish(scope, charge, "cancelled", "0");
      throw error;
    }
    let response: HttpResponse;
    try {
      response = await execute();
      if (response.status < 200 || response.status >= 300) {
        await this.finish(scope, { ...charge, httpStatus: response.status }, "unreconciled");
        try {
          checkResponse(response, false);
        } catch (error) {
          if (error instanceof IntegrationError)
            throw new IntegrationError(
              error.code,
              "Suchkosten sind nach Providerfehler ungeklärt.",
              "effect_unknown",
              response.status,
            );
        }
        throw new IntegrationError("provider", "Suchkosten sind ungeklärt.", "effect_unknown", response.status);
      }
    } catch (error) {
      const current = await this.repo.getDocument<IntegrationCharge>(scope, "integration-charge", action.id);
      if (current?.data.status === "dispatched") await this.finish(scope, charge, "unreconciled");
      if (error instanceof IntegrationError && error.effectStatus === "effect_unknown") throw error;
      throw new IntegrationError(
        "transport",
        "Suchaufruf ohne gesicherten Kostenabschluss; Reservierung bleibt gebunden.",
        "effect_unknown",
      );
    }
    try {
      await this.finish(
        scope,
        {
          ...charge,
          httpStatus: response.status,
          responseSha256: createHash("sha256").update(response.body).digest("hex"),
        },
        "settled",
        price.requestUsdMicros,
      );
    } catch {
      throw new IntegrationError(
        "provider",
        "Kostenabschluss konnte nicht dauerhaft bestätigt werden.",
        "effect_unknown",
      );
    }
    return response;
  };
  private async finish(
    scope: Scope,
    charge: IntegrationCharge,
    status: IntegrationCharge["status"],
    actualUsdMicros?: string,
  ) {
    await this.repo.settleAndTransact(
      scope,
      {
        reservationId: charge.reservationId,
        ...(actualUsdMicros !== undefined ? { actualMicros: actualUsdMicros } : {}),
      },
      [
        {
          kind: "integration-charge",
          id: charge.actionId,
          expectedRevision: 1,
          data: {
            ...charge,
            status,
            ...(actualUsdMicros !== undefined
              ? { actualUsdMicros, settledAt: new Date(this.now()).toISOString() }
              : {}),
          },
        },
      ],
      {
        type: "integration.cost." + status,
        aggregateId: charge.actionId,
        data: { reservationId: charge.reservationId, actualUsdMicros },
      },
    );
  }
  private async ceo(companyId: string, ceoId: string) {
    const identity = await this.repo.getIdentity();
    if (!identity || identity.companyId !== companyId || identity.id !== ceoId)
      throw new DomainError("ceo_required", undefined, 403);
  }
  async list(companyId: string, ceoId: string) {
    await this.ceo(companyId, ceoId);
    return integrationChargesResultSchema.parse({
      charges: (await this.repo.listCompanyDocuments<IntegrationCharge>(companyId, "integration-charge")).map(
        (record) => ({ ...record.data, scope: record.scope, revision: record.revision }),
      ),
    });
  }
  /** Explicit CEO reconciliation stores supplied provider statement bytes atomically with the ledger change. */
  async reconcile(companyId: string, ceoId: string, actionId: string, expectedRevision: number, input: unknown) {
    await this.ceo(companyId, ceoId);
    z.uuid().parse(actionId);
    const parsed = integrationReconcileInputSchema.parse(input),
      actualUsdMicros = parsed.actualUsdMicros;
    const current = (await this.repo.listCompanyDocuments<IntegrationCharge>(companyId, "integration-charge")).find(
      (record) => record.id === actionId,
    );
    if (!current || current.revision !== expectedRevision) throw new DomainError("revision_conflict");
    const scope = current.scope;
    if (!["unreconciled", "dispatched"].includes(current.data.status))
      throw new DomainError("integration_cost_already_settled");
    const action = await this.repo.getDocument<ToolAction>(scope, "action", actionId);
    if (!action || ["running", "dispatched"].includes(action.data.status))
      throw new DomainError("integration_action_still_running");
    const evidenceSha256 = createHash("sha256")
      .update(Buffer.from(parsed.evidence.contentBase64, "base64"))
      .digest("hex");
    const data = {
      ...current.data,
      status: "settled" as const,
      actualUsdMicros,
      settledAt: new Date(this.now()).toISOString(),
      reconciliationEvidenceSha256: evidenceSha256,
    };
    await this.repo.settleAndTransact(
      scope,
      { reservationId: current.data.reservationId, actualMicros: actualUsdMicros },
      [
        { kind: "integration-charge", id: actionId, expectedRevision, data },
        {
          kind: "integration-cost-evidence",
          id: actionId,
          data: { ...parsed.evidence, sha256: evidenceSha256, providedBy: ceoId, providedAt: data.settledAt },
          immutable: true,
          expectedRevision: 0,
        },
      ],
      {
        type: "integration.cost.reconciled",
        aggregateId: actionId,
        data: { actualUsdMicros, evidenceSha256, providedBy: ceoId },
      },
    );
    return integrationChargeResultSchema.parse({ ...data, scope, revision: expectedRevision + 1 });
  }
}
