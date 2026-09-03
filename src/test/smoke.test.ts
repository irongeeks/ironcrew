import { describe, expect, it } from "vitest";

describe("frontend test baseline", () => {
  it("executes with JSDOM environment", () => {
    expect(typeof document).toBe("object");
    expect(document.createElement("div").tagName).toBe("DIV");
  });
});
