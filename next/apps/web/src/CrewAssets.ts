import { useEffect, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Group } from "three";
import { createCrewModel, crewKeys } from "./CrewModel.ts";
import manifest from "../public/crew/manifest.json" with { type: "json" };
// Only bundled, self-contained, checksum-matched GLBs enter the renderer.
type AssetReference = { url: string; sha256: string; byteLength: number };
async function loadAsset(entry: AssetReference) {
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
type CrewAsset = { full: Group; distant?: Group };
let cached: Promise<CrewAsset[]> | undefined;
export function useCrewAssets() {
  const [loaded, setLoaded] = useState<CrewAsset[]>([]);
  useEffect(() => {
    let active = true;
    cached ??= Promise.all(
      crewKeys.map(async (key, index) => {
        const entry = manifest.models.find((model) => model.seedKey === key);
        const full = entry
          ? await loadAsset(entry).catch(() => {
              const fallback = createCrewModel(index);
              fallback.userData.fallback = true;
              return fallback;
            })
          : createCrewModel(index);
        const lod = entry?.lod;
        const distant = lod ? await loadAsset(lod).catch(() => undefined) : undefined;
        return { full, distant };
      }),
    );
    void cached.then((value) => {
      if (active) setLoaded(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return {
    assets: loaded.map((item) => item.full),
    distantAssets: loaded.map((item) => item.distant),
    state: loaded.length
      ? loaded.every((asset) => !asset.full.userData.fallback)
        ? "verified"
        : "fallback"
      : "loading",
  };
}
