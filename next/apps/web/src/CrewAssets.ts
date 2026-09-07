import { useEffect, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Group } from "three";
import { createCrewModel, crewKeys } from "./CrewModel.ts";
import manifest from "../public/crew/manifest.json" with { type: "json" };
// Only bundled, self-contained, checksum-matched GLBs enter the renderer.
async function loadAsset(entry: (typeof manifest.models)[number]) {
  if (!/^\/crew\/[a-z-]+\.glb$/.test(entry.url) || entry.byteLength > 2000000)
    throw new Error("asset_manifest_invalid");
  const response = await fetch(entry.url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("asset_unavailable");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.byteLength) throw new Error("asset_size_mismatch");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== entry.sha256) throw new Error("asset_checksum_mismatch");
  const view = new DataView(bytes);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error("asset_glb_invalid");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))));
  // No external buffers/images or extension-provided resource loaders.
  if (
    json.extensionsUsed?.length ||
    json.buffers?.some((buffer: { uri?: string }) => buffer.uri) ||
    json.images?.some((image: { uri?: string }) => image.uri)
  )
    throw new Error("asset_external_resource_denied");
  return (await new GLTFLoader().parseAsync(bytes, "")).scene;
}
let cached: Promise<(Group | undefined)[]> | undefined;
export function useCrewAssets() {
  const [assets, setAssets] = useState<(Group | undefined)[]>([]);
  useEffect(() => {
    let active = true;
    cached ??= Promise.all(
      crewKeys.map((key, index) => {
        const entry = manifest.models.find((model) => model.seedKey === key);
        return entry
          ? loadAsset(entry).catch(() => {
              const fallback = createCrewModel(index);
              fallback.userData.fallback = true;
              return fallback;
            })
          : Promise.resolve(createCrewModel(index));
      }),
    );
    void cached.then((value) => {
      if (active) setAssets(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return {
    assets,
    state: assets.length
      ? assets.every((asset) => asset && !asset.userData.fallback)
        ? "verified"
        : "fallback"
      : "loading",
  };
}
