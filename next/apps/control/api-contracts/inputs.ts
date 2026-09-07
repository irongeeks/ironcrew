import { z } from "zod";
import { passwordSchema } from "../auth.ts";
import { setupSchema, scopeSchema, orderCreateSchema, microsSchema } from "../../../packages/contracts/src/index.ts";
import { reportSchema } from "../../../packages/domain/workflows/research.ts";
import { researchWatchCreateSchema } from "../../../packages/domain/workflows/research-watch.ts";
import { scheduleInputSchema } from "../../../packages/domain/workflows/automation.ts";
import { id, date, revision, text, object } from "./common.ts";
export const password = passwordSchema;
export const setup = z.object({
  token: text,
  companyName: setupSchema.shape.companyName,
  ceoName: setupSchema.shape.ceoName,
  password,
  timezone: setupSchema.shape.timezone,
  locale: z.enum(["de", "en"]).default("de"),
});
export const order = orderCreateSchema.extend({ scope: scopeSchema });
export const budget = z.object({
  limitUsdMicros: microsSchema,
  startsAt: date,
  endsAt: date,
  renewal: z.enum(["none", "fixed_duration"]).optional(),
});
export const report = reportSchema.omit({ orderId: true });
// The route replaces orderId before parsing, preserving all refinement checks.
export const watch = z
  .object({ ...researchWatchCreateSchema.shape })
  .omit({ orderId: true })
  .strict()
  .refine((v) => new Set(v.sources.map((s) => s.url)).size === v.sources.length, "Duplicate source URL");
// HTTP route strips mandateVersion/last*; the domain resolves the latest persisted mandate.
export const schedule = z
  .object({ ...scheduleInputSchema.shape })
  .omit({ mandateVersion: true, lastLocalSlot: true, lastSuccessfulAt: true })
  .extend({ maxActiveOrders: revision.max(3).default(3) });
export const delivery = z.object({
  artifactVersionId: id,
  targetId: id,
  nativeFormat: z.literal("google-doc").optional(),
  targetConfigSha256: text.regex(/^[a-f0-9]{64}$/).optional(),
  path: text.optional(),
  folderId: text.optional(),
  expectedRevision: text.optional(),
  expectedRemoteHead: text.nullable().optional(),
  expectedFileSha256: text.nullable().optional(),
  mandateId: id,
  mandateVersion: revision.default(1),
});
export { correctionInputSchema as correction } from "../../../packages/domain/workflows/finance-corrections.ts";
export const email = object({
  eventId: text.min(1).max(200),
  sender: z.email(),
  subject: text.min(1).max(500),
  text: text.min(1).max(19000),
});
export const telegram = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    date: z.number().int(),
    text: text.max(100000),
    from: z.object({ id: z.number().int(), is_bot: z.literal(false).optional() }),
    chat: z.object({ id: z.number().int() }),
  }),
});
export const discord = z.union([
  z.object({ type: z.literal(1) }),
  z
    .object({
      id: text.regex(/^\d+$/),
      type: z.literal(2),
      channel_id: text,
      user: z.object({ id: text }).optional(),
      member: z.object({ user: z.object({ id: text }) }).optional(),
      data: z.object({
        name: text,
        options: z.array(z.object({ name: text, value: z.union([text, z.number(), z.boolean()]) })).optional(),
      }),
    })
    .refine((v) => !!(v.member?.user.id ?? v.user?.id), "Sender required"),
]);
