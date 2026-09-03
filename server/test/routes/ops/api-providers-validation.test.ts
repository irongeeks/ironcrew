import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

/**
 * Tests for the ApiProviderPayloadSchema validation used in api-providers.ts.
 * Recreates the schema here to test in isolation without needing to spin up Express.
 */
const ApiProviderPayloadSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    type: z.string().optional(),
    base_url: z.string().url().max(500).optional(),
    api_key: z.string().max(500).optional(),
    enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  })
  .strict();

describe("ApiProviderPayloadSchema validation", () => {
  it("accepts a valid full payload", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      name: "My Provider",
      type: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test-123",
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = ApiProviderPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("accepts partial payloads", () => {
    const result = ApiProviderPayloadSchema.safeParse({ name: "Test" });
    expect(result.success).toBe(true);
  });

  it("accepts enabled as 0 or 1", () => {
    expect(ApiProviderPayloadSchema.safeParse({ enabled: 0 }).success).toBe(true);
    expect(ApiProviderPayloadSchema.safeParse({ enabled: 1 }).success).toBe(true);
    expect(ApiProviderPayloadSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(ApiProviderPayloadSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("rejects excessively long name (> 200 chars)", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      name: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name string", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL for base_url", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      base_url: "not-a-valid-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects excessively long base_url (> 500 chars)", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      base_url: "https://example.com/" + "a".repeat(500),
    });
    expect(result.success).toBe(false);
  });

  it("rejects excessively long api_key (> 500 chars)", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      api_key: "k".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown fields (strict mode)", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      name: "Test",
      malicious_field: "injected",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean/non-0-1 enabled values", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      enabled: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects enabled as string", () => {
    const result = ApiProviderPayloadSchema.safeParse({
      enabled: "true",
    });
    expect(result.success).toBe(false);
  });
});
