/** Deterministic repository-authored articulated GLBs; original visual specification stays authoritative. */
import { Mesh } from "three";
import { createCrewDistanceLod } from "./crew-lod.ts";
import { createCrewModel, crewNames, crewKeys, crewFeatures } from "../src/CrewModel.ts";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
class NodeBlobReader {
  result: ArrayBuffer | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
}
Object.defineProperty(globalThis, "FileReader", { value: NodeBlobReader });
const directory = new URL("../public/crew/", import.meta.url);
await mkdir(directory, { recursive: true });
const models = [];
for (const [index, id] of crewNames.entries()) {
  const scene = createCrewModel(index),
    array = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
  if (!(array instanceof ArrayBuffer)) throw new Error("Binary GLB export required");
  const bytes = Buffer.from(array);
  await writeFile(new URL(`${id}.glb`, directory), bytes);
  const lodScene = await createCrewDistanceLod(scene);
  const lodArray = await new GLTFExporter().parseAsync(lodScene, { binary: true, onlyVisible: true });
  if (!(lodArray instanceof ArrayBuffer)) throw new Error("Binary distance GLB export required");
  const lodBytes = Buffer.from(lodArray);
  await writeFile(new URL(`${id}-lod.glb`, directory), lodBytes);
  models.push({
    id,
    seedKey: crewKeys[index],
    features: crewFeatures[index],
    url: `/crew/${id}.glb`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    lod: {
      url: `/crew/${id}-lod.glb`,
      sha256: createHash("sha256").update(lodBytes).digest("hex"),
      byteLength: lodBytes.length,
    },
  });
  lodScene.traverse((item) => {
    if (item instanceof Mesh) item.geometry.dispose();
  });
  scene.traverse((item) => {
    if (item instanceof Mesh) {
      item.geometry.dispose();
      const materials = Array.isArray(item.material) ? item.material : [item.material];
      materials.forEach((material) => material.dispose());
    }
  });
}
const manifestPath = fileURLToPath(new URL("manifest.json", directory));
await writeFile(
  manifestPath,
  await format(
    JSON.stringify({
      version: 2,
      modelRevision: 3,
      provenance: "repository-authored-articulated-characters-with-cc0-anatomy",
      anatomyLicense: "/crew/LICENSE-HEAD-CC0.md",
      visualApproval: "requires-owner-review",
      finalApproved: false,
      models,
    }),
    { ...(await resolveConfig(manifestPath)), filepath: manifestPath },
  ),
);
console.log(
  `Exported ${models.length} articulated crew GLBs (${models.reduce((sum, item) => sum + item.byteLength, 0)} bytes)`,
);
