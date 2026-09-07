import path from "node:path";
import { FinanceCorrections } from "../../packages/domain/workflows/finance-corrections.ts";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope, ToolAction, Json } from "../../packages/contracts/src/index.ts";
import { DomainError, sameScope, sha256 } from "../../packages/domain/src/index.ts";
import { FinanceWorkflow, type ReminderRule } from "../../packages/domain/workflows/finance.ts";
import {
  FinanceAutomation,
  normalizeSevdeskInvoice,
  type ProcessingRule,
  type ReminderPolicy,
  type StoredVoucher,
} from "../../packages/domain/workflows/finance-automation.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import {
  IntegrationService,
  ProtonPassResolver,
  defaultTransport,
  type SecretResolver,
  type HttpTransport,
  type AuthorizedIntegrationAction,
  type IntegrationResult,
  toolCapabilities,
} from "../../packages/integrations/src/index.ts";
import { digest } from "../../packages/tools/workspace.ts";
import { readConfiguration, type Configuration } from "./configuration.ts";
type Options = {
  repo: Repository;
  directory: string;
  configuration?: () => Promise<Configuration>;
  secrets?: SecretResolver;
  transport?: HttpTransport;
  now?: () => Date;
};
export class FinanceService {
  readonly options: Options;
  readonly automation: FinanceAutomation;
  constructor(options: Options) {
    this.options = options;
    this.automation = new FinanceAutomation(options.repo, options.now);
  }
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  async list(companyId: string) {
    const result = await Promise.all(
      [
        "finance-processing-rule",
        "finance-reminder-policy",
        "finance-automation-status",
        "invoice-hold",
        "finance-rule",
      ].map((kind) => this.options.repo.listCompanyDocuments(companyId, kind)),
    );
    return {
      processingRules: result[0],
      reminderPolicies: result[1],
      statuses: result[2],
      holds: result[3],
      corrections: result[4],
    };
  }
  private async connection(
    scope: Scope,
    targetId: string,
    guard: () => Promise<void>,
    beforeEffect?: () => Promise<void>,
  ) {
    const config = await (this.options.configuration ?? (() => readConfiguration(this.options.directory)))();
    if (!config.liveExecutionEnabled) throw new DomainError("integration_not_configured");
    const c = config.connections.find(
      (c) => c.id === targetId && c.provider === "sevdesk" && sameScope(c.scope, scope),
    );
    if (!c) throw new DomainError("finance_target_unavailable");
    const fingerprint = sha256(c);
    const secrets =
      this.options.secrets ??
      (config.proton
        ? new ProtonPassResolver({
            executable: config.proton.executable,
            environment: {
              HOME: process.env.HOME,
              USERPROFILE: process.env.USERPROFILE,
              SYSTEMROOT: process.env.SYSTEMROOT,
              PATH: path.dirname(config.proton.executable),
              ...(config.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton.sessionDirectory } : {}),
            },
          })
        : undefined);
    if (!secrets) throw new DomainError("secret_provider_not_configured");
    const checkConfig = async () => {
      const fresh = await (this.options.configuration ?? (() => readConfiguration(this.options.directory)))();
      if (
        !fresh.liveExecutionEnabled ||
        sha256(fresh.connections.find((item) => item.id === targetId) ?? null) !== fingerprint
      )
        throw new DomainError("finance_configuration_changed");
    };
    const service = new IntegrationService({
      connections: [c],
      secrets,
      transport: async (request) => {
        if (request.method && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
          await guard();
          await beforeEffect?.();
        }
        await checkConfig();
        await guard();
        return (this.options.transport ?? defaultTransport)(request);
      },
      authorize: async () => {
        await guard();
        await checkConfig();
      },
    });
    return service;
  }
  private async status(scope: Scope, id: string, data: Record<string, unknown>) {
    const old = await this.options.repo.getDocument(scope, "finance-automation-status", id);
    return this.options.repo.putDocument(
      scope,
      "finance-automation-status",
      id,
      { id, ...data, at: this.now().toISOString() },
      { expectedRevision: old?.revision ?? 0 },
    );
  }
  async process(scope: Scope, voucherId: string) {
    const { repo, directory } = this.options;
    await repo.assertDispatchAllowed(scope.companyId);
    const voucher = await repo.getDocument<StoredVoucher>(scope, "voucher", voucherId);
    if (!voucher) throw new DomainError("voucher_not_found");
    const v = voucher.data;
    const finished = await repo.getDocument(scope, "finance-voucher-export", voucherId);
    if (finished) return finished.data;
    const rules = (await repo.listDocuments<ProcessingRule>(scope, "finance-processing-rule")).filter(
      ({ data: r }) =>
        r.state === "active" &&
        r.approvedBy &&
        r.review &&
        r.supplierId === v.invoice.supplierId &&
        r.currency === v.invoice.currency &&
        BigInt(r.minTotalMinor) <= BigInt(v.invoice.totalMinor) &&
        BigInt(r.maxTotalMinor) >= BigInt(v.invoice.totalMinor) &&
        r.mediaTypes.includes(v.originalMediaType as ProcessingRule["mediaTypes"][number]),
    );
    if (rules.length !== 1) {
      await this.status(scope, voucherId, {
        voucherId,
        orderId: v.orderId,
        state: "needs_review",
        reason: rules.length ? "ambiguous_processing_rules" : "no_matching_processing_rule",
      });
      return { state: "needs_review" };
    }
    const { data: rule, revision } = rules[0]!;
    if (
      !v.voucherDate ||
      v.invoice.direction !== "payable" ||
      v.invoice.disputed ||
      v.invoice.paymentPause ||
      v.invoice.paidMinor !== "0" ||
      v.originalBytes > 1_000_000
    ) {
      await this.status(scope, voucherId, {
        voucherId,
        orderId: v.orderId,
        state: "needs_review",
        reason: "voucher_exception",
      });
      return { state: "needs_review" };
    }
    if (
      new Intl.NumberFormat("en", { style: "currency", currency: rule.currency }).resolvedOptions()
        .maximumFractionDigits !== 2
    )
      throw new DomainError("currency_minor_units_unsupported");
    const bytes = await readFile(path.join(directory, "blobs", v.originalSha256));
    if (digest(bytes) !== v.originalSha256) throw new DomainError("original_blob_corrupt");
    const voucherHash = sha256(v);
    const corrections = new FinanceCorrections(repo, directory);
    const resolved = await corrections.resolve(scope, voucherId, rule);
    let activeAction: ToolAction | undefined;
    const guard = async () => {
      await repo.assertDispatchAllowed(scope.companyId);
      const current = await repo.getDocument<ProcessingRule>(scope, "finance-processing-rule", rule.id);
      const currentVoucher = await repo.getDocument<StoredVoucher>(scope, "voucher", voucherId);
      if (
        !current ||
        current.revision !== revision ||
        current.data.state !== "active" ||
        !currentVoucher ||
        sha256(currentVoucher.data) !== voucherHash
      )
        throw new DomainError("finance_rule_changed");
      if ((await corrections.resolve(scope, voucherId, rule)).fingerprint !== resolved.fingerprint)
        throw new DomainError("finance_correction_changed");
      if (activeAction)
        await repo.assertAuthorized(scope, {
          action: activeAction,
          targetId: rule.targetId,
          effect: toolCapabilities.find((t) => t.id === activeAction!.toolId)!.effect,
        });
    };
    const service = await this.connection(scope, rule.targetId, guard);
    const actions = new ManagedActions(repo, path.join(directory, "receipts"));
    const run = async (toolId: string, args: Record<string, Json>) => {
      await guard();
      const result = await actions.perform(
        {
          id: shaUuid(`finance:${voucherId}:${toolId}`),
          scope,
          orderId: v.orderId,
          toolId,
          targetId: rule.targetId,
          args,
          mandateId: rule.mandateId,
          mandateVersion: rule.mandateVersion,
          effect: "external_draft",
        },
        async (action) => {
          activeAction = action;
          return service.execute({ id: action.id, scope, toolId, targetId: rule.targetId, args });
        },
      );
      if (result.state !== "succeeded") {
        await this.status(scope, voucherId, {
          voucherId,
          orderId: v.orderId,
          ruleId: rule.id,
          state: result.state,
          actionId: result.id,
        });
        throw new DomainError(`finance_export_${result.state}`);
      }
      return result.data as IntegrationResult;
    };
    const ext = ({ "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as Record<string, string>)[
      v.originalMediaType
    ]!;
    const uploaded = await run("sevdesk.voucher.upload", {
      name: `voucher-${voucherId}.${ext}`,
      contentBase64: bytes.toString("base64"),
      mediaType: v.originalMediaType,
    });
    const filename = z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .parse(uploaded.externalId);
    const total = BigInt(v.invoice.totalMinor);
    await corrections.seal(scope, voucherId, resolved.fingerprint, voucher.revision);
    const staged = await run("sevdesk.voucher.stage", {
      filename,
      voucherDate: v.voucherDate,
      supplierId: resolved.classification.sevdeskSupplierId,
      description: v.invoice.reference,
      creditDebit: "D",
      currency: rule.currency,
      taxRuleId: resolved.classification.taxRuleId,
      positions: [
        {
          accountDatevId: resolved.classification.accountDatevId,
          taxRate: resolved.classification.taxRate,
          net: false,
          amount: `${total / 100n}.${String(total % 100n).padStart(2, "0")}`,
        },
      ],
    });
    const externalId = z.string().min(1).parse(staged.externalId);
    const current = await repo.getDocument<StoredVoucher>(scope, "voucher", voucherId);
    const data = {
      voucherId,
      orderId: v.orderId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      targetId: rule.targetId,
      externalId,
      state: "draft_created",
      classification: resolved.classification,
      corrections: resolved.applied,
      classificationFingerprint: resolved.fingerprint,
      at: this.now().toISOString(),
    };
    if (!(await repo.getDocument(scope, "finance-voucher-export", voucherId)))
      await repo.transact(
        scope,
        [
          { kind: "finance-voucher-export", id: voucherId, data, immutable: true },
          {
            kind: "voucher",
            id: voucherId,
            data: { ...current!.data, state: "draft_created", externalId },
            expectedRevision: current!.revision,
          },
        ],
        { type: "finance.voucher_exported", aggregateId: v.orderId },
      );
    await this.status(scope, voucherId, data);
    return data;
  }
  async remind(scope: Scope, id: string) {
    const { repo, directory } = this.options;
    const doc = await repo.getDocument<ReminderPolicy>(scope, "finance-reminder-policy", id);
    if (!doc || doc.data.state !== "active") throw new DomainError("reminder_rule_denied");
    const p = doc.data;
    const rule = (await repo.getDocument<ReminderRule>(scope, "reminder-rule", `${id}:1`))!.data;
    let activeAction: ToolAction | undefined;
    const guard = async () => {
      await repo.assertDispatchAllowed(scope.companyId);
      const current = await repo.getDocument<ReminderPolicy>(scope, "finance-reminder-policy", id);
      if (
        !current ||
        current.data.state !== "active" ||
        current.data.version !== p.version ||
        sha256({ ...current.data, nextCheckAt: undefined }) !== sha256({ ...p, nextCheckAt: undefined })
      )
        throw new DomainError("reminder_rule_denied");
      const hold = await repo.getDocument<{ disputed: boolean; paymentPause: boolean }>(
        scope,
        "invoice-hold",
        shaUuid(`${p.targetId}:${p.invoiceId}`),
      );
      if (hold?.data.disputed || hold?.data.paymentPause) throw new DomainError("reminder_suppressed");
      if (activeAction)
        await repo.assertAuthorized(scope, {
          action: activeAction,
          targetId: p.targetId,
          effect: "external_send",
          routineRuleId: id,
          routineRuleVersion: 1,
        });
    };
    const service = await this.connection(scope, p.targetId, guard, async () => {
      const fresh = await readInvoice();
      const args = activeAction?.args as { invoiceHash?: string } | undefined;
      if (
        !args?.invoiceHash ||
        sha256({ ...fresh, observedAt: undefined }) !== args.invoiceHash ||
        fresh.disputed ||
        fresh.paymentPause ||
        BigInt(fresh.paidMinor) >= BigInt(fresh.totalMinor) ||
        this.now().getTime() - Date.parse(fresh.observedAt) > p.maxDataAgeSeconds * 1000
      )
        throw new DomainError("payment_data_changed");
    });
    const readInvoice = async () => {
      const request: AuthorizedIntegrationAction = {
        id: randomUUID(),
        scope,
        targetId: p.targetId,
        toolId: "sevdesk.invoice.read",
        args: { invoiceId: p.invoiceId },
      };
      // The approved policy grants only this read; never a different customer or arbitrary tool.
      const data = await service.execute(request);
      const hold = await repo.getDocument<{ disputed: boolean; paymentPause: boolean }>(
        scope,
        "invoice-hold",
        shaUuid(`${p.targetId}:${p.invoiceId}`),
      );
      return normalizeSevdeskInvoice(
        data.data,
        data.observedAt,
        p.targetId,
        hold?.data ?? { disputed: false, paymentPause: false },
      );
    };
    class GuardedActions extends ManagedActions {
      override perform(
        request: Parameters<ManagedActions["perform"]>[0],
        execute: Parameters<ManagedActions["perform"]>[1],
      ) {
        return super.perform(request, async (action) => {
          activeAction = action;
          return execute(action);
        });
      }
    }
    const result = await new FinanceWorkflow(repo, directory, () => this.now()).reminder(
      scope,
      p.orderId,
      rule,
      p.invoiceId,
      p.recipient,
      new GuardedActions(repo, path.join(directory, "receipts")),
      {
        toolId: "sevdesk.reminder.send",
        targetId: p.targetId,
        mandateId: p.mandateId,
        mandateVersion: p.mandateVersion,
      },
      readInvoice,
      async () => {
        await guard();
        return service.execute({
          id: activeAction!.id,
          scope,
          targetId: p.targetId,
          toolId: "sevdesk.reminder.send",
          args: { invoiceId: p.invoiceId, to: p.recipient, subject: p.subject, text: p.text },
        });
      },
    );
    await this.status(scope, id, { policyId: id, orderId: p.orderId, state: result.state, actionId: result.id });
    return result;
  }
  async tick(companyId: string) {
    const { repo } = this.options;
    await repo.assertDispatchAllowed(companyId);
    for (const voucher of (await repo.listCompanyDocuments<StoredVoucher>(companyId, "voucher"))
      .filter((v) => v.data.state === "received")
      .slice(0, 20)) {
      try {
        await this.process(voucher.scope, voucher.id);
      } catch (error) {
        await this.status(voucher.scope, voucher.id, {
          voucherId: voucher.id,
          orderId: voucher.data.orderId,
          state: "blocked",
          reason: error instanceof DomainError ? error.code : "finance_export_failed",
        });
      }
    }
    for (const policy of await repo.listCompanyDocuments<ReminderPolicy>(companyId, "finance-reminder-policy")) {
      if (policy.data.state !== "active" || Date.parse(policy.data.nextCheckAt) > this.now().getTime()) continue;
      const { data: p } = policy;
      await repo.putDocument(
        policy.scope,
        "finance-reminder-policy",
        policy.id,
        { ...p, nextCheckAt: new Date(this.now().getTime() + p.intervalSeconds * 1000).toISOString() },
        { expectedRevision: policy.revision },
      );
      try {
        await this.remind(policy.scope, policy.id);
      } catch (error) {
        await this.status(policy.scope, policy.id, {
          policyId: policy.id,
          orderId: p.orderId,
          state: "needs_review",
          reason: error instanceof DomainError ? error.code : "reminder_check_failed",
        });
      }
    }
  }
}
