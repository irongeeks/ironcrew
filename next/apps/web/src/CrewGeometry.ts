/** Authored smooth surfaces and draw-call packing for articulated, self-contained crew assets. */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Vector3,
  CatmullRomCurve3,
  TubeGeometry,
  Group,
  Mesh,
  type Material,
} from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
export type Point = [number, number, number];
/** y, half-width, half-depth, forward offset. */
export type Section = [number, number, number, number?];
export function surface(sections: Section[], segments = 24, sculpt?: (point: Vector3, angle: number) => void) {
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (const [row, [y, width, depth, forward = 0]] of sections.entries()) {
    for (let col = 0; col <= segments; col++) {
      const angle = (col / segments) * Math.PI * 2;
      const p = new Vector3(Math.sin(angle) * width, y, Math.cos(angle) * depth + forward);
      sculpt?.(p, angle);
      positions.push(p.x, p.y, p.z);
      uvs.push(col / segments, row / (sections.length - 1));
      if (row && col) {
        const a = row * (segments + 1) + col,
          b = a - segments - 1;
        if (sections[0]![0] <= sections.at(-1)![0]) indices.push(a - 1, b - 1, b, a - 1, b, a);
        else indices.push(a - 1, b, b - 1, a - 1, a, b);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
export function strand(points: Point[], radius: number, steps = 12, sides = 5) {
  return new TubeGeometry(new CatmullRomCurve3(points.map((p) => new Vector3(...p))), steps, radius, sides, false);
}
/** Merge rigid pieces per material and joint, preserving feature anchors and articulation. */
export function packCrewMeshes(root: Group) {
  const groups: Group[] = [];
  root.traverse((item) => {
    if (item instanceof Group) groups.push(item);
  });
  for (const group of groups) {
    const batches = new Map<Material, Mesh[]>();
    for (const child of group.children) {
      if (!(child instanceof Mesh) || Array.isArray(child.material)) continue;
      const batch = batches.get(child.material) ?? [];
      batch.push(child);
      batches.set(child.material, batch);
    }
    for (const [material, meshes] of batches) {
      if (meshes.length < 2) continue;
      const geometries = meshes.map((mesh) => {
        mesh.updateMatrix();
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix);
        return geometry.index ? geometry.toNonIndexed() : geometry;
      });
      const geometry = mergeGeometries(geometries);
      geometries.forEach((item) => item.dispose());
      if (!geometry) throw new Error("crew_geometry_merge_failed");
      const indexed = mergeVertices(geometry);
      geometry.dispose();
      const packed = new Mesh(indexed, material);
      packed.castShadow = true;
      packed.receiveShadow = true;
      for (const mesh of meshes) {
        group.remove(mesh);
        if (mesh.name) {
          const anchor = new Group();
          anchor.name = mesh.name;
          anchor.position.copy(mesh.position);
          group.add(anchor);
        }
      }
      group.add(packed);
    }
  }
}
