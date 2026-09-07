import { describe, expect, it } from "vitest";
import { Box3, Mesh, Vector3 } from "three";
import { createCrewModel, crewKeys } from "../../apps/web/src/CrewModel.ts";
import { crewActivity, crewIndex, crewPosition, crewRig, poseCrew } from "../../apps/web/src/CrewMotion.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import manifest from "../../apps/web/public/crew/manifest.json" with { type: "json" };
const employee = { id: "engineer", seedKey: "software", displayName: "Renamed engineer" };
describe("crew presentation follows domain state", () => {
  it("keeps persona identity when display names and list order change", () => {
    expect(crewIndex(employee, 8)).toBe(1);
    expect(crewIndex({ seedKey: "security" }, 0)).toBe(8);
    expect(crewIndex({ id: "legacy-fixture" }, 5)).toBe(5);
  });
  it("does not invent meetings from review, plan text or unassigned steps", () => {
    expect(crewActivity(employee, { status: "reviewing" })).toBe("reviewing");
    expect(crewActivity(employee, { status: "running", goal: "Hold meeting" })).toBe("working");
    expect(
      crewActivity(employee, { status: "running", activeCoordination: { status: "running", employeeIds: ["other"] } }),
    ).toBe("working");
    expect(
      crewActivity(employee, {
        status: "running",
        activeCoordination: { status: "running", employeeIds: ["engineer"] },
      }),
    ).toBe("discussing");
    expect(crewActivity(employee, { status: "blocked" })).toBe("waiting");
    expect(crewActivity(employee, { status: "completed" })).toBe("idle");
  });
  it("stops motion immediately and keeps meaningful static work poses", () => {
    const rig = crewRig(createCrewModel(1));
    poseCrew(rig, "working", 1, true, false);
    expect(rig.LeftLeg!.rotation.x).not.toBe(0);
    poseCrew(rig, "working", 1, false, true);
    expect(rig.LeftLeg!.rotation.x).toBe(0);
    expect(rig.LeftForearm!.rotation.x).toBe(-0.9);
    const pose = Object.values(rig).map((part) => part!.rotation.toArray());
    poseCrew(rig, "working", 100, false, true);
    expect(Object.values(rig).map((part) => part!.rotation.toArray())).toEqual(pose);
    poseCrew(rig, "idle", 100, false, true);
    expect(rig.Torso!.rotation.x).toBe(0);
    expect(rig.LeftForearm!.rotation.x).toBe(-0.12);
  });
  it("uses distinct workstations for all nine employees", () => {
    const positions = crewKeys.map((_, index) => crewPosition(index, "working"));
    expect(new Set(positions.map((position) => JSON.stringify(position))).size).toBe(9);
    for (const position of positions) expect(Math.abs(position[2])).toBeLessThan(5);
  });
});
describe("authored character assets", () => {
  it("bundles nine checksum verified articulated self-contained GLBs", () => {
    expect(manifest.models).toHaveLength(9);
    expect(new Set(manifest.models.map((model) => model.seedKey)).size).toBe(9);
    for (const model of manifest.models) {
      const bytes = readFileSync(new URL(`../../apps/web/public${model.url}`, import.meta.url));
      expect(bytes.length).toBe(model.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(model.sha256);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      const names = json.nodes.map((node: { name?: string }) => node.name);
      for (const joint of ["Head", "Torso", "LeftForearm", "RightForearm", "LeftKnee", "RightKnee"])
        expect(names).toContain(joint);
      expect(json.buffers.every((buffer: { uri?: string }) => !buffer.uri)).toBe(true);
      expect(json.images ?? []).toHaveLength(0);
    }
  });
  it("gives Tyrion adult head proportions with shorter limbs and keeps Fury visibly distinct from Morpheus", () => {
    const heights = crewKeys.map(
      (_, index) => new Box3().setFromObject(createCrewModel(index)).getSize(new Vector3()).y,
    );
    expect(heights[4]).toBeLessThan(heights[0]! * 0.8);
    expect(createCrewModel(8).getObjectByName("EyePatch")).toBeDefined();
    expect(createCrewModel(8).getObjectByName("RimlessSunglasses")).toBeUndefined();
    expect(createCrewModel(2).getObjectByName("RimlessSunglasses")).toBeDefined();
    expect(createCrewModel(2).getObjectByName("EyePatch")).toBeUndefined();
    expect(createCrewModel(6).getObjectByName("Camera")).toBeDefined();
    expect(createCrewModel(6).getObjectByName("Notebook")).toBeDefined();
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      let triangles = 0;
      createCrewModel(index).traverse((object) => {
        if (object instanceof Mesh)
          triangles += (object.geometry.index?.count ?? object.geometry.attributes.position!.count) / 3;
      });
      expect(triangles).toBeLessThan(12000);
    }
  });
});
