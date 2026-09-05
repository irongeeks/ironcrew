import type { Agent, Department } from "./types";

export interface BuildingPoint {
  x: number;
  y: number;
}
export interface BuildingRoom {
  id: string;
  departmentId?: string;
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  door: BuildingPoint;
  doorSide: "top" | "bottom" | "left" | "right";
}
export interface OfficeBuildingLayout {
  width: number;
  height: number;
  rooms: BuildingRoom[];
  homes: Record<string, { point: BuildingPoint; nodeId: string }>;
  meetingSeats: BuildingPoint[];
  decisionSeats: BuildingPoint[];
  graph: {
    nodes: Record<string, BuildingPoint>;
    edges: [string, string][];
    destinations: { id: string; nodeId: string; kind: "coffee" | "lounge" | "visit"; groupId?: string }[];
  };
  northHall: number;
  southHall: number;
  middleHall: number;
}
const ORDER = [
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
export const BUILDING_WIDTH = 1120;
const ROOM_GAP = 14;

/** One navigable graph drives both furniture geometry and animation routes.
 * Coordinates are foot points. Room capacity expands without overlapping zones. */
export function createOfficeBuilding(
  departments: Department[],
  agents: Agent[],
  meetingCount: number,
  decisionCount: number,
): OfficeBuildingLayout {
  const ordered = [...departments].sort((a, b) => {
    const ai = ORDER.indexOf(a.key),
      bi = ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.id.localeCompare(b.id);
  });
  const unknown = agents.some((a) => !ordered.some((d) => d.id === a.departmentId));
  if (unknown)
    ordered.push({ id: "unassigned", key: "unassigned", name: "Crew-Studio", description: "Agents ohne Abteilung" });
  const byDepartment = (id: string) =>
    agents.filter(
      (a) => a.departmentId === id || (id === "unassigned" && !departments.some((d) => d.id === a.departmentId)),
    );
  const heightFor = (items: Department[], columns: number, min = 270) =>
    Math.max(min, ...items.map((d) => 130 + Math.ceil(byDepartment(d.id).length / columns) * 140));
  const top = ordered.slice(0, 4),
    wings = ordered.slice(4, 8),
    bottom = ordered.slice(8);
  const topHeight = heightFor(top, 2);
  const northHall = 52 + topHeight + 36;
  const middleTop = northHall + 40;
  const meetingHeight = Math.max(270, 90 + Math.ceil(meetingCount / 2) * 145);
  const decisionHeight = Math.max(270, 90 + Math.ceil(decisionCount / 2) * 145);
  const middleHeight = Math.max(meetingHeight, decisionHeight, heightFor(wings.slice(0, 2), 2));
  const middleHall = middleTop + middleHeight + 36;
  const loungeTop = middleHall + 40;
  const loungeHeight = heightFor(wings.slice(2), 2, 280);
  const southHall = loungeTop + loungeHeight + 36;
  const bottomTop = southHall + 40;
  const bottomRows = Math.max(1, Math.ceil(bottom.length / 5));
  const bottomHeight = heightFor(bottom, 1);
  const height = bottomTop + bottomRows * (bottomHeight + 60) + 25;
  const rooms: BuildingRoom[] = [];
  const nodes: Record<string, BuildingPoint> = {};
  const edges: [string, string][] = [];
  const destinations: OfficeBuildingLayout["graph"]["destinations"] = [];
  const homes: OfficeBuildingLayout["homes"] = {};
  const node = (id: string, point: BuildingPoint) => {
    nodes[id] = point;
    return id;
  };
  const link = (a: string, b: string) => {
    edges.push([a, b]);
  };
  const halls = [northHall, middleHall, southHall];
  halls.forEach((y, i) => {
    node(`hall-${i}-left`, { x: 280, y });
    node(`hall-${i}-right`, { x: 840, y });
    link(`hall-${i}-left`, `hall-${i}-right`);
    if (i > 0) {
      link(`hall-${i - 1}-left`, `hall-${i}-left`);
      link(`hall-${i - 1}-right`, `hall-${i}-right`);
    }
  });
  function departmentRoom(
    d: Department,
    x: number,
    y: number,
    width: number,
    roomHeight: number,
    side: BuildingRoom["doorSide"],
    hallIndex: number,
  ) {
    const door =
      side === "top"
        ? { x: x + width / 2, y }
        : side === "bottom"
          ? { x: x + width / 2, y: y + roomHeight }
          : { x: side === "left" ? x : x + width, y: y + roomHeight - 45 };
    const room = {
      id: d.id,
      departmentId: d.id,
      key: d.key,
      name: d.name,
      x,
      y,
      width,
      height: roomHeight,
      door,
      doorSide: side,
    };
    rooms.push(room);
    const doorId = node(`door-${d.id}`, door);
    const hallY = halls[hallIndex] ?? southHall;
    const junction =
      side === "left" || side === "right" ? { x: side === "left" ? 840 : 280, y: door.y } : { x: door.x, y: hallY };
    const junctionId = node(`junction-${d.id}`, junction);
    link(doorId, junctionId);
    if (side === "left" || side === "right") {
      const wing = side === "left" ? "right" : "left";
      link(junctionId, `hall-${hallIndex}-${wing}`);
      if (hallIndex + 1 < halls.length) link(junctionId, `hall-${hallIndex + 1}-${wing}`);
    } else {
      link(junctionId, `hall-${hallIndex}-${junction.x < 560 ? "left" : "right"}`);
    }
    const occupants = byDepartment(d.id).sort((a, b) => a.key.localeCompare(b.key));
    const columns = width >= 240 ? 2 : 1;
    occupants.forEach((a, i) => {
      const occupiedCols = Math.min(columns, occupants.length);
      const point = {
        x: x + width / 2 + ((i % columns) - (occupiedCols - 1) / 2) * 108,
        y: y + 175 + Math.floor(i / columns) * 140,
      };
      const id = node(`home-${a.id}`, point);
      // Walk around desk fronts. South studios exit by the side aisle instead
      // of walking straight through the desk and its screen to the north door.
      if (side === "top") {
        const sideX = x + width - 14;
        const front = node(`front-${a.id}`, { x: sideX, y: point.y + 20 });
        const aisle = node(`aisle-${a.id}`, { x: sideX, y: y + 20 });
        const foyer = node(`foyer-${a.id}`, { x: door.x, y: y + 20 });
        link(id, front);
        link(front, aisle);
        link(aisle, foyer);
        link(foyer, doorId);
      } else {
        const front = node(`front-${a.id}`, { x: x + width / 2, y: point.y + 35 });
        const aisle = node(`aisle-${a.id}`, { x: x + width / 2, y: y + roomHeight - 45 });
        link(id, front);
        link(front, aisle);
        link(aisle, doorId);
      }
      homes[a.id] = { point, nodeId: id };
    });
  }
  top.forEach((d, i) => departmentRoom(d, 24 + i * 274, 52, 250, topHeight, "bottom", 0));
  wings.forEach((d, i) =>
    departmentRoom(
      d,
      i % 2 === 0 ? 24 : 856,
      i < 2 ? middleTop : loungeTop,
      240,
      i < 2 ? middleHeight : loungeHeight,
      i % 2 === 0 ? "right" : "left",
      i < 2 ? 0 : 1,
    ),
  );
  bottom.forEach((d, i) => {
    const row = Math.floor(i / 5),
      rowY = bottomTop + row * (bottomHeight + 60);
    departmentRoom(d, 24 + (i % 5) * (203.2 + ROOM_GAP), rowY, 203.2, bottomHeight, "top", 2);
    if (row > 0) {
      // Additional departments extend the south wing with an external side aisle.
      const j = `junction-${d.id}`;
      nodes[j] = { x: nodes[j].x, y: rowY - 30 };
      const side = node(`south-extension-${d.id}`, { x: 12, y: rowY - 30 });
      link(j, side);
      link(side, node(`south-entry-${d.id}`, { x: 12, y: southHall }));
      link(`south-entry-${d.id}`, "hall-2-left");
      const old = edges.findIndex(([a, b]) => a === j && b.startsWith("hall-"));
      if (old >= 0) edges.splice(old, 1);
    }
  });
  const meeting: BuildingRoom = {
    id: "meeting",
    key: "meeting",
    name: "Meetingraum",
    x: 304,
    y: middleTop,
    width: 244,
    height: middleHeight,
    door: { x: 426, y: middleTop },
    doorSide: "top",
  };
  const decision: BuildingRoom = {
    id: "decision",
    key: "decision",
    name: "Entscheidungen",
    x: 572,
    y: middleTop,
    width: 244,
    height: middleHeight,
    door: { x: 694, y: middleTop },
    doorSide: "top",
  };
  const lounge: BuildingRoom = {
    id: "lounge",
    key: "lounge",
    name: "Lounge & Kaffee",
    x: 304,
    y: loungeTop,
    width: 512,
    height: loungeHeight,
    door: { x: 560, y: loungeTop },
    doorSide: "top",
  };
  rooms.push(meeting, decision, lounge);
  const seat = (room: BuildingRoom, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      x: room.x + 66 + (i % 2) * 112,
      y: room.y + 140 + Math.floor(i / 2) * 145,
    }));
  node("lounge-entry", lounge.door);
  node("lounge-hall", { x: 560, y: middleHall });
  link("lounge-hall", "hall-1-left");
  link("lounge-hall", "hall-1-right");
  link("lounge-entry", "lounge-hall");
  node("lounge-aisle", { x: 560, y: loungeTop + 170 });
  link("lounge-entry", "lounge-aisle");
  const social = [
    { id: "coffee-west", x: 355, y: loungeTop + 185, kind: "coffee" as const, groupId: "coffee" },
    { id: "coffee-east", x: 475, y: loungeTop + 185, kind: "coffee" as const, groupId: "coffee" },
    { id: "lounge-west", x: 630, y: loungeTop + 185, kind: "lounge" as const, groupId: "lounge" },
    { id: "lounge-east", x: 750, y: loungeTop + 185, kind: "lounge" as const, groupId: "lounge" },
  ];
  social.forEach((s) => {
    node(s.id, { x: s.x, y: s.y });
    link(s.id, "lounge-aisle");
    destinations.push({ id: s.id, nodeId: s.id, kind: s.kind, groupId: s.groupId });
  });
  return {
    width: BUILDING_WIDTH,
    height,
    rooms,
    homes,
    meetingSeats: seat(meeting, meetingCount),
    decisionSeats: seat(decision, decisionCount),
    graph: { nodes, edges, destinations },
    northHall,
    middleHall,
    southHall,
  };
}
