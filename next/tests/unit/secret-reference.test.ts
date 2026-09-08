import { expect, it } from "vitest";
import { z } from "zod";
import { secretRefSchema } from "../../packages/integrations/src/secrets.ts";

const reference = { shareId: "-share", itemId: "item", field: "password" };

it.each(["proton-pass", "protonpass"])("normalizes the supported provider spelling %s", (provider) => {
  const input = { ...reference, provider };
  expect(secretRefSchema.parse(input)).toEqual({ ...reference, provider: "proton-pass" });
  expect(input.provider).toBe(provider);
});

it("retains strict provider, field and secret-value validation for the legacy alias", () => {
  const input = { ...reference, provider: "protonpass" };
  for (const invalid of [
    { ...input, provider: "PROTONPASS" },
    { ...input, provider: "other" },
    { ...input, shareId: "" },
    { ...input, itemId: "x".repeat(301) },
    { ...input, field: "x".repeat(201) },
    { ...input, value: "must-not-be-a-raw-secret" },
  ]) {
    expect(secretRefSchema.safeParse(invalid).success).toBe(false);
  }
});

it("exports both accepted input spellings and only the canonical output to JSON Schema", () => {
  expect(z.toJSONSchema(secretRefSchema, { io: "input" })).toMatchObject({
    properties: { provider: { type: "string", enum: ["proton-pass", "protonpass"] } },
  });
  expect(z.toJSONSchema(secretRefSchema, { io: "output" })).toMatchObject({
    properties: { provider: { type: "string", const: "proton-pass" } },
  });
});
