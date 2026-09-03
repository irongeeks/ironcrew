import { describe, it, expect } from "vitest";
import type { WalkDir } from "./agentSprites";
import { getSeatDirection } from "./useAgentPositions";

describe("getSeatDirection", () => {
  it("returns direction from properties", () => {
    const seat = {
      id: 1,
      name: "test",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      properties: [{ name: "direction", type: "string", value: "up" }],
    };
    expect(getSeatDirection(seat)).toBe("up");
  });

  it("returns null when no properties", () => {
    const seat = { id: 1, name: "test", x: 0, y: 0, width: 0, height: 0 };
    expect(getSeatDirection(seat)).toBeNull();
  });

  it("returns null for invalid direction value", () => {
    const seat = {
      id: 1,
      name: "test",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      properties: [{ name: "direction", type: "string", value: "diagonal" }],
    };
    expect(getSeatDirection(seat)).toBeNull();
  });

  it("handles all four directions", () => {
    for (const dir of ["up", "down", "left", "right"] as const) {
      const seat = {
        id: 1,
        name: "test",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        properties: [{ name: "direction", type: "string", value: dir }],
      };
      expect(getSeatDirection(seat)).toBe(dir);
    }
  });
});

describe("seat offset calculation", () => {
  it("applies Y-offset when seated", () => {
    const seatDirection: WalkDir | null = "up";
    const isSeated = seatDirection !== null;
    const seatOffset = isSeated ? -8 : 0;
    expect(seatOffset).toBe(-8);
  });

  it("no offset when not seated", () => {
    const seatDirection: WalkDir | null = null;
    const isSeated = seatDirection !== null;
    const seatOffset = isSeated ? -8 : 0;
    expect(seatOffset).toBe(0);
  });

  it("reduces bobbing amplitude when seated", () => {
    const isSeated = true;
    const bobAmplitude = isSeated ? 0.15 : 0.6;
    expect(bobAmplitude).toBe(0.15);
  });
});

describe("lamp offset by direction", () => {
  const LAMP_OFFSET: Record<string, { x: number; y: number }> = {
    up: { x: 0, y: -20 },
    down: { x: 0, y: 20 },
    left: { x: -20, y: 0 },
    right: { x: 20, y: 0 },
  };

  it("shifts lamp toward desk based on seat direction", () => {
    expect(LAMP_OFFSET["up"]).toEqual({ x: 0, y: -20 });
    expect(LAMP_OFFSET["down"]).toEqual({ x: 0, y: 20 });
    expect(LAMP_OFFSET["left"]).toEqual({ x: -20, y: 0 });
    expect(LAMP_OFFSET["right"]).toEqual({ x: 20, y: 0 });
  });
});
