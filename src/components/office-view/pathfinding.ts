import type { TiledMap } from "./TiledRenderer";

/** Wall layers — impassable, but can be opened as virtual passages to connect isolated regions */
const WALL_LAYERS = [
  "Walls",
  "Walls2",
  "Walls3",
  "Walls4",
  "Walls5",
  "walls6",
  "walls7",
  "Wall_Outdoor",
  "WINDOWS_OUTDOOR",
  "Balkony",
  // old map (German)
  "Wände",
  "Kachelebene 2",
  "server",
];

/** Furniture/prop layers — impassable and must never be opened as passages */
const FURNITURE_LAYERS = [
  "Tables",
  "Tables2",
  "Chairs1",
  "Chairs2",
  "Chairs3",
  "Chairs4",
  "Props",
  "Props on Table",
  "Props on Table2",
  // old map (German)
  "Schreibtische",
];

/** Layer whose non-zero tiles define floor (walkable ground) — checked by precedence */
const FLOOR_LAYERS = ["Floor", "Kachelebene 1"];

/**
 * Build a walkability grid from the Tiled map data.
 * A cell is walkable when it has floor AND no obstacle tile.
 * Returns a Uint8Array where 1 = walkable, 0 = blocked.
 */
export function buildCollisionGrid(mapData: TiledMap): Uint8Array {
  const { width, height, layers } = mapData;
  const size = width * height;
  const grid = new Uint8Array(size); // 0 = blocked by default

  // Lookup layer data by name
  const layerData = new Map<string, number[]>();
  for (const layer of layers) {
    if (layer.type === "tilelayer" && layer.data) {
      layerData.set(layer.name, layer.data);
    }
  }

  const floor = FLOOR_LAYERS.map((n) => layerData.get(n)).find(Boolean);
  if (!floor) return grid;

  const wallLayerData = WALL_LAYERS.map((name) => layerData.get(name)).filter(Boolean) as number[][];
  const furnitureLayerData = FURNITURE_LAYERS.map((name) => layerData.get(name)).filter(Boolean) as number[][];
  // Door tiles override wall obstacles — a tile with a door is always walkable
  const doorLayer = layerData.get("Doors") as number[] | undefined;

  // wallOnlyBlocked: floor tile blocked by a wall but NOT by furniture — eligible to be opened as a passage
  const wallOnlyBlocked = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    if (floor[i] === 0) continue; // no floor → not walkable
    if (doorLayer && doorLayer[i] !== 0) {
      grid[i] = 1; // door tile → passable regardless of underlying wall
      continue;
    }
    let hasWall = false;
    for (const w of wallLayerData) {
      if (w[i] !== 0) {
        hasWall = true;
        break;
      }
    }
    let hasFurniture = false;
    for (const f of furnitureLayerData) {
      if (f[i] !== 0) {
        hasFurniture = true;
        break;
      }
    }
    if (!hasWall && !hasFurniture) {
      grid[i] = 1;
    } else if (hasWall && !hasFurniture) {
      wallOnlyBlocked[i] = 1; // candidate for virtual door opening
    }
  }

  // Post-process: connect any isolated walkable regions to the main component
  // by opening the shortest path through wall-only tiles (never furniture).
  connectIsolatedRegions(grid, width, height, wallOnlyBlocked);

  return grid;
}

/**
 * Find isolated walkable regions (>= MIN_SIZE tiles) that are disconnected from the
 * largest component and connect them by opening the shortest path through wall-only
 * blocked tiles. Furniture-blocked tiles are never opened.
 */
function connectIsolatedRegions(
  grid: Uint8Array,
  width: number,
  height: number,
  wallOnlyBlocked: Uint8Array,
  minSize = 3,
): void {
  const size = width * height;
  const dirs4: [number, number][] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];

  // BFS to label connected components
  const compId = new Int32Array(size).fill(-1);
  const comps: number[][] = [];

  for (let start = 0; start < size; start++) {
    if (grid[start] === 0 || compId[start] !== -1) continue;
    const c = comps.length;
    const queue: number[] = [start];
    compId[start] = c;
    let qi = 0;
    const tiles: number[] = [];
    while (qi < queue.length) {
      const cur = queue[qi++];
      tiles.push(cur);
      const cx = cur % width;
      const cy = (cur - cx) / width;
      for (const [dx, dy] of dirs4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        if (grid[ni] === 0 || compId[ni] !== -1) continue;
        compId[ni] = c;
        queue.push(ni);
      }
    }
    comps.push(tiles);
  }

  if (comps.length <= 1) return;

  // Sort largest first and rebuild compId
  comps.sort((a, b) => b.length - a.length);
  for (let c = 0; c < comps.length; c++) {
    for (const t of comps[c]) compId[t] = c;
  }

  const mainSet = new Set<number>(comps[0]);

  // For each isolated region large enough to matter, open a floor passage to the main region
  for (let c = 1; c < comps.length; c++) {
    if (comps[c].length < minSize) continue;

    const compSet = new Set<number>(comps[c]);
    const seen = new Uint8Array(size);
    const parent = new Int32Array(size).fill(-1);
    const queue: number[] = [];

    // Seed BFS from this component's tiles
    for (const t of comps[c]) {
      seen[t] = 1;
      queue.push(t);
    }

    let target = -1;
    let qi = 0;
    outer: while (qi < queue.length) {
      const cur = queue[qi++];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      for (const [dx, dy] of dirs4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        // Traverse walkable tiles OR wall-only-blocked tiles (never furniture-blocked)
        if (seen[ni] || (grid[ni] === 0 && !wallOnlyBlocked[ni])) continue;
        seen[ni] = 1;
        parent[ni] = cur;
        if (mainSet.has(ni)) {
          target = ni;
          break outer;
        }
        queue.push(ni);
      }
    }

    if (target === -1) continue; // Floor regions are physically separate — cannot connect

    // Trace the path back from target to the isolated component and open wall tiles
    let cur = parent[target]; // step back from the main-component tile
    while (cur !== -1 && !compSet.has(cur)) {
      if (grid[cur] === 0) {
        grid[cur] = 1; // open this wall tile as a passage
        mainSet.add(cur);
      }
      cur = parent[cur];
    }
    // Absorb the now-connected component into mainSet
    for (const t of comps[c]) mainSet.add(t);
  }
}

export interface PathPoint {
  x: number;
  y: number;
}

/**
 * A* pathfinding on a tile grid.
 * @param grid      Walkability grid (1 = walkable, 0 = blocked)
 * @param mapWidth  Grid width in tiles
 * @param mapHeight Grid height in tiles
 * @param start     Start tile {x, y}
 * @param end       End tile {x, y}
 * @returns Array of tile coordinates from start to end (inclusive), or empty if no path.
 *          The destination tile is always treated as walkable.
 */
export function findPath(
  grid: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  start: PathPoint,
  end: PathPoint,
): PathPoint[] {
  const sx = Math.max(0, Math.min(mapWidth - 1, Math.round(start.x)));
  const sy = Math.max(0, Math.min(mapHeight - 1, Math.round(start.y)));
  const ex = Math.max(0, Math.min(mapWidth - 1, Math.round(end.x)));
  const ey = Math.max(0, Math.min(mapHeight - 1, Math.round(end.y)));

  if (sx === ex && sy === ey) return [{ x: ex, y: ey }];

  const size = mapWidth * mapHeight;
  const endIdx = ey * mapWidth + ex;

  // Open set as a simple sorted array (sufficient for 50×30 grid)
  const gScore = new Float32Array(size).fill(Infinity);
  const fScore = new Float32Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const startIdx = sy * mapWidth + sx;
  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(sx, sy, ex, ey);

  // Binary heap for the open set
  const open: number[] = [startIdx];

  // 8-directional neighbors: dx, dy, cost
  const dirs: [number, number, number][] = [
    [0, -1, 1],
    [1, 0, 1],
    [0, 1, 1],
    [-1, 0, 1],
    [1, -1, 1.41],
    [1, 1, 1.41],
    [-1, 1, 1.41],
    [-1, -1, 1.41],
  ];

  while (open.length > 0) {
    // Find node with lowest fScore (for small grids, linear scan is fine)
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestI]]) bestI = i;
    }
    const current = open[bestI];
    open[bestI] = open[open.length - 1];
    open.pop();

    if (current === endIdx) return reconstructPath(cameFrom, current, mapWidth);
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % mapWidth;
    const cy = (current - cx) / mapWidth;

    for (const [dx, dy, cost] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= mapWidth || ny < 0 || ny >= mapHeight) continue;

      const nIdx = ny * mapWidth + nx;
      if (closed[nIdx]) continue;

      // Destination tile is always walkable; other tiles check the grid
      if (nIdx !== endIdx && grid[nIdx] === 0) continue;

      // For diagonal moves, check that both adjacent cardinal cells are walkable
      // to prevent cutting through wall corners
      if (dx !== 0 && dy !== 0) {
        const adj1 = cy * mapWidth + nx; // horizontal neighbor
        const adj2 = ny * mapWidth + cx; // vertical neighbor
        if (grid[adj1] === 0 || grid[adj2] === 0) continue;
      }

      const tentG = gScore[current] + cost;
      if (tentG < gScore[nIdx]) {
        cameFrom[nIdx] = current;
        gScore[nIdx] = tentG;
        fScore[nIdx] = tentG + heuristic(nx, ny, ex, ey);
        open.push(nIdx);
      }
    }
  }

  // No path found — stay put rather than walking through walls
  return [];
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  // Chebyshev distance (matches 8-directional movement)
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function reconstructPath(cameFrom: Int32Array, endIdx: number, mapWidth: number): PathPoint[] {
  const path: PathPoint[] = [];
  let current = endIdx;
  while (current !== -1) {
    const x = current % mapWidth;
    const y = (current - x) / mapWidth;
    path.push({ x, y });
    current = cameFrom[current];
  }
  path.reverse();
  return path;
}

/**
 * Convert pixel coordinates to tile coordinates.
 */
export function pixelToTile(px: number, py: number, tileW: number, tileH: number): PathPoint {
  return {
    x: Math.floor(px / tileW),
    y: Math.floor(py / tileH),
  };
}

/**
 * Convert tile coordinates to pixel center coordinates.
 */
export function tileToCenterPixel(tx: number, ty: number, tileW: number, tileH: number): PathPoint {
  return {
    x: tx * tileW + tileW / 2,
    y: ty * tileH + tileH / 2,
  };
}

/**
 * Simplify a path by removing intermediate points on straight lines.
 * Keeps start, end, and any point where the direction changes.
 */
export function simplifyPath(path: PathPoint[]): PathPoint[] {
  if (path.length <= 2) return path;
  const result: PathPoint[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    if (dx1 !== dx2 || dy1 !== dy2) {
      result.push(curr);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}
