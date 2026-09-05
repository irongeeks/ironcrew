import type { AgentStatus, Task } from "./types";

export interface OfficePoint {
  x: number;
  y: number;
}
export interface OfficeGraph {
  nodes: Readonly<Record<string, OfficePoint>>;
  edges: readonly (readonly [string, string])[];
  destinations: readonly { id: string; nodeId: string; kind: "coffee" | "lounge" | "visit"; groupId?: string }[];
}
export interface OfficeMotionSubject {
  id: string;
  status: AgentStatus;
  taskStatus?: Task["status"];
  homeNodeId: string;
  anchor: OfficePoint;
  priority?: boolean;
}
export interface OfficeMotionFrame extends OfficePoint {
  id: string;
  phase: "resting" | "walking" | "social";
  facing: "left" | "right";
  paused: boolean;
}
interface Resident {
  subject: OfficeMotionSubject;
  frame: OfficeMotionFrame;
  route: string[];
  segment: number;
  destination: OfficeGraph["destinations"][number] | null;
  returning: boolean;
  nextDeparture: number;
  dwellUntil: number;
  socialUntil: number;
  visit: number;
  focusedAt: number | null;
}
const WALK_SPEED = 38;
const MAX_VISITORS = 3;
const distance = (a: OfficePoint, b: OfficePoint) => Math.hypot(a.x - b.x, a.y - b.y);
const samePoint = (a: OfficePoint, b: OfficePoint) => a.x === b.x && a.y === b.y;
function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

/** Cosmetic wandering never represents a run, a message, or an actual meeting. */
export function mayWander(subject: OfficeMotionSubject): boolean {
  return (
    !subject.priority &&
    (subject.status === "idle" || subject.status === "waiting_for_input") &&
    !["running", "approval_required", "blocked"].includes(subject.taskStatus ?? "")
  );
}

/** Stable, undirected shortest paths use only explicit doors and corridor edges. */
export function officeRoute(graph: OfficeGraph, from: string, to: string): string[] {
  if (!graph.nodes[from] || !graph.nodes[to]) return [];
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of graph.edges) {
    if (!graph.nodes[a] || !graph.nodes[b] || a === b) continue;
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const pending = new Set(Object.keys(graph.nodes));
  const lengths = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  while (pending.size) {
    const current = [...pending].sort(
      (a, b) => (lengths.get(a) ?? Infinity) - (lengths.get(b) ?? Infinity) || a.localeCompare(b),
    )[0];
    if (!Number.isFinite(lengths.get(current))) break;
    pending.delete(current);
    if (current === to) {
      const result = [to];
      while (result[0] !== from) result.unshift(previous.get(result[0])!);
      return result;
    }
    for (const next of (neighbours.get(current) ?? []).sort()) {
      if (!pending.has(next)) continue;
      const length = lengths.get(current)! + distance(graph.nodes[current], graph.nodes[next]);
      if (length < (lengths.get(next) ?? Infinity)) {
        lengths.set(next, length);
        previous.set(next, current);
      }
    }
  }
  return [];
}

/** Stateful simulation clock; views read frames directly instead of setting React state each frame. */
export class OfficeMotionEngine {
  private residents = new Map<string, Resident>();
  private frames = new Map<string, OfficeMotionFrame>();
  private encounterVisits = new Map<string, string>();
  private time = 0;
  private lastTimestamp: number | null = null;
  private paused = false;
  constructor(
    readonly graph: OfficeGraph,
    subjects: readonly OfficeMotionSubject[],
  ) {
    this.sync(subjects);
  }

  sync(subjects: readonly OfficeMotionSubject[]): void {
    const ids = new Set(subjects.map((s) => s.id));
    for (const id of this.residents.keys())
      if (!ids.has(id)) {
        this.residents.delete(id);
        this.frames.delete(id);
      }
    for (const subject of subjects) {
      let resident = this.residents.get(subject.id);
      if (!resident) {
        resident = {
          subject,
          frame: { id: subject.id, ...subject.anchor, phase: "resting", facing: "right", paused: this.paused },
          route: [],
          segment: 0,
          destination: null,
          returning: false,
          nextDeparture: this.time + 8000 + (hash(subject.id) % 20000),
          dwellUntil: 0,
          socialUntil: 0,
          visit: 0,
          focusedAt: null,
        };
        this.residents.set(subject.id, resident);
        this.frames.set(subject.id, resident.frame);
      } else {
        const interrupted =
          !mayWander(subject) ||
          !mayWander(resident.subject) ||
          subject.homeNodeId !== resident.subject.homeNodeId ||
          !samePoint(subject.anchor, resident.subject.anchor);
        resident.subject = subject;
        if (interrupted) this.home(resident);
      }
    }
    // Remove encounter bookkeeping for removed agents, keeping memory bounded by the visible crew.
    for (const key of this.encounterVisits.keys()) {
      const pair = JSON.parse(key) as string[];
      if (pair.some((id) => !ids.has(id))) this.encounterVisits.delete(key);
    }
    this.updateSocial();
  }
  private home(resident: Resident): void {
    Object.assign(resident.frame, resident.subject.anchor, { phase: "resting" });
    resident.route = [];
    resident.destination = null;
    resident.returning = false;
    resident.socialUntil = 0;
    resident.nextDeparture = this.time + 30000 + (hash(`${resident.subject.id}:${resident.visit}`) % 40000);
  }
  setPaused(paused: boolean): void {
    if (paused !== this.paused) this.lastTimestamp = null;
    this.paused = paused;
    for (const resident of this.residents.values()) resident.frame.paused = paused || resident.focusedAt !== null;
  }
  setFocused(id: string, focused: boolean): void {
    const resident = this.residents.get(id);
    if (!resident) return;
    if (focused && resident.focusedAt === null) resident.focusedAt = this.time;
    if (!focused && resident.focusedAt !== null) {
      const elapsed = this.time - resident.focusedAt;
      resident.nextDeparture += elapsed;
      resident.dwellUntil += elapsed;
      resident.socialUntil += elapsed;
      resident.focusedAt = null;
    }
    resident.frame.paused = this.paused || focused;
  }
  read(): ReadonlyMap<string, OfficeMotionFrame> {
    return this.frames;
  }

  advance(timestamp: number): ReadonlyMap<string, OfficeMotionFrame> {
    if (!Number.isFinite(timestamp)) return this.frames;
    const delta = this.lastTimestamp === null ? 0 : Math.max(0, timestamp - this.lastTimestamp);
    this.lastTimestamp = Math.max(timestamp, this.lastTimestamp ?? timestamp);
    if (this.paused) return this.frames;
    this.time += delta;
    const residents = [...this.residents.values()].sort(
      (a, b) => a.nextDeparture - b.nextDeparture || a.subject.id.localeCompare(b.subject.id),
    );
    for (const resident of residents) {
      if (!mayWander(resident.subject) || resident.focusedAt !== null) continue;
      if (resident.route.length) this.walk(resident, delta);
      else if (resident.destination && this.time >= resident.dwellUntil) {
        const route = officeRoute(this.graph, resident.destination.nodeId, resident.subject.homeNodeId);
        if (route.length) {
          resident.route = route;
          resident.segment = 1;
          resident.returning = true;
          resident.frame.phase = "walking";
        } else this.home(resident);
      } else if (!resident.destination && this.time >= resident.nextDeparture) this.depart(resident);
    }
    this.updateSocial();
    return this.frames;
  }
  private depart(resident: Resident): void {
    const visitors = [...this.residents.values()].filter((r) => r.destination);
    if (visitors.length >= MAX_VISITORS) return;
    const occupied = new Set(visitors.map((r) => r.destination!.id));
    const groups = new Set(visitors.map((r) => r.destination!.groupId ?? r.destination!.id));
    const choices = [...this.graph.destinations]
      .filter((d) => !occupied.has(d.id) && d.nodeId !== resident.subject.homeNodeId)
      .sort(
        (a, b) =>
          Number(groups.has(b.groupId ?? b.id)) - Number(groups.has(a.groupId ?? a.id)) ||
          hash(`${resident.subject.id}:${resident.visit}:${a.id}`) -
            hash(`${resident.subject.id}:${resident.visit}:${b.id}`),
      );
    for (const destination of choices) {
      const route = officeRoute(this.graph, resident.subject.homeNodeId, destination.nodeId);
      if (route.length < 2 || !samePoint(resident.frame, this.graph.nodes[resident.subject.homeNodeId])) continue;
      resident.destination = destination;
      resident.route = route;
      resident.segment = 1;
      resident.returning = false;
      resident.visit++;
      resident.frame.phase = "walking";
      return;
    }
    resident.nextDeparture = this.time + 30000;
  }
  private walk(resident: Resident, delta: number): void {
    let budget = (WALK_SPEED * delta) / 1000;
    while (resident.segment < resident.route.length) {
      const target = this.graph.nodes[resident.route[resident.segment]];
      const remaining = distance(resident.frame, target);
      if (target.x !== resident.frame.x) resident.frame.facing = target.x < resident.frame.x ? "left" : "right";
      if (remaining > budget) {
        resident.frame.x += ((target.x - resident.frame.x) * budget) / remaining;
        resident.frame.y += ((target.y - resident.frame.y) * budget) / remaining;
        return;
      }
      Object.assign(resident.frame, target);
      budget -= remaining;
      resident.segment++;
    }
    resident.route = [];
    if (resident.returning) this.home(resident);
    else {
      resident.frame.phase = "resting";
      resident.dwellUntil = this.time + 35000 + (hash(`${resident.subject.id}:${resident.visit}`) % 25000);
    }
  }
  private updateSocial(): void {
    const conversing = new Set<string>();
    const visitors = [...this.residents.values()].filter(
      (r) => r.destination && !r.route.length && r.focusedAt === null,
    );
    for (let i = 0; i < visitors.length; i++)
      for (let j = i + 1; j < visitors.length; j++) {
        const a = visitors[i],
          b = visitors[j];
        if (
          (a.destination!.groupId ?? a.destination!.id) !== (b.destination!.groupId ?? b.destination!.id) ||
          distance(a.frame, b.frame) > 160
        )
          continue;
        const pair = [a, b].sort((x, y) => x.subject.id.localeCompare(y.subject.id));
        const key = JSON.stringify(pair.map((r) => r.subject.id));
        const visits = JSON.stringify(pair.map((r) => r.visit));
        if (this.encounterVisits.get(key) !== visits) {
          this.encounterVisits.set(key, visits);
          a.socialUntil = b.socialUntil = this.time + 6000;
        }
        if (a.socialUntil > this.time && b.socialUntil > this.time) {
          conversing.add(a.subject.id);
          conversing.add(b.subject.id);
          a.frame.facing = a.frame.x < b.frame.x ? "right" : "left";
          b.frame.facing = b.frame.x < a.frame.x ? "right" : "left";
        }
      }
    for (const resident of this.residents.values())
      if (!resident.route.length) {
        resident.frame.phase = conversing.has(resident.subject.id) ? "social" : "resting";
      }
  }
}
