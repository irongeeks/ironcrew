import { describe, it, expect } from "vitest";
import { escapeLikePattern } from "./graph-runner.ts";

describe("escapeLikePattern", () => {
  it("escapes % characters", () => {
    expect(escapeLikePattern("phase_100%")).toBe("phase\\_100\\%");
  });
  it("escapes _ characters", () => {
    expect(escapeLikePattern("my_phase")).toBe("my\\_phase");
  });
  it("passes through safe strings unchanged", () => {
    expect(escapeLikePattern("concept")).toBe("concept");
  });
  it("escapes backslashes", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});
