import { describe, it, expect } from "vitest";
import { handleAutoRetry, handleHardFailure } from "../../../modules/workflow/orchestration/run-complete-failure.ts";

describe("run-complete-failure exports", () => {
  it("handleAutoRetry is a function", () => {
    expect(typeof handleAutoRetry).toBe("function");
  });

  it("handleHardFailure is a function", () => {
    expect(typeof handleHardFailure).toBe("function");
  });
});
