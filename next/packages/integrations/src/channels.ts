import { createPublicKey, timingSafeEqual, verify, createHash } from "node:crypto";
import { z } from "zod";
import { IntegrationError } from "./transport.ts";

export interface VerifiedInboundEvent {
  provider: "telegram" | "discord";
  externalId: string;
  senderId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
  authenticity: "provider_verified";
}
const constantEqual = (a: string, b: string) => {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
};
/** Verify against the secret supplied during setWebhook. Identity-to-CEO binding is a separate persistent web challenge. */
export function verifyTelegramInbound(
  rawBody: Buffer,
  receivedSecret: string,
  expectedSecret: string,
): VerifiedInboundEvent {
  if (!expectedSecret || !constantEqual(receivedSecret, expectedSecret))
    throw new IntegrationError("auth", "Telegram-Webhook ist nicht authentifiziert.");
  if (rawBody.length > 1024 * 1024) throw new IntegrationError("response_limit", "Webhook ist zu groß.");
  const parsed = z
    .object({
      update_id: z.number().int(),
      message: z.object({
        message_id: z.number().int(),
        date: z.number().int(),
        text: z.string().max(100000),
        from: z.object({ id: z.number().int(), is_bot: z.boolean().optional() }),
        chat: z.object({ id: z.number().int() }),
      }),
    })
    .safeParse(parse(rawBody));
  if (!parsed.success || parsed.data.message.from.is_bot)
    throw new IntegrationError("validation", "Telegram-Ereignis wird nicht unterstützt.");
  const { update_id, message } = parsed.data;
  return {
    provider: "telegram",
    externalId: String(update_id),
    senderId: String(message.from.id),
    conversationId: String(message.chat.id),
    text: message.text,
    receivedAt: new Date(message.date * 1000).toISOString(),
    authenticity: "provider_verified",
  };
}
/** Discord interactions use Ed25519 over timestamp || raw body. Caller must persist/deduplicate externalId. */
export function verifyDiscordInbound(
  rawBody: Buffer,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
  now = Date.now(),
): VerifiedInboundEvent | { provider: "discord"; ping: true } {
  if (
    rawBody.length > 1024 * 1024 ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !/^[a-fA-F0-9]{128}$/.test(signatureHex) ||
    !/^[a-fA-F0-9]{64}$/.test(publicKeyHex)
  )
    throw new IntegrationError("auth", "Discord-Signatur oder Zeitfenster ist ungültig.");
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    if (!verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signatureHex, "hex")))
      throw new Error("signature");
  } catch {
    throw new IntegrationError("auth", "Discord-Signatur ist ungültig.");
  }
  const data = parse(rawBody);
  if (data && typeof data === "object" && "type" in data && data.type === 1) return { provider: "discord", ping: true };
  const parsed = z
    .object({
      id: z.string().regex(/^\d+$/),
      type: z.literal(2),
      channel_id: z.string(),
      user: z.object({ id: z.string() }).optional(),
      member: z.object({ user: z.object({ id: z.string() }) }).optional(),
      data: z.object({
        name: z.string(),
        options: z
          .array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }))
          .optional(),
      }),
    })
    .safeParse(data);
  if (!parsed.success) throw new IntegrationError("validation", "Discord-Interaktion wird nicht unterstützt.");
  const event = parsed.data;
  const senderId = event.member?.user.id ?? event.user?.id;
  if (!senderId) throw new IntegrationError("validation", "Discord-Absender fehlt.");
  return {
    provider: "discord",
    externalId: event.id,
    senderId,
    conversationId: event.channel_id,
    text: [event.data.name, ...(event.data.options ?? []).map((option) => `${option.name}: ${option.value}`)].join(
      "\n",
    ),
    receivedAt: new Date(now).toISOString(),
    authenticity: "provider_verified",
  };
}
function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new IntegrationError("validation", "Webhook enthält ungültiges JSON.");
  }
}
