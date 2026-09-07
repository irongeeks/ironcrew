import type { Group, Object3D } from "three";
import type { Row } from "./api.ts";
import { crewKeys } from "./CrewModel.ts";
export type CrewActivity = "idle" | "waiting" | "working" | "reviewing" | "discussing";
export function crewIndex(employee: Row, fallback = 0): number {
  const found = crewKeys.findIndex((key) => key === employee.seedKey);
  return found < 0 ? fallback % crewKeys.length : found;
}
/** A plan title is not proof of a meeting. Only a running, explicitly assigned coordination step is. */
export function crewActivity(employee: Row, order?: Row): CrewActivity {
  if (!order || ["completed", "cancelled", "failed"].includes(String(order.status))) return "idle";
  if (["blocked", "ready", "inbox", "planning"].includes(String(order.status))) return "waiting";
  const step = order.activeCoordination;
  if (order.status === "running" && step && typeof step === "object" && !Array.isArray(step)) {
    const coordination = step as Row;
    if (
      coordination.status === "running" &&
      Array.isArray(coordination.employeeIds) &&
      coordination.employeeIds.includes(employee.id)
    )
      return "discussing";
  }
  return order.status === "running" ? "working" : order.status === "reviewing" ? "reviewing" : "idle";
}
export function crewPosition(index: number, activity: CrewActivity): [number, number, number] {
  // Each employee has a distinct station; never stack several figures at one desk.
  if (activity === "working" || activity === "reviewing")
    return [index % 2 ? 5.9 : -5.9, 0, -2.4 + Math.floor(index / 2) * 1.55];
  const angle = (index / 9) * Math.PI * 2;
  return [
    Math.sin(angle) * (activity === "discussing" ? 2.75 : 4.3),
    0,
    Math.cos(angle) * (activity === "discussing" ? 1.85 : 3.55),
  ];
}
export function crewRig(model: Group) {
  return Object.fromEntries(
    [
      "Torso",
      "Head",
      "LeftLeg",
      "RightLeg",
      "LeftKnee",
      "RightKnee",
      "LeftArm",
      "RightArm",
      "LeftForearm",
      "RightForearm",
    ].map((name) => [name, model.getObjectByName(name)]),
  );
}
export function poseCrew(
  rig: Record<string, Object3D | undefined>,
  activity: CrewActivity,
  time: number,
  moving: boolean,
  reduced: boolean,
  phase = 0,
) {
  // All rotations assigned every frame: disabling motion resets a pose immediately, without a frozen walking leg.
  const dynamic = reduced ? 0 : 1,
    t = time + phase;
  const walk = moving && !reduced ? Math.sin(t * 7) * 0.36 : 0;
  const breath = Math.sin(t * 1.7) * 0.012 * dynamic;
  const typing = Math.sin(t * 5.5) * 0.065 * dynamic;
  const gesture = Math.sin(t * 2.1) * 0.13 * dynamic;
  const rotation = (name: string, x: number, y = 0, z = 0) => {
    rig[name]?.rotation.set(x, y, z);
  };
  rotation("Torso", moving ? 0.04 : activity === "working" ? 0.08 : 0, 0, moving ? 0 : breath);
  rotation(
    "Head",
    activity === "reviewing" ? 0.19 : activity === "working" ? 0.13 : 0,
    activity === "discussing" ? gesture : 0,
  );
  rotation("LeftLeg", walk);
  rotation("RightLeg", -walk);
  rotation("LeftKnee", Math.max(0, -walk) * 1.3);
  rotation("RightKnee", Math.max(0, walk) * 1.3);
  let left = -walk,
    right = walk,
    elbowLeft = -0.12,
    elbowRight = -0.12;
  if (!moving && activity === "working") {
    left = -0.35;
    right = -0.35;
    elbowLeft = -0.9 + typing;
    elbowRight = -0.9 - typing;
  }
  if (!moving && activity === "reviewing") {
    left = -0.4;
    right = -0.12;
    elbowLeft = -1.3;
    elbowRight = -1.65;
  }
  if (!moving && activity === "discussing") {
    left = -0.25;
    right = -0.45 + gesture;
    elbowLeft = -0.65;
    elbowRight = -1.0 + gesture;
  }
  if (!moving && activity === "waiting") {
    left = -0.06;
    right = -0.06;
    elbowLeft = -0.25;
    elbowRight = -0.25;
  }
  rotation("LeftArm", left, 0, 0.08);
  rotation("RightArm", right, 0, -0.08);
  rotation("LeftForearm", elbowLeft);
  rotation("RightForearm", elbowRight);
}
