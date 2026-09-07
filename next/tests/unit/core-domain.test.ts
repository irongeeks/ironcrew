import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  sha256,
  sameScope,
  assertTransition,
  parametersAllowed,
} from "../../packages/domain/src/index.ts";
import { microsSchema, scopeSchema, orderPatchSchema } from "../../packages/contracts/src/index.ts";
describe("domain validation", () => {
  it("hashes canonical JSON without losing semantic distinctions", () => {
    expect(sha256({ a: 1, b: 2 })).toBe(sha256({ b: 2, a: 1 }));
    expect(sha256({ a: 1 })).not.toBe(sha256({ a: "1" }));
    expect(() => canonicalJson({ cost: NaN })).toThrow();
    expect(() => canonicalJson(12n)).toThrow();
  });
  it("rejects floating, negative and over-range costs at JSON boundary", () => {
    for (const value of ["1.5", "-1", "01", "9223372036854775808", 4])
      expect(microsSchema.safeParse(value).success).toBe(false);
    expect(microsSchema.parse("9007199254740993")).toBe("9007199254740993");
  });
  it("rejects guessed scope IDs and unknown patch fields", () => {
    expect(scopeSchema.safeParse({ companyId: "x", areaId: "y" }).success).toBe(false);
    expect(orderPatchSchema.safeParse({ leadEmployeeId: "x" }).success).toBe(false);
    expect(sameScope({ companyId: "a", areaId: "b" }, { companyId: "a", areaId: "c" })).toBe(false);
  });
  it("resumes only the saved state and keeps final orders final", () => {
    expect(() => assertTransition("paused", "running", "running")).not.toThrow();
    expect(() => assertTransition("paused", "completed", "running")).toThrow();
    expect(() => assertTransition("completed", "running")).toThrow();
    expect(parametersAllowed({ recipient: "a" }, { recipient: "b" })).toBe(false);
  });
});
