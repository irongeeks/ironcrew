import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Repository } from "../../persistence/src/index.ts";
import type { Scope, Json } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { shaUuid } from "../../runtime/src/engine.ts";
import { digest, ToolError } from "../../tools/workspace.ts";
import { ManagedActions, type ActionRequest } from "./actions.ts";
import { FinanceCorrections } from "./finance-corrections.ts";
const minor = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const invoiceSchema = z
  .object({
    id: z.string().min(1),
    supplierId: z.string().min(1),
    direction: z.enum(["receivable", "payable"]).optional(),
    reference: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    totalMinor: minor,
    paidMinor: minor,
    dueAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    source: z.string().min(1),
    disputed: z.boolean(),
    paymentPause: z.boolean(),
    bankAccount: z.string().optional(),
    reportedBankBalanceMinor: minor.optional(),
  })
  .refine((invoice) => BigInt(invoice.paidMinor) <= BigInt(invoice.totalMinor), "Payment exceeds invoice total");
export type Invoice = z.infer<typeof invoiceSchema>;
export const reminderRuleSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    approvedByCeo: z.boolean(),
    enabled: z.boolean(),
    invoiceIds: z.array(z.string().min(1)).min(1),
    recipients: z.array(z.email()).min(1),
    targetIds: z.array(z.uuid()).min(1),
    minOverdueDays: z.number().int().nonnegative(),
    maxDataAgeSeconds: z.number().int().min(1).max(300),
    stage: z.number().int().positive(),
    feesMinor: z.literal("0"),
  })
  .strict();
export type ReminderRule = z.infer<typeof reminderRuleSchema>;
export type VoucherInput = {
  originalSha256: string;
  originalBase64: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  invoice: Invoice;
  voucherDate?: string;
};
export const voucherInputSchema = z
  .object({
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalBase64: z.string().min(4).max(12_000_000),
    mediaType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
    invoice: invoiceSchema,
    voucherDate: z
      .string()
      .regex(/^\d{2}\.\d{2}\.\d{4}$/)
      .optional(),
  })
  .strict();
export class FinanceWorkflow {
  repo: Repository;
  directory: string;
  now: () => Date;
  constructor(repo: Repository, directory: string, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.directory = path.resolve(directory);
    this.now = now;
  }
  private async original(input: VoucherInput) {
    const bytes = Buffer.from(input.originalBase64, "base64");
    if (bytes.length > 8_000_000 || bytes.length === 0 || bytes.toString("base64") !== input.originalBase64)
      throw new DomainError("voucher_content_invalid");
    if (digest(bytes) !== input.originalSha256) throw new DomainError("voucher_hash_mismatch");
    const valid =
      input.mediaType === "application/pdf"
        ? bytes.subarray(0, 5).toString() === "%PDF-" && bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
        : input.mediaType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    if (!valid) throw new DomainError("voucher_mime_mismatch");
    const directory = path.join(this.directory, "blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const blob = path.join(directory, input.originalSha256),
      temporary = path.join(directory, "." + randomUUID() + ".upload");
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, blob);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (digest(await readFile(blob)) !== input.originalSha256) throw new DomainError("blob_corrupt");
    } finally {
      await unlink(temporary);
    }
    return { bytes: bytes.length, mediaType: input.mediaType, sha256: input.originalSha256 };
  }
  async ingest(scope: Scope, orderId: string, input: VoucherInput) {
    await this.repo.getOrder(scope, orderId);
    const validated = voucherInputSchema.parse(input),
      original = await this.original(validated),
      invoice = validated.invoice;
    const byContent = shaUuid("content:" + original.sha256),
      semantic = shaUuid("invoice:" + JSON.stringify([invoice.supplierId, invoice.reference]));
    const lookup = async () =>
      (await this.repo.getDocument<{ voucherId: string }>(scope, "voucher-dedupe", byContent)) ??
      (await this.repo.getDocument<{ voucherId: string }>(scope, "voucher-dedupe", semantic));
    const prior = await lookup();
    if (prior) return { duplicate: true, voucherId: prior.data.voucherId };
    const id = randomUUID();
    try {
      await this.repo.transact(
        scope,
        [
          {
            kind: "voucher",
            id,
            data: {
              id,
              orderId,
              originalSha256: original.sha256,
              originalMediaType: original.mediaType,
              originalBytes: original.bytes,
              invoice,
              ...(validated.voucherDate ? { voucherDate: validated.voucherDate } : {}),
              state: "received",
              createdAt: this.now().toISOString(),
            },
          },
          { kind: "voucher-original", id: byContent, data: { ...original, voucherId: id, orderId }, immutable: true },
          { kind: "voucher-dedupe", id: byContent, data: { voucherId: id }, immutable: true },
          { kind: "voucher-dedupe", id: semantic, data: { voucherId: id }, immutable: true },
        ],
        { type: "finance.voucher_received", aggregateId: orderId },
      );
    } catch (error) {
      const concurrent = await lookup();
      if (concurrent) return { duplicate: true, voucherId: concurrent.data.voucherId };
      throw error;
    }
    return { duplicate: false, voucherId: id };
  }
  async snapshot(scope: Scope, invoices: Invoice[]) {
    const parsed = z.array(invoiceSchema).parse(invoices);
    if (new Set(parsed.map((i) => i.id)).size !== parsed.length) throw new DomainError("duplicate_invoice_in_snapshot");
    const id = randomUUID(),
      groups: Record<string, { openMinor: bigint; overdueMinor: bigint; source: string[] }> = {};
    for (const invoice of parsed) {
      const item = groups[invoice.currency] ?? { openMinor: 0n, overdueMinor: 0n, source: [] };
      const unpaid = BigInt(invoice.totalMinor) - BigInt(invoice.paidMinor);
      item.openMinor += unpaid;
      if (Date.parse(invoice.dueAt) < this.now().getTime()) item.overdueMinor += unpaid;
      item.source.push(invoice.source);
      groups[invoice.currency] = item;
    }
    const data = {
      id,
      observedAt: this.now().toISOString(),
      invoices: parsed,
      metrics: Object.entries(groups).map(([currency, g]) => ({
        currency,
        openMinor: g.openMinor.toString(),
        overdueMinor: g.overdueMinor.toString(),
        sources: g.source,
        definition: "Sum of invoice total less reliable recorded partial payments; no inferred bank balance",
      })),
      bankBalance: {
        status: "unavailable",
        reason: "Account balance requires its own reported source; transaction sum is not a bank balance",
      },
    };
    await this.repo.putDocument(scope, "finance-snapshot", id, data, { immutable: true });
    return data;
  }
  async correction(
    scope: Scope,
    voucherId: string,
    input: { field: string; value: Json; reuse: boolean; scopeDescription?: string; source: string },
  ) {
    return new FinanceCorrections(this.repo, this.directory, this.now).correct(scope, voucherId, input);
  }
  async approveRule(scope: Scope, id: string, reviewerId: string, evidence: string) {
    return new FinanceCorrections(this.repo, this.directory, this.now).review(scope, id, reviewerId, evidence);
  }
  async preparePayment(
    scope: Scope,
    voucherId: string,
    input: { recipient: string; bankAccount: string; reference: string; amountMinor: string },
  ) {
    z.object({
      recipient: z.string().trim().min(1),
      bankAccount: z.string().trim().min(1),
      reference: z.string().trim().min(1),
      amountMinor: minor,
    }).parse(input);
    const voucher = await this.repo.getDocument<{ orderId: string; invoice: Invoice }>(scope, "voucher", voucherId);
    if (!voucher) throw new DomainError("voucher_not_found");
    const invoice = invoiceSchema.parse(voucher.data.invoice);
    if (invoice.direction === "receivable") throw new DomainError("payment_direction_invalid");
    if (invoice.disputed || invoice.paymentPause) throw new DomainError("payment_suppressed");
    const expected = BigInt(invoice.totalMinor) - BigInt(invoice.paidMinor);
    if (expected <= 0n || input.amountMinor !== expected.toString()) throw new DomainError("payment_amount_mismatch");
    const previous = await this.repo.getDocument<{ bankAccount: string }>(
      scope,
      "supplier-bank",
      shaUuid(invoice.supplierId),
    );
    const changed = !previous || previous.data.bankAccount !== input.bankAccount;
    const id = randomUUID(),
      data = {
        ...input,
        id,
        orderId: voucher.data.orderId,
        voucherId,
        currency: invoice.currency,
        state: "prepared",
        bankAccountReviewRequired: changed,
        importAvailable: false,
        importReason: "Banking application and import format not validated",
        paid: false,
      };
    await this.repo.putDocument(scope, "payment-preparation", id, data, { immutable: true });
    return data;
  }
  private freshInvoice(invoice: Invoice, rule: ReminderRule, invoiceId: string) {
    const now = this.now().getTime();
    if (
      invoice.id !== invoiceId ||
      now - Date.parse(invoice.observedAt) > rule.maxDataAgeSeconds * 1000 ||
      Date.parse(invoice.observedAt) > now + 1000
    )
      throw new ToolError("payment_data_stale");
    if (
      invoice.direction === "payable" ||
      invoice.disputed ||
      invoice.paymentPause ||
      BigInt(invoice.paidMinor) >= BigInt(invoice.totalMinor) ||
      now - Date.parse(invoice.dueAt) < rule.minOverdueDays * 86400_000
    )
      throw new ToolError("reminder_suppressed");
  }
  async reminder(
    scope: Scope,
    orderId: string,
    ruleInput: ReminderRule,
    invoiceId: string,
    to: string,
    actions: ManagedActions,
    request: Omit<ActionRequest, "id" | "scope" | "orderId" | "effect" | "args">,
    readInvoice: () => Promise<Invoice>,
    send: (invoice: Invoice) => Promise<unknown>,
  ) {
    const rule = reminderRuleSchema.parse(ruleInput);
    const persisted = await this.repo.getDocument<ReminderRule>(scope, "reminder-rule", `${rule.id}:${rule.version}`);
    if (
      (await this.repo.getDocument(scope, "reminder-rule-revocation", `${rule.id}:${rule.version}`)) ||
      !persisted ||
      sha256(persisted.data) !== sha256(rule) ||
      !rule.approvedByCeo ||
      !rule.enabled ||
      !rule.invoiceIds.includes(invoiceId) ||
      !rule.recipients.includes(to) ||
      !rule.targetIds.includes(request.targetId) ||
      request.toolId !== "sevdesk.reminder.send"
    )
      throw new DomainError("reminder_rule_denied");
    const id = shaUuid(JSON.stringify([rule.id, invoiceId, rule.stage]));
    const existing = await this.repo.getDocument(scope, "reminder-receipt", id);
    if (existing) return { state: "already_processed", id };
    const invoice = invoiceSchema.parse(await readInvoice());
    this.freshInvoice(invoice, rule, invoiceId);
    const invoiceHash = sha256({ ...invoice, observedAt: undefined });
    const result = await actions.perform(
      {
        ...request,
        id,
        scope,
        orderId,
        effect: "external_send",
        routineRuleId: rule.id,
        routineRuleVersion: rule.version,
        args: {
          invoiceId,
          to,
          ruleId: rule.id,
          ruleVersion: rule.version,
          stage: rule.stage,
          invoiceHash,
          outstandingMinor: (BigInt(invoice.totalMinor) - BigInt(invoice.paidMinor)).toString(),
        },
      },
      async (action) => {
        const fresh = invoiceSchema.parse(await readInvoice());
        this.freshInvoice(fresh, rule, invoiceId);
        if (sha256({ ...fresh, observedAt: undefined }) !== invoiceHash) throw new ToolError("payment_data_changed");
        await this.repo.assertAuthorized(scope, {
          action,
          targetId: request.targetId,
          effect: "external_send",
          routineRuleId: rule.id,
          routineRuleVersion: rule.version,
        });
        return send(fresh);
      },
    );
    if (result.state !== "approval") {
      const prior = await this.repo.getDocument(scope, "reminder-receipt", id);
      if (!prior)
        try {
          await this.repo.putDocument(
            scope,
            "reminder-receipt",
            id,
            {
              id,
              orderId,
              invoiceId,
              ruleVersion: rule.version,
              stage: rule.stage,
              state: result.state,
              observedAt: invoice.observedAt,
            },
            { immutable: true },
          );
        } catch (error) {
          if (!(await this.repo.getDocument(scope, "reminder-receipt", id))) throw error;
        }
    }
    return result;
  }
}
