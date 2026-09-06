import { useI18n } from "../i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  DirectionalLight,
  LoadingManager,
  LoopOnce,
  LoopRepeat,
  Mesh,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
  type AnimationClip,
  type Group,
  type Material,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AgentStatus } from "./types";
import { useReducedCharacterMotion } from "./CharacterSprite";
import { validateCharacterGlb } from "./character-glb";

export default function CharacterModelPreview({
  url,
  status,
  fallback,
}: {
  url: string;
  status: AgentStatus;
  fallback: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clips, setClips] = useState<string[]>([]);
  const reduced = useReducedCharacterMotion();
  const statusRef = useRef(status);
  statusRef.current = status;
  const commands = useRef<{
    rotate: (amount: number) => void;
    zoom: (factor: number) => void;
    animate: () => void;
  } | null>(null);
  useEffect(() => {
    commands.current?.animate();
  }, [status]);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;
    setLoaded(false);
    setError(null);
    setClips([]);
    let disposed = false;
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let model: Group | undefined;
    let mixer: AnimationMixer | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame = 0;
    let lastTime = 0;
    let animations: AnimationClip[] = [];
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const scene = new Scene();
    const camera = new PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(2.6, 1.6, 4);
    const render = () => {
      if (!disposed) renderer?.render(scene, camera);
    };
    const releaseModel = (root: Group) => {
      root.traverse((object) => {
        if (object instanceof Mesh) {
          if (object instanceof SkinnedMesh) object.skeleton.dispose();
          object.geometry.dispose();
          const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      });
    };
    const cleanupGraphics = () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      controls?.dispose();
      mixer?.stopAllAction();
      if (model) {
        mixer?.uncacheRoot(model);
        releaseModel(model);
        model = undefined;
      }
      renderer?.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = undefined;
      commands.current = null;
      scene.clear();
      animations = [];
    };
    const fail = (cause: unknown) => {
      if (disposed) return;
      cleanupGraphics();
      setLoaded(false);
      setError(
        cause instanceof Error
          ? cause.message
          : t({ de: "Das 3D-Modell konnte nicht angezeigt werden.", en: "Could not display the 3D model." }),
      );
    };
    const animate = () => {
      if (!mixer || !model || disposed) return;
      cancelAnimationFrame(frame);
      mixer.stopAllAction();
      const clip =
        animations.find((item) => item.name === statusRef.current) ?? animations.find((item) => item.name === "idle");
      if (!clip) {
        render();
        return;
      }
      const action = mixer.clipAction(clip);
      action.reset();
      action.setLoop(
        statusRef.current === "error" ? LoopOnce : LoopRepeat,
        statusRef.current === "error" ? 1 : Infinity,
      );
      action.clampWhenFinished = true;
      action.play();
      mixer.update(0);
      render();
      if (reduced || document.visibilityState === "hidden") return;
      lastTime = performance.now();
      const tick = (time: number) => {
        if (disposed) return;
        mixer?.update(Math.min(0.1, (time - lastTime) / 1000));
        lastTime = time;
        render();
        if (action.isRunning()) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      if (document.visibilityState !== "hidden") animate();
    };
    document.addEventListener("visibilitychange", visibility);
    const contextLost = (event: Event) => {
      event.preventDefault();
      fail(
        new Error(
          t({
            de: "WebGL-Kontext verloren. Die 2D-Figur bleibt verfügbar.",
            en: "WebGL context lost. The 2D character remains available.",
          }),
        ),
      );
    };
    void (async () => {
      try {
        if (!/^\/api\/crew\/character-assets\/char_[a-f0-9]{32}$/.test(url))
          throw new Error(
            t({
              de: "Nur private, verwaltete GLB-Dateien werden angezeigt.",
              en: "Only private, managed GLB files can be displayed.",
            }),
          );
        const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok)
          throw new Error(
            t({ de: "Die private Modelldatei ist nicht erreichbar.", en: "The private model file is unavailable." }),
          );
        const buffer = await response.arrayBuffer();
        validateCharacterGlb(buffer);
        if (disposed) return;
        const manager = new LoadingManager();
        manager.setURLModifier(() => {
          throw new Error(
            t({
              de: "Zusätzliche Modelldateien und Texturen sind nicht erlaubt.",
              en: "Additional model files and textures are not allowed.",
            }),
          );
        });
        const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
        if (disposed) {
          releaseModel(gltf.scene);
          return;
        }
        model = gltf.scene;
        const bounds = new Box3().setFromObject(model);
        const size = bounds.getSize(new Vector3());
        const dimension = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(dimension) || dimension <= 0)
          throw new Error(
            t({
              de: "GLB enthält keine sichtbare, gültige Geometrie.",
              en: "The GLB contains no visible, valid geometry.",
            }),
          );
        const centre = bounds.getCenter(new Vector3());
        model.position.sub(centre);
        model.scale.multiplyScalar(2 / dimension);
        model.position.multiplyScalar(2 / dimension);
        scene.add(model, new AmbientLight(0xe3f1f1, 2.2));
        const light = new DirectionalLight(0xd9edf1, 3);
        light.position.set(3, 5, 4);
        scene.add(light);
        renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.domElement.setAttribute(
          "aria-label",
          t({ de: "Interaktive 3D-Figur", en: "Interactive 3D character" }),
        );
        renderer.domElement.setAttribute("role", "img");
        renderer.domElement.addEventListener("webglcontextlost", contextLost);
        mount.appendChild(renderer.domElement);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enablePan = false;
        controls.enableDamping = false;
        controls.minDistance = 2;
        controls.maxDistance = 8;
        controls.target.set(0, 0, 0);
        controls.update();
        controls.addEventListener("change", render);
        const resize = () => {
          if (!renderer) return;
          const width = Math.min(512, Math.max(1, mount.clientWidth));
          const height = 300;
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          render();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(mount);
        resize();
        mixer = new AnimationMixer(model);
        animations = gltf.animations;
        setClips(animations.map((clip) => clip.name));
        commands.current = {
          rotate: (amount) => {
            if (model) model.rotation.y += amount;
            render();
          },
          zoom: (factor) => {
            const distance = camera.position.length();
            const target = Math.min(8, Math.max(2, distance * factor));
            camera.position.multiplyScalar(target / distance);
            controls?.update();
            render();
          },
          animate,
        };
        setLoaded(true);
        animate();
      } catch (cause) {
        if (!disposed)
          fail(
            controller.signal.aborted
              ? new Error(
                  t({ de: "Das Laden des 3D-Modells hat zu lange gedauert.", en: "Loading the 3D model timed out." }),
                )
              : cause,
          );
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", visibility);
      renderer?.domElement.removeEventListener("webglcontextlost", contextLost);
      cleanupGraphics();
    };
  }, [url, reduced, t]);

  return (
    <section className="character-model-preview" aria-label={t({ de: "3D-Modellvorschau", en: "3D model preview" })}>
      <div ref={host} className="character-model-canvas" hidden={!!error} />
      {!loaded && !error && (
        <p role="status">{t({ de: "Private 3D-Datei wird geladen …", en: "Loading private 3D file …" })}</p>
      )}
      {error && (
        <>
          <p role="alert" className="character-editor-error">
            {error}
          </p>
          <div className="character-model-fallback">
            {fallback}
            <p>{t({ de: "2D-Ersatzdarstellung", en: "2D fallback view" })}</p>
          </div>
        </>
      )}
      <div className="character-model-controls" role="group" aria-label={t({ de: "3D-Kamera", en: "3D camera" })}>
        <button className="ic-btn" type="button" disabled={!loaded} onClick={() => commands.current?.rotate(-0.3)}>
          {t({ de: "Nach links drehen", en: "Rotate left" })}{" "}
        </button>
        <button className="ic-btn" type="button" disabled={!loaded} onClick={() => commands.current?.rotate(0.3)}>
          {t({ de: "Nach rechts drehen", en: "Rotate right" })}{" "}
        </button>
        <button className="ic-btn" type="button" disabled={!loaded} onClick={() => commands.current?.zoom(0.85)}>
          {t({ de: "Vergrößern", en: "Zoom in" })}{" "}
        </button>
        <button className="ic-btn" type="button" disabled={!loaded} onClick={() => commands.current?.zoom(1.15)}>
          {t({ de: "Verkleinern", en: "Zoom out" })}{" "}
        </button>
      </div>
      {loaded && (
        <p className="character-editor-hint">
          {reduced
            ? t({ de: "Bewegung reduziert: Animation pausiert.", en: "Reduced motion: animation paused." })
            : clips.includes(status) || clips.includes("idle")
              ? t({
                  de: `Status-Animation: ${clips.includes(status) ? status : "idle"}.`,
                  en: `Status animation: ${clips.includes(status) ? status : "idle"}.`,
                })
              : t({
                  de: "Kein passender Animationsclip: statische Darstellung.",
                  en: "No matching animation clip: static view.",
                })}{" "}
          {t({
            de: "Das Büro verwendet weiterhin die 2D-Figur.",
            en: "The office continues to use the 2D character.",
          })}{" "}
        </p>
      )}
    </section>
  );
}
