import { describe, it, expect } from "vitest";
import { validatePack } from "../hooks/usePackValidator";
import type { PhaseDefinition } from "../types";

function makePhase(overrides: Partial<PhaseDefinition> & { id: string }): PhaseDefinition {
  return {
    department: "dev",
    guidance: `guidance/${overrides.id}.{lang}.md`,
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

describe("validatePack", () => {
  it("returns no errors for a valid linear pipeline", () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: "plan", outputs: [{ name: "strategy", type: "json", path: "out/s.json" }] }),
      makePhase({
        id: "execute",
        inputs: [{ name: "strategy", from: "plan.strategy" }],
        outputs: [{ name: "result", type: "markdown", path: "out/r.md" }],
      }),
    ];
    const errors = validatePack(phases);
    expect(errors).toEqual([]);
  });

  it("detects broken input reference (missing source phase)", () => {
    const phases: PhaseDefinition[] = [
      makePhase({
        id: "execute",
        inputs: [{ name: "data", from: "nonexistent.output" }],
      }),
    ];
    const errors = validatePack(phases);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("broken_ref");
    expect(errors[0].phaseId).toBe("execute");
  });

  it("detects broken input reference (missing output name)", () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: "plan", outputs: [{ name: "strategy", type: "json", path: "out/s.json" }] }),
      makePhase({
        id: "execute",
        inputs: [{ name: "data", from: "plan.wrong_output" }],
      }),
    ];
    const errors = validatePack(phases);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("broken_ref");
  });

  it("detects cycles", () => {
    const phases: PhaseDefinition[] = [
      makePhase({
        id: "a",
        inputs: [{ name: "x", from: "b.out" }],
        outputs: [{ name: "out", type: "json", path: "a.json" }],
      }),
      makePhase({
        id: "b",
        inputs: [{ name: "y", from: "a.out" }],
        outputs: [{ name: "out", type: "json", path: "b.json" }],
      }),
    ];
    const errors = validatePack(phases);
    expect(errors.some((e) => e.type === "cycle")).toBe(true);
  });

  it("detects orphan phases (disconnected from graph)", () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: "a", outputs: [{ name: "out", type: "json", path: "a.json" }] }),
      makePhase({
        id: "b",
        inputs: [{ name: "x", from: "a.out" }],
        outputs: [{ name: "out", type: "json", path: "b.json" }],
      }),
      makePhase({ id: "orphan", outputs: [{ name: "out", type: "json", path: "o.json" }] }),
    ];
    const errors = validatePack(phases);
    expect(errors.some((e) => e.type === "orphan" && e.phaseId === "orphan")).toBe(true);
  });

  it("detects duplicate phase IDs", () => {
    const phases: PhaseDefinition[] = [makePhase({ id: "plan" }), makePhase({ id: "plan" })];
    const errors = validatePack(phases);
    expect(errors.some((e) => e.type === "duplicate_id")).toBe(true);
  });

  it("a terminal phase with no outputs is fine", () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: "plan", outputs: [{ name: "out", type: "json", path: "p.json" }] }),
      makePhase({ id: "execute", inputs: [{ name: "x", from: "plan.out" }] }),
    ];
    const errors = validatePack(phases);
    expect(errors).toEqual([]);
  });
});
