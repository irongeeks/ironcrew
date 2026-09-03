import { describe, it, expect } from "vitest";
import { buildCollisionGrid } from "./pathfinding";
import type { TiledMap } from "./TiledRenderer";

function makeMap(layerName: string, tileValue: number): TiledMap {
  return {
    width: 2,
    height: 1,
    tilewidth: 32,
    tileheight: 32,
    tilesets: [],
    layers: [
      { name: "Floor", type: "tilelayer", data: [1, 1], visible: true, opacity: 1 },
      { name: layerName, type: "tilelayer", data: [tileValue, 0], visible: true, opacity: 1 },
    ],
  };
}

describe("buildCollisionGrid", () => {
  it("treats walls7 (lowercase) as an obstacle", () => {
    const grid = buildCollisionGrid(makeMap("walls7", 999));
    expect(grid[0]).toBe(0); // blocked by walls7 tile
    expect(grid[1]).toBe(1); // no obstacle on second tile
  });

  it("treats Walls7 (old capitalization) as NOT an obstacle", () => {
    // After the fix, "Walls7" is removed from the list — this verifies the old name no longer blocks
    const grid = buildCollisionGrid(makeMap("Walls7", 999));
    // "Walls7" is not in OBSTACLE_LAYERS after the fix, so tile should be walkable
    expect(grid[0]).toBe(1);
  });
});
