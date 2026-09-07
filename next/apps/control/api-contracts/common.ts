import { z } from "zod";
import { scopeSchema } from "../../../packages/contracts/src/index.ts";
export const id = z.uuid();
export const date = z.iso.datetime();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const int = z.number().int().nonnegative();
export const revision = z.number().int().positive();
export const text = z.string();
export const json = z
  .json()
  .describe(
    "JSON value whose shape is owned by the selected tool, event type or setup step; not an untyped response envelope.",
  );
export const object = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
export const list = <T extends z.ZodType>(item: T) => object({ items: z.array(item), nextCursor: text.nullable() });
export const document = <T extends z.ZodType>(data: T) =>
  object({ id: text, scope: scopeSchema, kind: text, revision, data });
export const revised = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.extend({ revision });
export const error = object({ code: text, messageKey: text, requestId: id, retryable: z.literal(false) });
export const outcome = object({
  state: z.enum([
    "proposed",
    "authorized",
    "dispatched",
    "running",
    "succeeded",
    "failed",
    "effect_unknown",
    "denied",
    "expired",
    "approval",
  ]),
  id,
  data: json.optional(),
});
export const pendingAction = object({
  id,
  toolId: text,
  status: text,
  mandateId: id,
  mandateVersion: revision,
  targetId: id,
  args: json,
  revision,
  artifactVersionId: id.optional(),
});
