export const triangleDocument = () => ({
  asset: { version: "2.0", generator: "discard-me" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
});
export function triangleBinary() {
  const binary = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => binary.writeFloatLE(n, i * 4));
  return binary;
}
export function packGlb(document: Record<string, unknown> = triangleDocument(), binary = triangleBinary()) {
  const source = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32);
  source.copy(json);
  const output = Buffer.alloc(28 + json.length + binary.length);
  output.writeUInt32LE(0x46546c67);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  output.writeUInt32LE(binary.length, 20 + json.length);
  output.writeUInt32LE(0x004e4942, 24 + json.length);
  binary.copy(output, 28 + json.length);
  return output;
}
