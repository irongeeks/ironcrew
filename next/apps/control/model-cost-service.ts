import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Repository, Document } from "../../packages/persistence/src/index.ts";
import { scopeSchema } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import type { Run } from "../../packages/runtime/src/engine.ts";
import { OpenRouterClient, type GenerationClient, type ModelRequest } from "../../packages/runtime/src/openrouter.ts";
import { ProtonPassResolver } from "../../packages/integrations/src/secrets.ts";
import { readConfiguration } from "./configuration.ts";
import { integrationReconcileInputSchema } from "./integration-costs.ts";
import { recoveryGeneration } from "./oauth-broker.ts";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  micros = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const modelCostResultSchema = z
  .object({
    id: z.uuid(),
    scope: scopeSchema,
    revision: z.number().int().positive(),
    orderId: z.uuid(),
    modelId: z.string(),
    providerId: z.string().optional(),
    state: z.enum(["sent", "complete", "interrupted"]),
    usageState: z.enum(["pending", "reconciled", "unreconciled"]),
    reservationId: z.uuid(),
    reservationState: z.enum(["held", "unreconciled", "settled", "released"]),
    reservedUsdMicros: micros,
    actualUsdMicros: micros.optional(),
    requestSha256: hash,
    responseAvailable: z.boolean(),
    discardAvailable: z.boolean(),
    runRevision: z.number().int().positive().optional(),
    evidenceSha256: hash.optional(),
  })
  .strict();
export const modelCostsResultSchema = z.object({ turns: z.array(modelCostResultSchema) }).strict();
export const modelCostManualSchema = integrationReconcileInputSchema;
type Turn = {
  id: string;
  runId: string;
  modelId: string;
  requestSha256: string;
  request: ModelRequest;
  reservationId: string;
  providerId?: string;
  state: "sent" | "complete" | "interrupted";
  usageState: "pending" | "reconciled" | "unreconciled";
  response?: { id: string; costUsdMicros?: string };
  [key: string]: unknown;
};
export class ModelCostService {
  readonly options: {
    repo: Repository;
    directory: string;
    client?: GenerationClient;
    isRunActive?: (orderId: string) => boolean;
  };
  constructor(options: ModelCostService["options"]) {
    this.options = options;
  }
  private async ceo(companyId: string, ceoId: string) {
    const identity = await this.options.repo.getIdentity();
    if (!identity || identity.companyId !== companyId || identity.id !== ceoId)
      throw new DomainError("ceo_required", undefined, 403);
  }
  private async dto(record: Document<Turn>) {
    const reservation = (await this.options.repo.budget(record.scope.companyId)).reservations.find(
      (r) => r.id === record.data.reservationId,
    );
    if (!reservation || reservation.modelTurnId !== record.id || reservation.orderId !== record.data.runId)
      throw new DomainError("model_cost_reservation_binding");
    const receipt = await this.options.repo.getDocument<{ sha256: string; turnId: string; requestSha256: string }>(
      record.scope,
      "model-cost-evidence",
      record.id,
    );
    const run = await this.options.repo.getDocument<Run>(record.scope, "run", record.data.runId);
    const discardAvailable = Boolean(
      run &&
      run.data.pendingTurnId === record.id &&
      run.data.blockedReason === "model_response_unknown" &&
      receipt &&
      receipt.data.turnId === record.id &&
      receipt.data.requestSha256 === record.data.requestSha256 &&
      record.data.usageState === "reconciled" &&
      !record.data.response &&
      ["settled", "released"].includes(reservation.state) &&
      this.options.isRunActive &&
      !this.options.isRunActive(record.data.runId),
    );
    return modelCostResultSchema.parse({
      id: record.id,
      scope: record.scope,
      revision: record.revision,
      orderId: record.data.runId,
      modelId: record.data.modelId,
      providerId: record.data.providerId,
      state: record.data.state,
      usageState: record.data.usageState,
      reservationId: reservation.id,
      reservationState: reservation.state,
      reservedUsdMicros: reservation.reservedUsdMicros,
      actualUsdMicros: reservation.settledUsdMicros,
      requestSha256: record.data.requestSha256,
      responseAvailable: record.data.state === "complete" && Boolean(record.data.response),
      discardAvailable,
      ...(discardAvailable && run ? { runRevision: run.revision } : {}),
      ...(receipt ? { evidenceSha256: receipt.data.sha256 } : {}),
    });
  }
  async list(companyId: string, ceoId: string) {
    await this.ceo(companyId, ceoId);
    return modelCostsResultSchema.parse({
      turns: await Promise.all(
        (await this.options.repo.listCompanyDocuments<Turn>(companyId, "model-turn")).map((record) => this.dto(record)),
      ),
    });
  }
  private async target(companyId: string, ceoId: string, id: string, revision: number) {
    await this.ceo(companyId, ceoId);
    z.uuid().parse(id);
    const record = (await this.options.repo.listCompanyDocuments<Turn>(companyId, "model-turn")).find(
      (r) => r.id === id,
    );
    if (!record || record.revision !== revision) throw new DomainError("revision_conflict");
    if (
      record.data.id !== id ||
      record.data.request.model !== record.data.modelId ||
      sha256(record.data.request) !== record.data.requestSha256
    )
      throw new DomainError("model_cost_request_binding");
    const dto = await this.dto(record);
    if (!["held", "unreconciled"].includes(dto.reservationState) || record.data.usageState === "reconciled")
      throw new DomainError("model_cost_already_settled");
    const run = await this.options.repo.getDocument<Run>(record.scope, "run", record.data.runId);
    if (!run || sha256(run.data.scope) !== sha256(record.scope)) throw new DomainError("model_cost_run_binding");
    if (!this.options.isRunActive || this.options.isRunActive(record.data.runId))
      throw new DomainError("model_cost_run_active");
    return record;
  }
  async provider(companyId: string, ceoId: string, id: string, revision: number) {
    const record = await this.target(companyId, ceoId, id, revision),
      generation = await recoveryGeneration(this.options.repo, record.scope);
    if (!record.data.providerId || record.data.response?.id !== record.data.providerId)
      throw new DomainError("model_cost_provider_id_unknown");
    const turns = await this.options.repo.listCompanyDocuments<Turn>(companyId, "model-turn");
    if (turns.some((other) => other.id !== record.id && other.data.providerId === record.data.providerId))
      throw new DomainError("model_cost_provider_id_reused");
    const configuration = this.options.client ? undefined : await readConfiguration(this.options.directory);
    const configSha = configuration
      ? sha256({ proton: configuration.proton, openrouter: configuration.openrouter })
      : undefined;
    if (!this.options.client && (!configuration?.proton || !configuration.openrouter))
      throw new DomainError("model_cost_provider_unconfigured");
    const authorize = async () => {
      await this.target(companyId, ceoId, id, revision);
      if ((await recoveryGeneration(this.options.repo, record.scope)) !== generation)
        throw new DomainError("model_cost_recovery_changed");
      if (configuration) {
        const fresh = await readConfiguration(this.options.directory);
        if (sha256({ proton: fresh.proton, openrouter: fresh.openrouter }) !== configSha)
          throw new DomainError("model_cost_configuration_changed");
      }
    };
    const client =
      this.options.client ??
      new OpenRouterClient({
        secret: async () => {
          const config = configuration!;
          const resolver = new ProtonPassResolver({
            executable: config.proton!.executable,
            environment: {
              HOME: process.env.HOME,
              USERPROFILE: process.env.USERPROFILE,
              SYSTEMROOT: process.env.SYSTEMROOT,
              PATH: path.dirname(config.proton!.executable),
              ...(config.proton!.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton!.sessionDirectory } : {}),
            },
          });
          return resolver.resolve(config.openrouter!.secretRef, `CEO usage reconciliation for stored turn ${id}`);
        },
      });
    const usage = await client.generation(record.data.providerId, { beforeDispatch: authorize });
    await authorize();
    if (usage.id !== record.data.providerId || usage.modelId !== record.data.modelId)
      throw new DomainError("model_cost_provider_binding");
    micros.parse(usage.costUsdMicros);
    const evidence = {
      kind: "provider",
      provider: "openrouter",
      generationId: usage.id,
      modelId: usage.modelId,
      costUsdMicros: usage.costUsdMicros,
      observedAt: new Date().toISOString(),
      ...(usage.createdAt ? { providerCreatedAt: usage.createdAt } : {}),
    };
    return this.settle(record, ceoId, usage.costUsdMicros, { ...evidence, sha256: sha256(evidence) });
  }
  async manual(companyId: string, ceoId: string, id: string, revision: number, input: unknown) {
    const parsed = modelCostManualSchema.parse(input),
      record = await this.target(companyId, ceoId, id, revision);
    const evidence = {
      kind: "manual",
      ...parsed.evidence,
      sha256: createHash("sha256").update(Buffer.from(parsed.evidence.contentBase64, "base64")).digest("hex"),
    };
    return this.settle(record, ceoId, parsed.actualUsdMicros, evidence);
  }
  private async settle(
    record: Document<Turn>,
    ceoId: string,
    actualUsdMicros: string,
    evidence: Record<string, unknown> & { sha256: string },
  ) {
    await this.target(record.scope.companyId, ceoId, record.id, record.revision);
    const data = { ...record.data, usageState: "reconciled" as const };
    await this.options.repo.settleAndTransact(
      record.scope,
      { reservationId: record.data.reservationId, actualMicros: actualUsdMicros },
      [
        { kind: "model-turn", id: record.id, data, expectedRevision: record.revision },
        {
          kind: "model-cost-evidence",
          id: record.id,
          data: {
            ...evidence,
            turnId: record.id,
            requestSha256: record.data.requestSha256,
            providedBy: ceoId,
            recordedAt: new Date().toISOString(),
          },
          immutable: true,
          expectedRevision: 0,
        },
      ],
      {
        type: "model.cost.reconciled",
        aggregateId: record.id,
        data: { actualUsdMicros, evidenceSha256: evidence.sha256 },
      },
    );
    // No mutation of run.pendingTurnId, response or workflow output: accounting cannot recover missing model content.
    return this.dto({ ...record, data, revision: record.revision + 1 });
  }
}
