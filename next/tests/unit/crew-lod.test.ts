import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Mesh, type Group, type Object3D } from "three";
import { createCrewModel, crewNames } from "../../apps/web/src/CrewModel.ts";
import { createCrewDistanceLod } from "../../apps/web/tools/crew-lod.ts";
import manifest from "../../apps/web/public/crew/manifest.json" with { type: "json" };

function nodes(scene: Group) {
  const result: Object3D[] = [];
  scene.traverse((object) => result.push(object));
  return result;
}

describe("offline articulated crew distance LOD", () => {
  it.each(crewNames)("reduces %s while retaining rig, features, material and vertex attributes", async (name) => {
    const source = createCrewModel(crewNames.indexOf(name));
    const originals = nodes(source);
    const sourceCounts = originals.map((node) => (node instanceof Mesh ? node.geometry.index?.count : undefined));
    const lod = await createCrewDistanceLod(source);
    const simplified = nodes(lod);
    expect(simplified.map((node) => [node.type, node.name, node.parent?.name])).toEqual(
      originals.map((node) => [node.type, node.name, node.parent?.name]),
    );
    let triangles = 0;
    for (const [index, node] of simplified.entries()) {
      const original = originals[index]!;
      expect(node.position.toArray()).toEqual(original.position.toArray());
      expect(node.quaternion.toArray()).toEqual(original.quaternion.toArray());
      expect(node.scale.toArray()).toEqual(original.scale.toArray());
      if (!(node instanceof Mesh) || !(original instanceof Mesh)) continue;
      expect(node.material).toBe(original.material);
      expect(node.geometry).not.toBe(original.geometry);
      expect(original.geometry.index?.count).toBe(sourceCounts[index]);
      expect(Object.keys(node.geometry.attributes)).toEqual(Object.keys(original.geometry.attributes));
      for (const name of Object.keys(node.geometry.attributes)) {
        const attribute = node.geometry.getAttribute(name);
        expect(attribute.count).toBe(node.geometry.getAttribute("position").count);
        expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
      }
      const normal = node.geometry.getAttribute("normal");
      for (let vertex = 0; vertex < normal.count; vertex++) {
        expect(Math.hypot(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex))).toBeCloseTo(1, 4);
      }
      triangles += node.geometry.index!.count / 3;
    }
    expect(triangles).toBeGreaterThanOrEqual(2500);
    expect(triangles).toBeLessThanOrEqual(3500);
  });

  it("ships checksum-matched standalone distance GLBs with the same named rig and PBR attributes", () => {
    for (const model of manifest.models) {
      const full = readFileSync(new URL(`../../apps/web/public${model.url}`, import.meta.url));
      const lod = readFileSync(new URL(`../../apps/web/public${model.lod.url}`, import.meta.url));
      expect(createHash("sha256").update(lod).digest("hex")).toBe(model.lod.sha256);
      expect(lod.length).toBe(model.lod.byteLength);
      expect(lod.length).toBeLessThan(full.length);
      const original = JSON.parse(full.subarray(20, 20 + full.readUInt32LE(12)).toString());
      const compact = JSON.parse(lod.subarray(20, 20 + lod.readUInt32LE(12)).toString());
      expect(compact.nodes.map((node: { name?: string }) => node.name)).toEqual(
        original.nodes.map((node: { name?: string }) => node.name),
      );
      expect(compact.materials).toEqual(original.materials);
      expect(compact.extensionsUsed ?? []).toEqual(original.extensionsUsed ?? []);
      expect(compact.buffers.every((buffer: { uri?: string }) => !buffer.uri)).toBe(true);
      for (const [index, node] of compact.nodes.entries()) {
        if (typeof node.mesh !== "number") continue;
        const mesh = compact.meshes[node.mesh];
        expect(
          mesh.primitives.map((primitive: { attributes: Record<string, number> }) =>
            Object.keys(primitive.attributes).sort(),
          ),
        ).toEqual(
          original.meshes[original.nodes[index].mesh].primitives.map(
            (primitive: { attributes: Record<string, number> }) => Object.keys(primitive.attributes).sort(),
          ),
        );
      }
    }
  });
});
