import { z } from "zod";

const index = z.number().int().nonnegative().max(10000);
const finite = z.number().finite().min(-1e9).max(1e9);
const name = z.string().max(160).optional();
const accessor = z
  .object({
    name,
    bufferView: index,
    byteOffset: index.optional(),
    componentType: z.union([
      z.literal(5120),
      z.literal(5121),
      z.literal(5122),
      z.literal(5123),
      z.literal(5125),
      z.literal(5126),
    ]),
    count: z.number().int().positive().max(100000),
    type: z.enum(["SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4"]),
    normalized: z.boolean().optional(),
    min: z.array(finite).max(16).optional(),
    max: z.array(finite).max(16).optional(),
  })
  .strict();
const attributes = z.record(
  z.string().regex(/^(POSITION|NORMAL|TANGENT|TEXCOORD_[01]|COLOR_0|JOINTS_0|WEIGHTS_0)$/),
  index,
);
const documentSchema = z
  .object({
    asset: z
      .object({
        version: z.literal("2.0"),
        minVersion: z.literal("2.0").optional(),
        generator: z.string().max(256).optional(),
        copyright: z.string().max(1024).optional(),
      })
      .strict(),
    scene: index.optional(),
    scenes: z
      .array(z.object({ name, nodes: z.array(index).max(256) }).strict())
      .min(1)
      .max(8),
    buffers: z
      .array(
        z
          .object({
            name,
            byteLength: z
              .number()
              .int()
              .positive()
              .max(5 * 1024 * 1024),
          })
          .strict(),
      )
      .length(1),
    bufferViews: z
      .array(
        z
          .object({
            name,
            buffer: z.literal(0),
            byteOffset: z
              .number()
              .int()
              .nonnegative()
              .max(5 * 1024 * 1024)
              .optional(),
            byteLength: z
              .number()
              .int()
              .positive()
              .max(5 * 1024 * 1024),
            byteStride: z.number().int().min(4).max(252).multipleOf(4).optional(),
            target: z.union([z.literal(34962), z.literal(34963)]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2048),
    accessors: z.array(accessor).min(1).max(2048),
    meshes: z
      .array(
        z
          .object({
            name,
            weights: z.array(finite).max(8).optional(),
            primitives: z
              .array(
                z
                  .object({
                    attributes,
                    indices: index.optional(),
                    material: index.optional(),
                    mode: z.literal(4).optional(),
                    targets: z.array(attributes).max(8).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(32),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    nodes: z
      .array(
        z
          .object({
            name,
            mesh: index.optional(),
            skin: index.optional(),
            children: z.array(index).max(64).optional(),
            translation: z.tuple([finite, finite, finite]).optional(),
            rotation: z.tuple([finite, finite, finite, finite]).optional(),
            scale: z.tuple([finite, finite, finite]).optional(),
            matrix: z.array(finite).length(16).optional(),
            weights: z.array(finite).max(8).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    materials: z
      .array(
        z
          .object({
            name,
            pbrMetallicRoughness: z
              .object({
                baseColorFactor: z.array(z.number().min(0).max(1)).length(4).optional(),
                metallicFactor: z.number().min(0).max(1).optional(),
                roughnessFactor: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            emissiveFactor: z.array(z.number().min(0).max(1)).length(3).optional(),
            alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).optional(),
            alphaCutoff: z.number().min(0).max(1).optional(),
            doubleSided: z.boolean().optional(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    skins: z
      .array(
        z
          .object({
            name,
            inverseBindMatrices: index.optional(),
            skeleton: index.optional(),
            joints: z.array(index).min(1).max(128),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    animations: z
      .array(
        z
          .object({
            name,
            samplers: z
              .array(
                z
                  .object({
                    input: index,
                    output: index,
                    interpolation: z.enum(["LINEAR", "STEP", "CUBICSPLINE"]).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
            channels: z
              .array(
                z
                  .object({
                    sampler: index,
                    target: z.object({ node: index, path: z.enum(["translation", "rotation", "scale"]) }).strict(),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function assert(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid or excessive GLB resource");
}
function referenced<T>(items: T[] | undefined, id: number): T {
  const value = items?.[id];
  assert(value !== undefined);
  return value;
}

/** Strict glTF2 subset: embedded uncompressed triangle geometry, solid materials and bounded skeletal clips.
 * No URIs, textures, extensions, sparse accessors, scripts or compressed resources are accepted.
 */
export function validateCharacterGlb(source: Buffer): {
  buffer: Buffer;
  metadata: { clips: Array<{ index: number; name: string }>; vertices: number; nodes: number };
} {
  assert(source.length >= 28 && source.length <= 5 * 1024 * 1024 && source.readUInt32LE(0) === 0x46546c67);
  assert(source.readUInt32LE(4) === 2 && source.readUInt32LE(8) === source.length);
  const jsonSize = source.readUInt32LE(12);
  assert(jsonSize > 0 && jsonSize <= 1024 * 1024 && jsonSize % 4 === 0 && source.readUInt32LE(16) === 0x4e4f534a);
  const binHeader = 20 + jsonSize;
  assert(binHeader + 8 <= source.length && source.readUInt32LE(binHeader + 4) === 0x004e4942);
  const binSize = source.readUInt32LE(binHeader);
  assert(binSize % 4 === 0 && binHeader + 8 + binSize === source.length);
  const doc = documentSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(20, binHeader)).trim()),
  );
  const binary = source.subarray(binHeader + 8);
  assert(doc.buffers[0].byteLength <= binSize && binSize - doc.buffers[0].byteLength <= 3);
  assert((doc.scene ?? 0) < doc.scenes.length);
  let elements = 0;
  for (const view of doc.bufferViews) assert((view.byteOffset ?? 0) + view.byteLength <= doc.buffers[0].byteLength);
  for (const a of doc.accessors) {
    const view = referenced(doc.bufferViews, a.bufferView);
    const elementBytes = bytes[a.componentType] * components[a.type];
    // Packed integer matrices need additional glTF alignment rules; use float matrices only.
    assert(!a.type.startsWith("MAT") || a.componentType === 5126);
    const stride = view.byteStride ?? elementBytes;
    assert(stride >= elementBytes && stride % bytes[a.componentType] === 0);
    assert((a.byteOffset ?? 0) % bytes[a.componentType] === 0);
    assert((a.byteOffset ?? 0) + (a.count - 1) * stride + elementBytes <= view.byteLength);
    elements += a.count * components[a.type];
    assert(elements <= 2_000_000);
    if (a.componentType === 5126) {
      for (let i = 0; i < a.count; i++)
        for (let c = 0; c < components[a.type]; c++) {
          const value = binary.readFloatLE((view.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * stride + c * 4);
          assert(Number.isFinite(value) && Math.abs(value) <= 1e9);
        }
    }
  }
  let vertices = 0;
  for (const mesh of doc.meshes)
    for (const primitive of mesh.primitives) {
      const position = referenced(doc.accessors, primitive.attributes.POSITION);
      assert(position.type === "VEC3" && position.componentType === 5126);
      vertices += position.count;
      assert(vertices <= 250000);
      for (const ref of Object.values(primitive.attributes))
        assert(referenced(doc.accessors, ref).count === position.count);
      if (primitive.indices !== undefined) {
        const a = referenced(doc.accessors, primitive.indices);
        assert(a.type === "SCALAR" && [5121, 5123, 5125].includes(a.componentType) && a.count % 3 === 0);
        const view = referenced(doc.bufferViews, a.bufferView);
        const step = view.byteStride ?? bytes[a.componentType];
        for (let i = 0; i < a.count; i++) {
          const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * step;
          const vertex =
            a.componentType === 5121
              ? binary.readUInt8(offset)
              : a.componentType === 5123
                ? binary.readUInt16LE(offset)
                : binary.readUInt32LE(offset);
          assert(vertex < position.count);
        }
      } else assert(position.count % 3 === 0);
      if (primitive.material !== undefined) referenced(doc.materials, primitive.material);
      for (const target of primitive.targets ?? [])
        for (const ref of Object.values(target)) assert(referenced(doc.accessors, ref).count === position.count);
    }
  let renderedVertices = 0;
  const parentCounts = new Map<number, number>();
  for (const node of doc.nodes) {
    assert(!node.matrix || (!node.translation && !node.rotation && !node.scale));
    if (node.mesh !== undefined) {
      const mesh = referenced(doc.meshes, node.mesh);
      for (const primitive of mesh.primitives)
        renderedVertices += referenced(doc.accessors, primitive.attributes.POSITION).count;
    }
    assert(renderedVertices <= 500000);
    if (node.skin !== undefined) referenced(doc.skins, node.skin);
    for (const child of node.children ?? []) {
      referenced(doc.nodes, child);
      const n = (parentCounts.get(child) ?? 0) + 1;
      assert(n === 1);
      parentCounts.set(child, n);
    }
  }
  const visiting = new Set<number>();
  const done = new Set<number>();
  const visit = (id: number, depth: number) => {
    assert(depth <= 32 && !visiting.has(id));
    if (done.has(id)) return;
    visiting.add(id);
    for (const child of referenced(doc.nodes, id).children ?? []) visit(child, depth + 1);
    visiting.delete(id);
    done.add(id);
  };
  doc.nodes.forEach((_node, id) => visit(id, 0));
  for (const scene of doc.scenes) for (const id of scene.nodes) referenced(doc.nodes, id);
  for (const skin of doc.skins ?? []) {
    for (const joint of skin.joints) referenced(doc.nodes, joint);
    if (skin.skeleton !== undefined) referenced(doc.nodes, skin.skeleton);
    if (skin.inverseBindMatrices !== undefined) {
      const a = referenced(doc.accessors, skin.inverseBindMatrices);
      assert(a.type === "MAT4" && a.componentType === 5126 && a.count >= skin.joints.length);
    }
  }
  let animationElements = 0;
  for (const animation of doc.animations ?? [])
    for (const channel of animation.channels) {
      referenced(doc.nodes, channel.target.node);
      const sampler = referenced(animation.samplers, channel.sampler);
      const input = referenced(doc.accessors, sampler.input);
      const output = referenced(doc.accessors, sampler.output);
      assert(input.type === "SCALAR" && input.componentType === 5126 && output.componentType === 5126);
      assert(output.type === (channel.target.path === "rotation" ? "VEC4" : "VEC3"));
      assert(output.count === input.count * (sampler.interpolation === "CUBICSPLINE" ? 3 : 1));
      animationElements += output.count * components[output.type];
      assert(animationElements <= 500000);
      const view = referenced(doc.bufferViews, input.bufferView);
      let last = -1;
      for (let i = 0; i < input.count; i++) {
        const value = binary.readFloatLE((view.byteOffset ?? 0) + (input.byteOffset ?? 0) + i * (view.byteStride ?? 4));
        assert(value >= 0 && value > last && value <= 3600);
        last = value;
      }
    }
  // Rebuild JSON to remove generator/copyright and trailing input data. No unknown fields survive schema validation.
  doc.asset = { version: "2.0" };
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(result, 28 + padded.length);
  return {
    buffer: result,
    metadata: {
      clips: (doc.animations ?? []).map((clip, i) => ({ index: i, name: clip.name || `Animation ${i + 1}` })),
      vertices,
      nodes: doc.nodes.length,
    },
  };
}
