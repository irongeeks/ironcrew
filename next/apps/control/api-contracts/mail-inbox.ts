import { z } from "zod";
import { scopeSchema, orderKindSchema, microsSchema } from "../../../packages/contracts/src/index.ts";
import { mailCursorSchema } from "../../../packages/integrations/src/mail-inbound.ts";
import { mailInboxPolicySchema } from "../mail-inbox-service.ts";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().max(10 * 1024 * 1024);
export const mailInboxPolicyResultSchema = mailInboxPolicySchema
  .safeExtend({
    id: z.uuid(),
    scope: scopeSchema,
    approvedBy: z.uuid(),
    generation: z.string().nullable(),
    nextPollAt: z.iso.datetime(),
    lastErrorCode: z.string().optional(),
    revision: z.number().int().positive(),
  })
  .strict();
const blob = z.object({ sha256: hash, bytes: z.number().int().nonnegative() }).strict();
const attachment = blob
  .extend({
    filename: z.string().max(300),
    contentType: z.string(),
    contentId: z.string().optional(),
    inline: z.boolean(),
  })
  .strict();
export const storedMailMessageSchema = z
  .object({
    id: hash,
    targetId: z.uuid(),
    scope: scopeSchema,
    mailbox: z.string(),
    uidValidity: z.string().regex(/^[1-9][0-9]*$/),
    uid: z.number().int().positive(),
    receivedAt: z.iso.datetime(),
    identityVerified: z.literal(false),
    authority: z.literal("untrusted_external_content"),
    state: z.enum(["received", "rejected"]),
    rejection: z.enum(["message_too_large", "mime_invalid", "attachment_limit"]).optional(),
    declaredBytes: z.number().int().nonnegative(),
    original: blob.optional(),
    subject: text.optional(),
    text: text.optional(),
    html: text.optional(),
    from: text.optional(),
    to: text.optional(),
    cc: text.optional(),
    messageId: text.optional(),
    inReplyTo: text.optional(),
    references: z.array(text).optional(),
    attachments: z.array(attachment).max(50),
    orderId: z.uuid().optional(),
    policyId: z.uuid(),
    policyConfigSha256: hash,
    importState: z.enum(["pending", "complete"]),
    channel: z.object({ kind: orderKindSchema, budgetLimitUsdMicros: microsSchema }).strict(),
    revision: z.number().int().positive(),
  })
  .strict();
export const mailInboxStatusSchema = z
  .object({
    policies: z.array(mailInboxPolicyResultSchema),
    targets: z.array(
      z
        .object({
          id: z.uuid(),
          scope: scopeSchema,
          host: z.string(),
          username: z.string(),
          mailbox: z.string(),
          targetConfigSha256: hash,
        })
        .strict(),
    ),
    messages: z.array(storedMailMessageSchema.omit({ text: true, html: true })).max(100),
  })
  .strict();
export const mailPollResultSchema = z
  .object({
    cursor: mailCursorSchema,
    received: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    uidValidityChanged: z.boolean(),
    more: z.boolean(),
  })
  .strict();
export const mailFinanceImportResultSchema = z
  .object({ duplicate: z.boolean(), voucherId: z.uuid(), source: z.string().min(1) })
  .strict();
