import { BufferAttribute, Mesh, type BufferGeometry, type Group } from "three";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

/** Offline distance mesh: retain the complete rig and all surviving vertex attributes. */
export async function createCrewDistanceLod(source: Group): Promise<Group> {
  await MeshoptSimplifier.ready;
  let originalTriangles = 0;
  source.traverse((object) => {
    if (object instanceof Mesh)
      originalTriangles += (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3;
  });
  const ratio = Math.max(0.22, Math.min(0.25, 2500 / originalTriangles));
  const result = source.clone(true);
  const geometries = new Map<BufferGeometry, BufferGeometry>();
  result.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    let simplified = geometries.get(object.geometry);
    if (!simplified) {
      simplified = simplifyGeometry(object.geometry, ratio);
      geometries.set(object.geometry, simplified);
    }
    object.geometry = simplified;
  });
  return result;
}

function simplifyGeometry(source: BufferGeometry, ratio: number): BufferGeometry {
  const geometry = mergeVertices(source);
  const positions = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!index) throw new Error("crew_lod_requires_indexed_geometry");
  const indices = Uint32Array.from(index.array);
  const vertices = Float32Array.from({ length: positions.count * 3 }, (_, component) =>
    positions.getComponent(Math.floor(component / 3), component % 3),
  );
  const names = ["normal", "color"].filter((name) => geometry.hasAttribute(name));
  const stride = names.reduce((sum, name) => sum + geometry.getAttribute(name).itemSize, 0);
  const attributes = new Float32Array(positions.count * stride);
  const weights = names.flatMap((name) =>
    Array(geometry.getAttribute(name).itemSize).fill(name === "normal" ? 0.1 : 0.5),
  );
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let offset = vertex * stride;
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      for (let component = 0; component < attribute.itemSize; component++) {
        attributes[offset++] = attribute.getComponent(vertex, component);
      }
    }
  }
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
    indices,
    vertices,
    3,
    attributes,
    stride,
    weights,
    null,
    target,
    0.025,
    ["Permissive"],
  );
  const [remap, count] = MeshoptSimplifier.compactMesh(simplified);
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    const compact = new Float32Array(count * attribute.itemSize);
    for (let vertex = 0; vertex < remap.length; vertex++) {
      const destination = remap[vertex]!;
      if (destination === 0xffffffff) continue;
      for (let component = 0; component < attribute.itemSize; component++) {
        compact[destination * attribute.itemSize + component] = attribute.getComponent(vertex, component);
      }
    }
    geometry.setAttribute(name, new BufferAttribute(compact, attribute.itemSize));
  }
  geometry.setIndex(new BufferAttribute(simplified, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
