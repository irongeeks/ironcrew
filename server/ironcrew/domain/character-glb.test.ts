import { describe, expect, it } from "vitest";
import { validateCharacterGlb } from "./character-glb.ts";

import { triangleDocument, triangleBinary, packGlb } from "./character-glb.fixture.ts";

describe("self-contained bounded GLB validation", () => {
  it("accepts a real embedded triangle and strips generator metadata", () => {
    const model = validateCharacterGlb(packGlb());
    expect(model.metadata).toEqual({ vertices: 3, nodes: 1, clips: [] });
    expect(model.buffer.includes(Buffer.from("discard-me"))).toBe(false);
    expect(() => validateCharacterGlb(model.buffer)).not.toThrow();
  });
  it("accepts and names bounded internal animation tracks", () => {
    const doc = triangleDocument();
    const binary = Buffer.alloc(68);
    triangleBinary().copy(binary);
    binary.writeFloatLE(0, 36);
    binary.writeFloatLE(1, 40);
    binary.writeFloatLE(1, 56);
    const model = validateCharacterGlb(
      packGlb(
        {
          ...doc,
          buffers: [{ byteLength: 68 }],
          bufferViews: [
            ...doc.bufferViews,
            { buffer: 0, byteOffset: 36, byteLength: 8 },
            { buffer: 0, byteOffset: 44, byteLength: 24 },
          ],
          accessors: [
            ...doc.accessors,
            { bufferView: 1, componentType: 5126, type: "SCALAR", count: 2 },
            { bufferView: 2, componentType: 5126, type: "VEC3", count: 2 },
          ],
          animations: [
            {
              name: "Idle",
              samplers: [{ input: 1, output: 2 }],
              channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
            },
          ],
        },
        binary,
      ),
    );
    expect(model.metadata.clips).toEqual([{ index: 0, name: "Idle" }]);
  });
  it.each([
    { buffers: [{ byteLength: 36, uri: "https://example.invalid/private" }] },
    { images: [{ uri: "data:image/png;base64,AAAA" }] },
    { extensionsUsed: ["KHR_draco_mesh_compression"] },
    { extensions: { EXT_meshopt_compression: {} } },
    { extras: { script: "alert(1)" } },
    { nodes: [{ mesh: 0, children: [0] }] },
    { accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 100001 }] },
    { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 500000 }] },
  ])("rejects remote resources, scripts, compression and malformed or excessive geometry %j", (override) => {
    expect(() => validateCharacterGlb(packGlb({ ...triangleDocument(), ...override }))).toThrow();
  });
  it("rejects trailing chunks, truncated data and non-finite vertex coordinates", () => {
    const source = packGlb();
    expect(() => validateCharacterGlb(source.subarray(0, -2))).toThrow();
    expect(() => validateCharacterGlb(Buffer.concat([source, Buffer.from("hidden")]))).toThrow();
    const bad = triangleBinary();
    bad.writeFloatLE(Number.NaN);
    expect(() => validateCharacterGlb(packGlb(triangleDocument(), bad))).toThrow();
  });
});
