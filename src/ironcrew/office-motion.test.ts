import { describe, expect, it } from "vitest";
import {
  mayWander,
  OfficeMotionEngine,
  officeRoute,
  type OfficeGraph,
  type OfficeMotionSubject,
} from "./office-motion";

export const graph: OfficeGraph = {
  nodes: {
    homeA: { x: 0, y: 0 },
    doorA: { x: 0, y: 100 },
    homeB: { x: 100, y: 0 },
    doorB: { x: 100, y: 100 },
    corridor: { x: 200, y: 100 },
    coffeeA: { x: 200, y: 160 },
    coffeeB: { x: 270, y: 160 },
  },
  edges: [
    ["homeA", "doorA"],
    ["doorA", "doorB"],
    ["homeB", "doorB"],
    ["doorB", "corridor"],
    ["corridor", "coffeeA"],
    ["coffeeA", "coffeeB"],
  ],
  destinations: [
    { id: "coffee-a", nodeId: "coffeeA", kind: "coffee", groupId: "coffee" },
    { id: "coffee-b", nodeId: "coffeeB", kind: "coffee", groupId: "coffee" },
  ],
};
const subject = (id = "Ada", homeNodeId = "homeA"): OfficeMotionSubject => ({
  id,
  status: "idle",
  homeNodeId,
  anchor: graph.nodes[homeNodeId],
});
function onSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  return (
    Math.abs(Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(a.x - b.x, a.y - b.y)) <
    0.0001
  );
}
function run(engine: OfficeMotionEngine, until: number, start = 0) {
  for (let time = start; time <= until; time += 100) engine.advance(time);
}

describe("bounded office motion", () => {
  it("routes through explicit doors and corridors, never directly through walls", () => {
    expect(officeRoute(graph, "homeA", "coffeeA")).toEqual(["homeA", "doorA", "doorB", "corridor", "coffeeA"]);
    expect(
      officeRoute({ ...graph, edges: graph.edges.filter(([from]) => from !== "homeA") }, "homeA", "coffeeA"),
    ).toEqual([]);
    const engine = new OfficeMotionEngine(graph, [subject()]);
    let walked = false;
    for (let time = 0; time <= 90000; time += 100) {
      const p = engine.advance(time).get("Ada")!;
      if (p.phase === "walking") {
        walked = true;
        expect(graph.edges.some(([a, b]) => onSegment(p, graph.nodes[a], graph.nodes[b]))).toBe(true);
      }
    }
    expect(walked).toBe(true);
  });
  it("is deterministic across input order and render refreshes; its clock never runs backwards", () => {
    const people = [subject(), subject("Bea", "homeB")];
    const first = new OfficeMotionEngine(graph, people),
      second = new OfficeMotionEngine(graph, [...people].reverse());
    for (let time = 0; time <= 180000; time += 100) {
      first.advance(time);
      second.sync([...people]);
      second.advance(time);
      for (const person of people) expect(second.read().get(person.id)).toEqual(first.read().get(person.id));
    }
    const position = structuredClone(first.read().get("Ada"));
    first.advance(1000);
    expect(first.read().get("Ada")).toEqual(position);
  });
  it("allows only available idle/waiting employees and immediately preempts for genuine work, decisions and meetings", () => {
    for (const status of [
      "offline",
      "working",
      "thinking",
      "paused",
      "error",
      "rate_limited",
      "waiting_for_approval",
      "in_meeting",
    ] as const)
      expect(mayWander({ ...subject(), status })).toBe(false);
    expect(mayWander({ ...subject(), status: "waiting_for_input" })).toBe(true);
    for (const taskStatus of ["running", "approval_required", "blocked"] as const)
      expect(mayWander({ ...subject(), taskStatus })).toBe(false);
    expect(mayWander({ ...subject(), priority: true })).toBe(false);
    const engine = new OfficeMotionEngine(graph, [subject()]);
    run(engine, 30000);
    expect(engine.read().get("Ada")).not.toMatchObject(graph.nodes.homeA);
    const anchor = { x: 600, y: 500 };
    engine.sync([{ ...subject(), status: "in_meeting", anchor, priority: true }]);
    expect(engine.read().get("Ada")).toMatchObject({ ...anchor, phase: "resting" });
    run(engine, 120000, 30100);
    expect(engine.read().get("Ada")).toMatchObject({ ...anchor, phase: "resting" });
    engine.sync([{ ...subject(), taskStatus: "running" }]);
    expect(engine.read().get("Ada")).toMatchObject({ ...graph.nodes.homeA, phase: "resting" });
  });
  it("pauses without a resume jump and freezes focused actors while other animation continues", () => {
    const engine = new OfficeMotionEngine(graph, [subject()]);
    run(engine, 26000);
    engine.setPaused(true);
    const frozen = structuredClone(engine.read().get("Ada"));
    engine.advance(900000);
    expect(engine.read().get("Ada")).toEqual(frozen);
    engine.setPaused(false);
    engine.advance(950000);
    expect(engine.read().get("Ada")).toMatchObject({ x: frozen!.x, y: frozen!.y });
    engine.setFocused("Ada", true);
    const focused = structuredClone(engine.read().get("Ada"));
    engine.advance(960000);
    expect(engine.read().get("Ada")).toEqual(focused);
    engine.setFocused("Ada", false);
    engine.advance(960100);
    expect(engine.read().get("Ada")!.paused).toBe(false);
  });
  it("stages short encounters between distinct occupied coffee points and never changes business input", () => {
    const people = [subject(), subject("Bea", "homeB")];
    const original = structuredClone(people);
    const engine = new OfficeMotionEngine(graph, people);
    let socialFrames = 0,
      firstSocial = -1,
      lastSocial = -1;
    for (let time = 0; time < 60000; time += 100) {
      const frames = [...engine.advance(time).values()];
      if (frames.every((frame) => frame.phase === "social")) {
        socialFrames++;
        if (firstSocial < 0) firstSocial = time;
        lastSocial = time;
        expect(frames[0].x).not.toBe(frames[1].x);
        expect(frames.every((frame) => frame.y === 160)).toBe(true);
      }
    }
    expect(socialFrames).toBeGreaterThan(0);
    expect(lastSocial - firstSocial).toBeLessThanOrEqual(6000);
    expect(people).toEqual(original);
  });
  it("limits visits to a small group and lets missing/disconnected nodes remain safely at home", () => {
    const larger: OfficeGraph = {
      ...graph,
      destinations: [
        ...graph.destinations,
        { id: "visit", nodeId: "corridor", kind: "visit" },
        { id: "door", nodeId: "doorB", kind: "visit" },
      ],
    };
    const people = Array.from({ length: 14 }, (_, i) => subject(`person-${i}`));
    const engine = new OfficeMotionEngine(larger, people);
    for (let time = 0; time < 180000; time += 500) {
      const away = [...engine.advance(time).values()].filter(
        (frame) => frame.x !== 0 || frame.y !== 0 || frame.phase === "walking",
      );
      expect(away.length).toBeLessThanOrEqual(3);
    }
    const disconnected = new OfficeMotionEngine({ ...graph, edges: [] }, [subject()]);
    run(disconnected, 120000);
    expect(disconnected.read().get("Ada")).toMatchObject({ ...graph.nodes.homeA, phase: "resting" });
    engine.sync([]);
    expect(engine.read().size).toBe(0);
  });
});
