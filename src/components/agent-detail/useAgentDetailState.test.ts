import { describe, expect, it } from "vitest";
import { useAgentDetailState } from "./useAgentDetailState";

describe("useAgentDetailState", () => {
  it("is exported as a function", () => {
    expect(typeof useAgentDetailState).toBe("function");
  });
});
