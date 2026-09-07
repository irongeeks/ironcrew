import { constants } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Scope, type Json, orderKindSchema, microsSchema } from "../../packages/contracts/src/index.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError, sha256, sameScope } from "../../packages/domain/src/index.ts";
import { Channels } from "../../packages/domain/workflows/automation.ts";
import { FinanceWorkflow, invoiceSchema } from "../../packages/domain/workflows/finance.ts";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
import { type InboundMail, type MailCursor, verifyMailBlob } from "../../packages/integrations/src/mail-inbound.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";
import type { SecretResolver } from "../../packages/integrations/src/secrets.ts";
import type { OAuthTokenBroker } from "../../packages/integrations/src/oauth.ts";
import { recoveryGeneration } from "./oauth-broker.ts";
import type { MailConfiguration } from "./mail-broker.ts";
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const mailInboxPolicySchema = z
  .object({
    targetId: z.uuid(),
    targetConfigSha256: hashSchema,
    enabled: z.boolean().default(false),
    expiresAt: z.iso.datetime(),
    kind: orderKindSchema.default("research"),
    budgetLimitUsdMicros: microsSchema.default("0"),
    pollIntervalSeconds: z.number().int().min(30).max(86400).default(300),
    limit: z.number().int().min(1).max(100).default(20),
    maxMessageBytes: z
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    maxBatchBytes: z
      .number()
      .int()
      .min(1024)
      .max(25 * 1024 * 1024)
      .default(20 * 1024 * 1024),
  })
  .strict()
  .refine((v) => v.maxBatchBytes >= v.maxMessageBytes, "Batchlimit darf Nachrichtenlimit nicht unterschreiten.");
export const mailFinanceImportSchema = z
  .object({
    attachmentSha256: hashSchema,
    invoice: invoiceSchema,
    voucherDate: z
      .string()
      .regex(/^\d{2}\.\d{2}\.\d{4}$/)
      .optional(),
  })
  .strict();
type Policy = z.output<typeof mailInboxPolicySchema> & {
  id: string;
  scope: Scope;
  approvedBy: string;
  generation: string | null;
  nextPollAt: string;
  lastErrorCode?: string;
};
export type StoredInboundMail = Omit<InboundMail, "original" | "attachments"> & {
  original?: { sha256: string; bytes: number };
  attachments: Array<Omit<InboundMail["attachments"][number], "content">>;
  orderId?: string;
  policyId: string;
  policyConfigSha256: string;
  importState: "pending" | "complete";
  channel: { kind: z.infer<typeof orderKindSchema>; budgetLimitUsdMicros: string };
};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Json;
export interface MailInboxOptions {
  repo: Repository;
  directory: string;
  configuration: () => Promise<MailConfiguration>;
  secrets: SecretResolver;
  oauth?: OAuthTokenBroker;
  now?: () => Date;
}
/** Trusted mailbox routes select the scope. MIME fields and headers remain untrusted content. */
export class MailInboxService {
  private readonly options: MailInboxOptions;
  private readonly busy = new Set<string>();
  constructor(options: MailInboxOptions) {
    this.options = options;
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async ceo(companyId: string, ceoId: string) {
    const identity = await this.options.repo.getIdentity();
    if (!identity || identity.companyId !== companyId || identity.id !== ceoId)
      throw new DomainError("ceo_required", undefined, 403);
  }
  private async generation(scope: Scope) {
    return recoveryGeneration(this.options.repo, scope);
  }
  private async target(companyId: string, targetId: string) {
    const config = await this.options.configuration(),
      target = config.mailConnections.find(
        (t) => t.id === targetId && t.scope.companyId === companyId && t.enabledTools.includes("mail.read"),
      );
    if (!target) throw new DomainError("mail_target_denied", undefined, 403);
    return target;
  }
  async policies(companyId: string, ceoId: string) {
    await this.ceo(companyId, ceoId);
    return (await this.options.repo.listCompanyDocuments<Policy>(companyId, "mail-inbox-policy")).map((d) => ({
      ...d.data,
      revision: d.revision,
    }));
  }
  async targets(companyId: string, ceoId: string) {
    await this.ceo(companyId, ceoId);
    return (await this.options.configuration()).mailConnections
      .filter((t) => t.scope.companyId === companyId && t.enabledTools.includes("mail.read"))
      .map((t) => ({
        id: t.id,
        scope: t.scope,
        host: t.host,
        username: t.username,
        mailbox: t.mailbox ?? "INBOX",
        targetConfigSha256: sha256(t),
      }));
  }
  async configure(companyId: string, ceoId: string, input: unknown, update?: { id: string; expectedRevision: number }) {
    await this.ceo(companyId, ceoId);
    const policy = mailInboxPolicySchema.parse(input),
      target = await this.target(companyId, policy.targetId);
    if (sha256(target) !== policy.targetConfigSha256) throw new DomainError("mail_target_changed", undefined, 409);
    if (policy.enabled && Date.parse(policy.expiresAt) <= this.now().getTime())
      throw new DomainError("mail_policy_expired");
    const existing = update
      ? await this.options.repo.getDocument<Policy>(target.scope, "mail-inbox-policy", update.id)
      : undefined;
    if (update && (!existing || existing.revision !== update.expectedRevision))
      throw new DomainError("revision_conflict", undefined, 409);
    if (existing && existing.data.targetId !== target.id) throw new DomainError("mail_policy_target_changed");
    const others = await this.options.repo.listCompanyDocuments<Policy>(companyId, "mail-inbox-policy");
    if (others.some((p) => p.id !== update?.id && p.data.targetId === target.id))
      throw new DomainError("mail_policy_exists", undefined, 409);
    const id = update?.id ?? target.id;
    const data: Policy = {
      ...policy,
      id,
      scope: target.scope,
      approvedBy: ceoId,
      generation: await this.generation(target.scope),
      nextPollAt: this.now().toISOString(),
    };
    const stored = await this.options.repo.putDocument(target.scope, "mail-inbox-policy", id, json(data), {
      expectedRevision: update?.expectedRevision ?? 0,
    });
    return { ...data, revision: stored.revision };
  }
  private async policy(companyId: string, id: string) {
    const found = (await this.options.repo.listCompanyDocuments<Policy>(companyId, "mail-inbox-policy")).find(
      (p) => p.id === id,
    );
    if (!found) throw new DomainError("mail_policy_not_found", undefined, 404);
    return found;
  }
  async poll(companyId: string, ceoId: string, policyId: string) {
    await this.ceo(companyId, ceoId);
    return this.run(await this.policy(companyId, policyId));
  }
  async tick(companyId: string) {
    const policies = await this.options.repo.listCompanyDocuments<Policy>(companyId, "mail-inbox-policy"),
      results = [];
    for (const policy of policies) {
      if (
        !policy.data.enabled ||
        Date.parse(policy.data.expiresAt) <= this.now().getTime() ||
        Date.parse(policy.data.nextPollAt) > this.now().getTime()
      )
        continue;
      try {
        results.push({ policyId: policy.id, state: "succeeded", result: await this.run(policy) });
      } catch (error) {
        const code =
          error instanceof DomainError || error instanceof IntegrationError ? error.code : "mail_poll_failed";
        results.push({ policyId: policy.id, state: "failed", code });
        await this.options.repo
          .putDocument(
            policy.scope,
            "mail-inbox-policy",
            policy.id,
            {
              ...policy.data,
              nextPollAt: new Date(this.now().getTime() + policy.data.pollIntervalSeconds * 1000).toISOString(),
              lastErrorCode: code,
            },
            { expectedRevision: policy.revision },
          )
          .catch(() => {});
      }
    }
    return results;
  }
  private async run(record: { id: string; scope: Scope; revision: number; data: Policy }) {
    const { repo } = this.options,
      policy = record.data,
      key = policy.targetId;
    if (this.busy.has(key)) throw new DomainError("mail_poll_busy", undefined, 409);
    this.busy.add(key);
    try {
      const authorize = async () => {
        await this.ceo(policy.scope.companyId, policy.approvedBy);
        const fresh = await repo.getDocument<Policy>(policy.scope, "mail-inbox-policy", policy.id),
          target = await this.target(policy.scope.companyId, policy.targetId);
        const setup = await repo.snapshot(policy.scope.companyId),
          companyScope = {
            companyId: policy.scope.companyId,
            areaId: setup.areas.find((a) => a.visibility === "company")!.id,
          };
        const recovery = await repo.getDocument<{ generation?: string; dispatchPaused?: boolean }>(
          companyScope,
          "recovery-state",
          policy.scope.companyId,
        );
        if (
          !fresh ||
          fresh.revision !== record.revision ||
          !fresh.data.enabled ||
          Date.parse(fresh.data.expiresAt) <= this.now().getTime() ||
          sha256(target) !== policy.targetConfigSha256 ||
          !sameScope(target.scope, policy.scope) ||
          recovery?.data.dispatchPaused ||
          (recovery?.data.generation ?? null) !== policy.generation
        )
          throw new DomainError("mail_poll_authorization_changed", undefined, 403);
      };
      await authorize();
      const target = await this.target(policy.scope.companyId, policy.targetId),
        cursorId = policy.targetId,
        cursor = await repo.getDocument<{ cursor: MailCursor; targetConfigSha256: string }>(
          policy.scope,
          "mail-inbox-cursor",
          cursorId,
        );
      if (cursor && cursor.data.targetConfigSha256 !== policy.targetConfigSha256)
        throw new DomainError("mail_cursor_target_changed", undefined, 409);
      const connector = new MailConnector(target, this.options.secrets, authorize, {
        oauth: this.options.oauth,
        oauthGeneration: () => this.generation(policy.scope),
      });
      const result = await connector.pollInbound(
        {
          id: randomUUID(),
          scope: policy.scope,
          targetId: target.id,
          toolId: "mail.read",
          args: { limit: policy.limit },
        },
        {
          cursor: cursor?.data.cursor,
          limit: policy.limit,
          maxMessageBytes: policy.maxMessageBytes,
          maxBatchBytes: policy.maxBatchBytes,
        },
        async (message) => {
          await authorize();
          await this.persist(policy, message, authorize);
        },
      );
      await authorize();
      await repo.transact(
        policy.scope,
        [
          {
            kind: "mail-inbox-cursor",
            id: cursorId,
            data: json({ cursor: result.cursor, targetConfigSha256: policy.targetConfigSha256 }),
            expectedRevision: cursor?.revision ?? 0,
          },
          {
            kind: "mail-inbox-policy",
            id: policy.id,
            data: json({
              ...policy,
              nextPollAt: new Date(this.now().getTime() + policy.pollIntervalSeconds * 1000).toISOString(),
              lastErrorCode: undefined,
            }),
            expectedRevision: record.revision,
          },
        ],
        { type: "mail.inbox_polled", aggregateId: policy.id },
      );
      return result;
    } catch (error) {
      if (error instanceof IntegrationError)
        throw new DomainError(
          "mail_" + error.code,
          error.message,
          error.code === "authorization" ? 403 : error.code === "conflict" ? 409 : 502,
        );
      throw error;
    } finally {
      this.busy.delete(key);
    }
  }
  private async saveBlob(bytes: Buffer, hash: string) {
    verifyMailBlob(bytes, hash);
    const directory = path.join(this.options.directory, "blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, hash),
      temporary = path.join(directory, "." + randomUUID() + ".mail"),
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.readBlob(hash);
    } finally {
      await unlink(temporary);
    }
  }
  private async readBlob(hash: string) {
    hashSchema.parse(hash);
    const handle = await open(
      path.join(this.options.directory, "blobs", hash),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 10 * 1024 * 1024)
        throw new DomainError("mail_blob_invalid");
      const bytes = await handle.readFile();
      verifyMailBlob(bytes, hash);
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async persist(policy: Policy, input: InboundMail, authorize: () => Promise<void>): Promise<void> {
    const { repo } = this.options;
    if (!sameScope(input.scope, policy.scope) || input.targetId !== policy.targetId)
      throw new DomainError("mail_scope_mismatch");
    let stored = await repo.getDocument<StoredInboundMail>(policy.scope, "mail-message", input.id);
    if (stored) {
      if (
        stored.data.original?.sha256 !== input.original?.sha256 ||
        stored.data.state !== input.state ||
        stored.data.declaredBytes !== input.declaredBytes
      )
        throw new DomainError("mail_uid_content_conflict", undefined, 409);
      if (stored.data.importState === "complete") return;
    } else {
      if (input.original) await this.saveBlob(input.original.content, input.original.sha256);
      for (const attachment of input.attachments) await this.saveBlob(attachment.content, attachment.sha256);
      const { original, attachments, ...fields } = input;
      const data: StoredInboundMail = {
        ...fields,
        original: original ? { sha256: original.sha256, bytes: original.bytes } : undefined,
        attachments: attachments.map(({ content: _content, ...a }) => a),
        policyId: policy.id,
        policyConfigSha256: policy.targetConfigSha256,
        importState: "pending",
        channel: { kind: policy.kind, budgetLimitUsdMicros: policy.budgetLimitUsdMicros },
      };
      await authorize();
      try {
        stored = await repo.putDocument(policy.scope, "mail-message", input.id, data, { expectedRevision: 0 });
      } catch (error) {
        stored = await repo.getDocument<StoredInboundMail>(policy.scope, "mail-message", input.id);
        if (!stored) throw error;
        return this.persist(policy, input, authorize);
      }
    }
    const mail = stored!.data;
    await authorize();
    const received =
      mail.state === "received"
        ? await new Channels(repo).receive(policy.scope, {
            provider: "email",
            accountId: policy.targetId,
            eventId: mail.id,
            senderId: mail.from || "unverified-email-sender",
            content: [
              `Externer E-Mail-Eingang ${mail.id}. Absender unverifiziert; keine Freigabe.`,
              mail.subject ?? "(ohne Betreff)",
              mail.text ?? "(Kein Textteil; Original und Anhänge in der Inbox.)",
            ]
              .join("\n")
              .slice(0, 20000),
            authenticated: true,
            kind: mail.channel.kind,
            budgetLimitUsdMicros: mail.channel.budgetLimitUsdMicros,
          })
        : undefined;
    await authorize();
    await repo.putDocument(
      policy.scope,
      "mail-message",
      mail.id,
      json({ ...mail, importState: "complete", ...(received ? { orderId: received.orderId } : {}) }),
      { expectedRevision: stored!.revision },
    );
  }
  async messages(companyId: string, ceoId: string) {
    await this.ceo(companyId, ceoId);
    return (await this.options.repo.listCompanyDocuments<StoredInboundMail>(companyId, "mail-message"))
      .sort((a, b) => b.data.receivedAt.localeCompare(a.data.receivedAt))
      .slice(0, 100)
      .map((d) => {
        const { text: _text, html: _html, ...data } = d.data;
        return { ...data, revision: d.revision };
      });
  }
  async message(companyId: string, ceoId: string, id: string) {
    await this.ceo(companyId, ceoId);
    hashSchema.parse(id);
    const found = (await this.options.repo.listCompanyDocuments<StoredInboundMail>(companyId, "mail-message")).find(
      (m) => m.id === id,
    );
    if (!found) throw new DomainError("mail_not_found", undefined, 404);
    return { ...found.data, revision: found.revision };
  }
  async blob(companyId: string, ceoId: string, id: string, hash: string) {
    const mail = await this.message(companyId, ceoId, id);
    if (mail.original?.sha256 !== hash && !mail.attachments.some((a) => a.sha256 === hash))
      throw new DomainError("mail_blob_denied", undefined, 403);
    return this.readBlob(hash);
  }
  async finance(companyId: string, ceoId: string, id: string, input: unknown) {
    const mail = await this.message(companyId, ceoId, id),
      parsed = mailFinanceImportSchema.parse(input),
      attachment = mail.attachments.find((a) => a.sha256 === parsed.attachmentSha256);
    if (!mail.orderId || mail.state !== "received" || mail.importState !== "complete" || !attachment)
      throw new DomainError("mail_finance_source_missing");
    const order = await this.options.repo.getOrder(mail.scope, mail.orderId);
    if (order.kind !== "finance") throw new DomainError("workflow_kind_mismatch");
    const mediaType = z.enum(["application/pdf", "image/png", "image/jpeg"]).parse(attachment.contentType),
      bytes = await this.readBlob(attachment.sha256);
    const source = `mail:${mail.id}:attachment:${attachment.sha256}`;
    const result = await new FinanceWorkflow(this.options.repo, this.options.directory).ingest(
      mail.scope,
      mail.orderId,
      {
        originalSha256: attachment.sha256,
        originalBase64: bytes.toString("base64"),
        mediaType,
        invoice: { ...parsed.invoice, source },
        voucherDate: parsed.voucherDate,
      },
    );
    const provenanceId = sha256([mail.id, attachment.sha256, result.voucherId]);
    const prior = await this.options.repo.getDocument(mail.scope, "mail-finance-source", provenanceId);
    if (!prior)
      await this.options.repo.putDocument(
        mail.scope,
        "mail-finance-source",
        provenanceId,
        json({
          mailId: mail.id,
          originalSha256: mail.original?.sha256,
          attachmentSha256: attachment.sha256,
          voucherId: result.voucherId,
          orderId: mail.orderId,
          invoice: parsed.invoice,
          recordedBy: ceoId,
        }),
        { immutable: true },
      );
    return { ...result, source };
  }
}
