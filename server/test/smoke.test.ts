import { describe, expect, it } from "vitest";

describe("backend test baseline", () => {
  it("runs with node test environment", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });
});
