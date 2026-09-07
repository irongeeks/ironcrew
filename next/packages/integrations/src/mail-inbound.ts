import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { z } from "zod";
import type { IntegrationScope } from "./service.ts";
import { IntegrationError } from "./transport.ts";

export const mailCursorSchema = z
  .object({ uidValidity: z.string().regex(/^[1-9][0-9]*$/), lastUid: z.number().int().min(0).max(4294967295) })
  .strict();
export type MailCursor = z.infer<typeof mailCursorSchema>;
export const mailPollOptionsSchema = z
  .object({
    cursor: mailCursorSchema.optional(),
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
export type MailPollOptions = z.input<typeof mailPollOptionsSchema>;
export interface InboundMail {
  /** Includes administrative account identity, scope, mailbox, UIDVALIDITY and UID; never From or Message-ID. */
  id: string;
  targetId: string;
  scope: IntegrationScope;
  mailbox: string;
  uidValidity: string;
  uid: number;
  receivedAt: string;
  identityVerified: false;
  authority: "untrusted_external_content";
  state: "received" | "rejected";
  rejection?: "message_too_large" | "mime_invalid" | "attachment_limit";
  declaredBytes: number;
  original?: { sha256: string; content: Buffer; bytes: number };
  subject?: string;
  text?: string;
  /** Untrusted HTML is retained as evidence only, never directly rendered. */
  html?: string;
  from?: string;
  to?: string;
  cc?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: Array<{
    sha256: string;
    bytes: number;
    filename: string;
    contentType: string;
    contentId?: string;
    inline: boolean;
    content: Buffer;
  }>;
}
export interface MailPollResult {
  cursor: MailCursor;
  received: number;
  rejected: number;
  uidValidityChanged: boolean;
  more: boolean;
}
const digest = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
export function inboundMailId(
  targetId: string,
  scope: IntegrationScope,
  mailbox: string,
  uidValidity: string,
  uid: number,
): string {
  return digest(
    JSON.stringify([
      targetId,
      scope.companyId,
      scope.areaId,
      scope.customerId ?? null,
      scope.projectId ?? null,
      mailbox,
      uidValidity,
      uid,
    ]),
  );
}
export async function parseInboundMail(
  base: Omit<InboundMail, "attachments" | "state">,
  source: Buffer,
): Promise<InboundMail> {
  const original = { sha256: digest(source), content: source, bytes: source.length };
  try {
    const parsed = await simpleParser(source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      maxHtmlLengthToParse: 1024 * 1024,
    });
    if (parsed.attachments.length > 50)
      return { ...base, original, state: "rejected", rejection: "attachment_limit", attachments: [] };
    const address = (value: typeof parsed.to) =>
      Array.isArray(value) ? value.map((v) => v.text).join(", ") : value?.text;
    return {
      ...base,
      original,
      state: "received",
      subject: parsed.subject,
      text: parsed.text,
      html: typeof parsed.html === "string" ? parsed.html : undefined,
      from: parsed.from?.text,
      to: address(parsed.to),
      cc: address(parsed.cc),
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: typeof parsed.references === "string" ? [parsed.references] : parsed.references,
      attachments: parsed.attachments.map((a, index) => ({
        sha256: digest(a.content),
        bytes: a.content.length,
        // Only display metadata. Never use provider-controlled names as filesystem paths.
        filename: [...(a.filename ?? `attachment-${index + 1}`)]
          .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c))
          .join("")
          .slice(0, 300),
        contentType: a.contentType,
        contentId: a.contentId,
        inline: a.contentDisposition === "inline",
        content: a.content,
      })),
    };
  } catch {
    return { ...base, original, state: "rejected", rejection: "mime_invalid", attachments: [] };
  }
}
/** Verify a persisted object's bytes before exposing them to a consumer. */
export function verifyMailBlob(content: Buffer, sha256: string): void {
  if (digest(content) !== sha256)
    throw new IntegrationError("conflict", "Gespeicherter E-Mail-Beleg stimmt nicht mit seinem Hash überein.");
}
