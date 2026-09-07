import express, { type Express, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { scopeSchema, orderKindSchema, microsSchema } from "../../packages/contracts/src/index.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { Channels } from "../../packages/domain/workflows/automation.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { verifyDiscordInbound, verifyTelegramInbound } from "../../packages/integrations/src/channels.ts";
import { ProtonPassResolver, secretRefSchema, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";

const common = {
  id: z.uuid(),
  enabled: z.boolean().default(false),
  scope: scopeSchema,
  accountId: z.string().min(1).max(200),
  kind: orderKindSchema.default("research"),
  budgetLimitUsdMicros: microsSchema.default("0"),
};
export const channelConfigSchema = z
  .object({
    version: z.literal(1),
    proton: z
      .object({ executable: z.string().min(1), sessionDirectory: z.string().optional() })
      .strict()
      .optional(),
    channels: z
      .array(
        z.discriminatedUnion("provider", [
          z
            .object({
              ...common,
              provider: z.literal("telegram"),
              secretRef: secretRefSchema,
              conversationIds: z.array(z.string().min(1)).min(1).max(100),
            })
            .strict(),
          z
            .object({
              ...common,
              provider: z.literal("discord"),
              publicKeyHex: z.string().regex(/^[a-fA-F0-9]{64}$/),
              conversationIds: z.array(z.string().min(1)).min(1).max(100),
            })
            .strict(),
          z.object({ ...common, provider: z.literal("email"), secretRef: secretRefSchema }).strict(),
        ]),
      )
      .max(100),
  })
  .strict()
  .superRefine((config, context) => {
    if (new Set(config.channels.map((channel) => channel.id)).size !== config.channels.length)
      context.addIssue({ code: "custom", message: "Duplicate channel ID" });
    // One provider account has exactly one scope, so reusing an account cannot leak events into another area.
    const accounts = config.channels.map((channel) => `${channel.provider}:${channel.accountId}`);
    if (new Set(accounts).size !== accounts.length)
      context.addIssue({ code: "custom", message: "Duplicate provider account" });
  });
export type ChannelConfiguration = z.infer<typeof channelConfigSchema>;
export async function readChannelConfiguration(directory: string, repo?: Repository): Promise<ChannelConfiguration> {
  try {
    if (repo) {
      const setup = await repo.setupState();
      if (setup) {
        const stored = await repo.getDocument(
          { companyId: setup.company.id, areaId: setup.areas[0]!.id },
          "channel-configuration",
          setup.company.id,
        );
        if (stored) return channelConfigSchema.parse(stored.data);
      }
    }
    return channelConfigSchema.parse(JSON.parse(await readFile(path.join(directory, "channel-config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, channels: [] };
    throw new DomainError("channel_configuration_invalid", "Channel configuration is invalid", 503);
  }
}
function resolver(config: ChannelConfiguration): SecretResolver {
  if (!config.proton) throw new DomainError("channel_secret_unconfigured", "Proton Pass is not configured", 503);
  return new ProtonPassResolver({
    executable: config.proton.executable,
    environment: {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PATH: path.dirname(config.proton.executable),
      ...(config.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton.sessionDirectory } : {}),
    },
  });
}
const emailSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    sender: z.email(),
    subject: z.string().min(1).max(500),
    text: z.string().min(1).max(19000),
  })
  .strict();
/** The authenticated mail bridge supplies an envelope, never an IronCrew identity or approval. */
function verifyEmail(body: Buffer, req: Request, secret: string) {
  const timestamp = req.get("X-IronCrew-Timestamp") ?? "",
    signature = req.get("X-IronCrew-Signature") ?? "";
  if (
    secret.length < 32 ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 ||
    !/^[a-fA-F0-9]{64}$/.test(signature)
  )
    throw new IntegrationError("auth", "Mail transport authentication failed");
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new IntegrationError("auth", "Mail transport authentication failed");
  return emailSchema.parse(JSON.parse(body.toString("utf8")));
}
function respondError(res: Response, error: unknown) {
  const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
  const code =
    error instanceof DomainError
      ? error.code
      : error instanceof IntegrationError
        ? error.code
        : invalid
          ? "validation"
          : "channel_unavailable";
  const status =
    error instanceof DomainError
      ? error.status
      : error instanceof IntegrationError
        ? error.code === "auth"
          ? 401
          : 400
        : invalid
          ? 400
          : 500;
  // No provider bodies, tokens, challenge values or filesystem paths in responses.
  res.status(status).json({ error: code });
}
/** Register BEFORE express.json() and CEO session/CSRF middleware. Only these paths bypass CEO auth. */
export function registerChannelRoutes(
  app: Express,
  options: {
    repo: Repository;
    directory: string;
    /** Trusted in-process dependency, useful for testing the Proton CLI adapter without a live account. */
    secrets?: SecretResolver;
    /** Share the Control maintenance barrier; throw while a backup/restore owns the write lock. */
    assertWritable?: () => Promise<void> | void;
    /** Counts the actual handler lifetime even after its HTTP client disconnects. */
    beginWrite?: () => () => void;
  },
) {
  const channels = new Channels(options.repo);
  app.post(
    "/api/v1/channel-webhooks/:provider/:id",
    express.raw({ type: "application/json", limit: "1mb", inflate: false }),
    async (req, res) => {
      let release: (() => void) | undefined;
      try {
        release = options.beginWrite?.();
        if (!Buffer.isBuffer(req.body))
          throw new DomainError("raw_webhook_body_required", "Raw JSON body required", 400);
        const config = await readChannelConfiguration(options.directory, options.repo);
        const channel = config.channels.find(
          (item) => item.id === req.params.id && item.provider === req.params.provider && item.enabled,
        );
        if (!channel) throw new DomainError("channel_not_found", "Channel not configured", 404);
        const identity = await options.repo.getIdentity();
        if (!identity || identity.companyId !== channel.scope.companyId)
          throw new DomainError("channel_scope_invalid", "Invalid scope", 403);
        const assertCurrent = async () => {
          const latest = await readChannelConfiguration(options.directory, options.repo);
          const active = latest.channels.find(
            (item) => item.id === channel.id && item.provider === channel.provider && item.enabled,
          );
          if (
            !active ||
            sha256({ channel: active, proton: latest.proton }) !== sha256({ channel, proton: config.proton })
          )
            throw new DomainError("channel_configuration_changed", undefined, 409);
        };
        let eventId: string, senderId: string, content: string;
        if (channel.provider === "email") {
          const secret = await (options.secrets ?? resolver(config)).resolve(
            channel.secretRef,
            `Verify email transport ${channel.id}`,
          );
          const event = verifyEmail(req.body, req, secret);
          eventId = event.eventId;
          senderId = event.sender;
          content = `${event.subject}\n\n${event.text}`;
        } else {
          const event =
            channel.provider === "telegram"
              ? verifyTelegramInbound(
                  req.body,
                  req.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
                  await (options.secrets ?? resolver(config)).resolve(
                    channel.secretRef,
                    `Verify Telegram webhook ${channel.id}`,
                  ),
                )
              : verifyDiscordInbound(
                  req.body,
                  req.get("X-Signature-Ed25519") ?? "",
                  req.get("X-Signature-Timestamp") ?? "",
                  channel.publicKeyHex,
                );
          if ("ping" in event) {
            res.json({ type: 1 });
            return;
          }
          if (!channel.conversationIds.includes(event.conversationId))
            throw new DomainError("channel_conversation_denied", "Conversation is not configured", 403);
          await options.assertWritable?.();
          await assertCurrent();
          // Only exact dedicated bind commands can consume the one-use CEO web challenge.
          const binding =
            channel.provider === "telegram"
              ? /^\/ironcrew_bind(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{32})$/.exec(event.text.trim())
              : /^ironcrew-bind\ntoken: ([A-Za-z0-9_-]{32})$/.exec(event.text.trim());
          if (binding) {
            await channels.bind(channel.scope, channel.provider, binding[1]!, channel.accountId, event.senderId, true);
            res.json(
              channel.provider === "discord"
                ? { type: 4, data: { content: "Identität verknüpft.", flags: 64 } }
                : { accepted: true, bound: true },
            );
            return;
          }
          eventId = event.externalId;
          senderId = event.senderId;
          content = event.text;
        }
        await options.assertWritable?.();
        await assertCurrent();
        const result = await channels.receive(channel.scope, {
          provider: channel.provider,
          accountId: channel.accountId,
          eventId,
          senderId,
          content,
          authenticated: true,
          kind: channel.kind,
          budgetLimitUsdMicros: channel.budgetLimitUsdMicros,
        });
        // Interaction responses are ephemeral and never reflect untrusted incoming text.
        res.json(
          channel.provider === "discord"
            ? {
                type: 4,
                data: {
                  content: result.duplicate ? "Auftrag bereits in der Inbox." : "Auftrag in der Inbox eingegangen.",
                  flags: 64,
                },
              }
            : { accepted: true, duplicate: result.duplicate },
        );
      } catch (error) {
        respondError(res, error);
      } finally {
        release?.();
      }
    },
  );
}
