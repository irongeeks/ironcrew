import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { parseBody, toErrorMessage } from "../../modules/routes/validation.ts";

describe("parseBody", () => {
  const schema = z.object({
    title: z.string(),
    priority: z.number().optional(),
  });

  it("returns parsed data for valid input", () => {
    const result = parseBody(schema, { title: "hello", priority: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("hello");
      expect(result.data.priority).toBe(1);
    }
  });

  it("returns error for invalid input", () => {
    const result = parseBody(schema, { priority: "not a number" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    }
  });

  it("handles null/undefined body", () => {
    const result = parseBody(schema, null);
    expect(result.success).toBe(false);
  });
});

describe("toErrorMessage", () => {
  it("extracts message from Error", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("converts string to message", () => {
    expect(toErrorMessage("oops")).toBe("oops");
  });

  it("converts unknown to string", () => {
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
  });
});
