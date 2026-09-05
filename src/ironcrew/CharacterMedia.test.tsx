import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterAssetManager } from "./CharacterAssetManager";
import { CharacterSprite, spriteFrameAt } from "./CharacterSprite";
import { validateCharacterGlb } from "./character-glb";
import type { CharacterAnimationConfig, CharacterAsset } from "./types";

function glb(json: Record<string, unknown>): ArrayBuffer {
  const source = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, ...json }));
  const length = Math.ceil(source.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(20 + length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(32);
  new Uint8Array(buffer, 20, source.byteLength).set(source);
  return buffer;
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded character media", () => {
  it("blocks external resources, textures, cyclic scenes and resource-heavy GLB before rendering", () => {
    expect(() => validateCharacterGlb(glb({ nodes: [{}] }))).not.toThrow();
    for (const payload of [
      { buffers: [{ uri: "https://example.invalid/secret.bin" }] },
      { images: [{ bufferView: 0 }] },
      { extensionsUsed: ["KHR_draco_mesh_compression"] },
      { nodes: [{ children: [1] }, { children: [0] }] },
      { accessors: [{ count: 1_000_001 }] },
    ]) {
      expect(() => validateCharacterGlb(glb(payload))).toThrow();
    }
    expect(() => validateCharacterGlb(new ArrayBuffer(5 * 1024 * 1024 + 1))).toThrow(/5 MiB/);
  });

  it("plays frames deterministically, stops nonlooping clips and respects reduced motion", () => {
    const clip = { row: 2, frames: 4, fps: 10, loop: true };
    expect(spriteFrameAt(250, clip)).toBe(2);
    expect(spriteFrameAt(450, clip)).toBe(0);
    expect(spriteFrameAt(800, { ...clip, loop: false })).toBe(3);
    expect(spriteFrameAt(250, clip, true)).toBe(0);
  });

  it("switches sprite rows on real status changes without restarting from equivalent live snapshots", () => {
    const images: { onload: (() => void) | null; naturalWidth: number; naturalHeight: number }[] = [];
    const imageCreated = vi.fn();
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 64;
        naturalHeight = 64;
        src = "";
        constructor() {
          images.push(this);
          imageCreated();
        }
      },
    );
    let callback: FrameRequestCallback = () => {};
    const raf = vi.fn((next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const config: CharacterAnimationConfig = {
      url: "/api/crew/character-assets/sheet",
      frameWidth: 32,
      frameHeight: 32,
      columns: 2,
      states: { idle: { row: 0, frames: 2, fps: 10, loop: true }, working: { row: 1, frames: 2, fps: 10, loop: true } },
    };
    const { container, rerender, unmount } = render(
      <svg>
        <CharacterSprite config={config} status="idle" fallback={<text>Fallback</text>} onError={vi.fn()} />
      </svg>,
    );
    act(() => images[0].onload?.());
    act(() => callback(0));
    act(() => callback(100));
    expect(container.querySelector("[data-sprite-state]")).toHaveAttribute("viewBox", "32 0 32 32");
    rerender(
      <svg>
        <CharacterSprite
          config={structuredClone(config)}
          status="idle"
          fallback={<text>Fallback</text>}
          onError={vi.fn()}
        />
      </svg>,
    );
    expect(imageCreated).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-sprite-state]")).toHaveAttribute("data-sprite-frame", "1");
    rerender(
      <svg>
        <CharacterSprite config={config} status="working" fallback={<text>Fallback</text>} onError={vi.fn()} />
      </svg>,
    );
    expect(container.querySelector("[data-sprite-state]")).toHaveAttribute("viewBox", "0 32 32 32");
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("keeps the image fallback for an invalid sprite sheet", () => {
    let finish: () => void = () => {};
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 8;
        naturalHeight = 8;
        onerror = null;
        src = "";
        set onload(value: (() => void) | null) {
          finish = value ?? (() => {});
        }
      },
    );
    const error = vi.fn();
    const config: CharacterAnimationConfig = {
      url: "/sheet",
      frameWidth: 32,
      frameHeight: 32,
      columns: 2,
      states: { idle: { row: 0, frames: 1, fps: 1, loop: false } },
    };
    render(
      <svg>
        <CharacterSprite config={config} status="idle" fallback={<text>Fallback</text>} onError={error} />
      </svg>,
    );
    act(() => finish());
    expect(error).toHaveBeenCalled();
    expect(screen.getByText("Fallback")).toBeInTheDocument();
  });

  it("requires explicit detach confirmation and reports physical deletion separately from pending cleanup", async () => {
    const asset: CharacterAsset = {
      id: "asset1",
      url: "/asset1",
      kind: "full_body",
      contentType: "image/webp",
      width: 32,
      height: 64,
      sizeBytes: 128,
      inUseBy: ["agent1"],
      status: "active",
    };
    const list = vi.fn().mockResolvedValue([asset]);
    const remove = vi.fn().mockResolvedValue({ deleted: false, pending: true, detachedAgentIds: ["agent1"] });
    const onRemoved = vi.fn();
    render(
      <CharacterAssetManager onList={list} onDelete={remove} onUse={vi.fn()} onRemoved={onRemoved} refreshKey={0} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Bürofigur asset1 löschen" }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Verknüpfungen lösen und Datei löschen" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("asset1", true));
    expect(onRemoved).toHaveBeenCalledWith(asset);
    expect(screen.getByRole("status")).toHaveTextContent("physische Löschung ist noch ausstehend");
    expect(screen.queryByText("Datei physisch gelöscht.")).not.toBeInTheDocument();
  });

  it("exposes a real reusable asset without assigning it automatically", async () => {
    const asset: CharacterAsset = {
      id: "model1",
      url: "/model1",
      kind: "model_3d",
      contentType: "model/gltf-binary",
      width: 0,
      height: 0,
      sizeBytes: 128,
    };
    const use = vi.fn();
    render(
      <CharacterAssetManager
        onList={vi.fn().mockResolvedValue([asset])}
        onDelete={vi.fn()}
        onUse={use}
        onRemoved={vi.fn()}
        refreshKey={0}
      />,
    );
    const select = await screen.findByRole("button", { name: "3D-Modell model1 auswählen" });
    expect(use).not.toHaveBeenCalled();
    fireEvent.click(select);
    expect(use).toHaveBeenCalledWith(asset);
  });
});
