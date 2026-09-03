import { describe, expect, it } from "vitest";
import { useOfficePackResolution } from "./useOfficePackResolution";

describe("useOfficePackResolution", () => {
  it("is exported as a function", () => {
    expect(typeof useOfficePackResolution).toBe("function");
  });
});
