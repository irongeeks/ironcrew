/** Adapted CC0 MakeHuman graphical data; attribution and pinned provenance ship with the assets. */
import { BufferGeometry, Color, Float32BufferAttribute, Ray, Vector3 } from "three";
import head from "./assets/crew-head.json" with { type: "json" };
export function createHeadGeometry(index: number, skin: string) {
  const female = index === 0 || index === 6,
    broad = index === 2 || index === 8;
  const positions: number[] = [],
    colors: number[] = [];
  const base = new Color(skin),
    lip = new Color(female ? "#a66f65" : "#986c57"),
    beard = new Color(index === 3 ? "#76786f" : "#493c31");
  for (let i = 0; i < head.positions.length; i += 3) {
    let x = head.positions[i]! * 0.28,
      z = (head.positions[i + 2]! - 0.18) * 0.28;
    const y = (head.positions[i + 1]! - 0.5) * 0.28,
      jaw = Math.exp(-(((y + 0.064) / 0.052) ** 2));
    x *= 1 + jaw * (broad ? 0.09 : female ? -0.065 : index === 4 ? 0.055 : 0);
    if (index === 5) z += 0.003 * Math.exp(-(((y + 0.077) / 0.023) ** 2));
    if (index === 7) x *= 0.965;
    x *= 1 - Math.max(0, Math.min(1, (-y - 0.1) / 0.04)) * 0.32;
    if (y < -0.1) {
      const radius = Math.hypot(x / 0.046, z / 0.049),
        blend = Math.min(1, (-y - 0.1) / 0.025);
      if (radius > 1) {
        x *= 1 - blend + blend / radius;
        z *= 1 - blend + blend / radius;
      }
    }
    positions.push(x, y, z);
    const front = Math.max(0, Math.min(1, (z - 0.045) / 0.035));
    const lipMask = Math.exp(-((x / 0.027) ** 6) - ((y + 0.057) / 0.009) ** 4) * front;
    const cheek = Math.exp(-(((Math.abs(x) - 0.045) / 0.023) ** 2) - ((y + 0.025) / 0.028) ** 2) * front;
    const color = base.clone().lerp(lip, lipMask * 0.5 + cheek * 0.08);
    if ([1, 3, 4, 7].includes(index)) {
      const lowerFace = Math.max(0, Math.min(1, (-y - 0.041) / 0.038));
      const stubble =
        lowerFace *
        front *
        (1 - lipMask) *
        (index === 4 ? 0.85 : index === 3 ? 0.24 : 0.65) *
        Math.exp(-(((y + 0.065) / 0.042) ** 4));
      color.lerp(beard, stubble);
    }
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(head.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Clip along a continuous hairline on the actual sculpt instead of a faceted face selection. */
export function createHairGeometry(face: BufferGeometry, index: number) {
  const source = face.getAttribute("position"),
    normals = face.getAttribute("normal");
  type Vertex = { p: [number, number, number]; n: [number, number, number]; d: number };
  const vertices: number[] = [],
    normalValues: number[] = [];
  const vertex = (i: number): Vertex => {
    const x = source.getX(i),
      y = source.getY(i),
      z = source.getZ(i);
    const front = Math.max(0, Math.min(1, (z + 0.018) / 0.085));
    const hairline =
      index === 3
        ? -0.018 + front * 0.115
        : index === 6
          ? -0.03 + front * 0.07
          : -0.028 + front * 0.088 + Math.abs(x) * 0.12;
    return { p: [x, y, z], n: [normals.getX(i), normals.getY(i), normals.getZ(i)], d: y - hairline };
  };
  for (let i = 0; i < face.index!.count; i += 3) {
    const polygon = [vertex(face.index!.getX(i)), vertex(face.index!.getX(i + 1)), vertex(face.index!.getX(i + 2))],
      clipped: Vertex[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j]!,
        b = polygon[(j + 1) % polygon.length]!;
      if (a.d >= 0) clipped.push(a);
      if (a.d >= 0 !== b.d >= 0) {
        const t = a.d / (a.d - b.d);
        clipped.push({
          p: a.p.map((v, k) => v + (b.p[k]! - v) * t) as Vertex["p"],
          n: a.n.map((v, k) => v + (b.n[k]! - v) * t) as Vertex["n"],
          d: 0,
        });
      }
    }
    for (let j = 1; j < clipped.length - 1; j++)
      for (const v of [clipped[0]!, clipped[j]!, clipped[j + 1]!]) {
        const thickness = 0.003 + (index === 4 || index === 7 ? 0.0015 * Math.sin(v.p[0] * 160 + v.p[1] * 100) : 0);
        vertices.push(...v.p.map((p, k) => p + v.n[k]! * thickness));
        normalValues.push(...v.n);
      }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normalValues, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(new Float32Array((vertices.length / 3) * 2), 2));
  return geometry;
}

/** Project detail curves onto the anatomical scalp; decorative strands cannot float above it. */
export function projectHairPoints(
  geometry: BufferGeometry,
  points: [number, number, number][],
): [number, number, number][] {
  const position = geometry.getAttribute("position"),
    center = new Vector3(0, 0.035, -0.025);
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    hit = new Vector3();
  return points.map((point) => {
    const direction = new Vector3(...point).sub(center).normalize();
    const origin = center.clone().addScaledVector(direction, 0.4),
      ray = new Ray(origin, direction.clone().negate());
    let nearest = Infinity,
      result = new Vector3(...point);
    for (let i = 0; i < geometry.index!.count; i += 3) {
      a.fromBufferAttribute(position, geometry.index!.getX(i));
      b.fromBufferAttribute(position, geometry.index!.getX(i + 1));
      c.fromBufferAttribute(position, geometry.index!.getX(i + 2));
      if (ray.intersectTriangle(a, b, c, false, hit)) {
        const distance = origin.distanceToSquared(hit);
        if (distance < nearest) {
          nearest = distance;
          result = hit.clone().addScaledVector(direction, 0.005);
        }
      }
    }
    return result.toArray() as [number, number, number];
  });
}
