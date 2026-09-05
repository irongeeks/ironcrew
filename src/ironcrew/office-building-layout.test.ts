import { describe, expect, it } from "vitest";
import { createOfficeBuilding, type BuildingRoom, type BuildingPoint } from "./office-building-layout";
import { officeRoute } from "./office-motion";
import type { Agent, Department } from "./types";
const keys = [
  "executive",
  "engineering",
  "infrastructure",
  "security",
  "finance",
  "legal",
  "research",
  "quality",
  "design",
  "marketing",
  "sales",
  "knowledge",
  "automation",
];
const departments: Department[] = keys.map((key) => ({ id: `department-${key}`, key, name: key, description: "" }));
const crew = departments.flatMap((d) =>
  Array.from(
    { length: d.key === "executive" ? 2 : 1 },
    (_, i) => ({ id: `${d.key}-${i}`, key: `${d.key}-${i}`, departmentId: d.id }) as Agent,
  ),
);
const contains = (room: BuildingRoom, point: BuildingPoint) =>
  point.x > room.x + 0.1 &&
  point.x < room.x + room.width - 0.1 &&
  point.y > room.y + 0.1 &&
  point.y < room.y + room.height - 0.1;
function verifyNoOverlap(rooms: BuildingRoom[]) {
  for (let i = 0; i < rooms.length; i++)
    for (const other of rooms.slice(i + 1)) {
      const r = rooms[i];
      const overlap =
        r.x < other.x + other.width &&
        r.x + r.width > other.x &&
        r.y < other.y + other.height &&
        r.y + r.height > other.y;
      expect(overlap, `${r.key} overlaps ${other.key}`).toBe(false);
    }
}
describe("office building geometry", () => {
  it("provides thirteen department offices, three shared rooms and connected doors without shortcuts through other offices", () => {
    const layout = createOfficeBuilding(departments, crew, 0, 0);
    expect(layout.rooms.filter((r) => r.departmentId)).toHaveLength(13);
    expect(new Set(layout.rooms.map((r) => r.key)).size).toBe(16);
    verifyNoOverlap(layout.rooms);
    expect(Object.keys(layout.homes)).toHaveLength(14);
    for (const agent of crew) {
      const home = layout.homes[agent.id];
      const room = layout.rooms.find((r) => r.departmentId === agent.departmentId)!;
      expect(contains(room, home.point)).toBe(true);
      const route = officeRoute(layout.graph, home.nodeId, "coffee-west");
      expect(route.length).toBeGreaterThan(4);
      expect(route).toContain(`door-${room.id}`);
      expect(route.at(-1)).toBe("coffee-west");
      for (let at = 1; at < route.length; at++) {
        const a = layout.graph.nodes[route[at - 1]],
          b = layout.graph.nodes[route[at]];
        for (let step = 0; step <= 20; step++) {
          const point = { x: a.x + ((b.x - a.x) * step) / 20, y: a.y + ((b.y - a.y) * step) / 20 };
          const foreign = layout.rooms
            .filter((r) => r.id !== room.id && r.id !== "lounge")
            .find((r) => contains(r, point));
          expect(foreign?.key, `${agent.key} cuts through ${foreign?.key}`).toBeUndefined();
        }
      }
    }
  });
  it.each([
    [14, 0],
    [0, 14],
    [14, 14],
  ])("keeps %i meeting and %i decision seats inside separate rooms", (meeting, decision) => {
    const layout = createOfficeBuilding(departments, crew, meeting, decision);
    verifyNoOverlap(layout.rooms);
    for (const [key, seats] of [
      ["meeting", layout.meetingSeats],
      ["decision", layout.decisionSeats],
    ] as const) {
      const room = layout.rooms.find((r) => r.id === key)!;
      expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(seats.length);
      for (const point of seats) {
        expect(contains(room, point)).toBe(true);
        expect(point.y + 60).toBeLessThan(room.y + room.height);
      }
    }
  });
  it("keeps extra departments and unassigned agents visible and reachable", () => {
    const expanded = [
      ...departments,
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `extra-${i}`,
        key: `extra-${i}`,
        name: `Extra ${i}`,
        description: "",
      })),
    ];
    const agents = [
      ...crew,
      ...expanded.slice(13).map((d) => ({ id: d.id, key: d.key, departmentId: d.id }) as Agent),
      { id: "unassigned-agent", key: "unassigned-agent" } as Agent,
    ];
    const layout = createOfficeBuilding(expanded, agents, 0, 0);
    verifyNoOverlap(layout.rooms);
    expect(Object.keys(layout.homes)).toHaveLength(20);
    for (const a of agents)
      expect(officeRoute(layout.graph, layout.homes[a.id].nodeId, "lounge-west").length).toBeGreaterThan(0);
    expect(layout.rooms.some((r) => r.id === "unassigned")).toBe(true);
  });
  it("reserves separate standing points for encounters and is deterministic", () => {
    const layout = createOfficeBuilding(departments, crew, 0, 0);
    const points = layout.graph.destinations.map((d) => layout.graph.nodes[d.nodeId]);
    for (let i = 0; i < points.length; i++)
      for (const other of points.slice(i + 1))
        expect(Math.hypot(points[i].x - other.x, points[i].y - other.y)).toBeGreaterThanOrEqual(120);
    expect(createOfficeBuilding([...departments].reverse(), [...crew].reverse(), 0, 0)).toEqual(layout);
  });
});
