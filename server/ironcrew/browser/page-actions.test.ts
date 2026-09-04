import { describe, it, expect } from "vitest";
import {
  classifyAction,
  isPageAction,
  PAGE_ACTIONS,
  PAGE_ACTION_RISK,
  requiresApproval,
  toolKeyFor,
} from "./page-actions.ts";

describe("classification", () => {
  it("calls observation read", () => {
    for (const action of ["navigate", "readText", "screenshot"]) {
      expect(classifyAction(action)).toBe("read");
    }
  });

  it("calls page-local changes interact", () => {
    for (const action of ["click", "type", "select"]) {
      expect(classifyAction(action)).toBe("interact");
    }
  });

  it("calls anything that reaches outside external", () => {
    for (const action of ["submit", "download", "upload"]) {
      expect(classifyAction(action)).toBe("external");
    }
  });

  it("treats an action it has never heard of as the worst case", () => {
    // A caller that invented an action is exactly where guessing "probably
    // fine" is wrong.
    expect(classifyAction("purchaseEverything")).toBe("external");
    expect(classifyAction("")).toBe("external");
  });

  it("classifies every declared action", () => {
    for (const action of PAGE_ACTIONS) {
      expect(PAGE_ACTION_RISK[action]).toBeTruthy();
    }
  });

  it("recognises its own vocabulary", () => {
    expect(isPageAction("click")).toBe(true);
    expect(isPageAction("teleport")).toBe(false);
    expect(isPageAction(null)).toBe(false);
  });
});

describe("approval", () => {
  it("gates external actions and nothing else", () => {
    expect(requiresApproval("submit")).toBe(true);
    expect(requiresApproval("upload")).toBe(true);
    expect(requiresApproval("click")).toBe(false);
    expect(requiresApproval("readText")).toBe(false);
  });

  it("gates a submit even though most forms are harmless", () => {
    // This module cannot tell a search box from a checkout — both are a form
    // and a button — so it assumes the one that costs money.
    expect(requiresApproval("submit")).toBe(true);
  });

  it("honours a waiver, because that is a decision someone wrote down", () => {
    expect(requiresApproval("submit", { waived: true })).toBe(false);
  });

  it("ignores a waiver on something that was never gated", () => {
    expect(requiresApproval("readText", { waived: true })).toBe(false);
  });

  it("gates an unknown action even without a waiver being possible", () => {
    expect(requiresApproval("nieGehört")).toBe(true);
  });
});

describe("tool keys", () => {
  it("maps an action to the registry key that gates it", () => {
    expect(toolKeyFor("readText")).toBe("browser.read");
    expect(toolKeyFor("click")).toBe("browser.interact");
    expect(toolKeyFor("submit")).toBe("browser.external");
    expect(toolKeyFor("erfunden")).toBe("browser.external");
  });
});
