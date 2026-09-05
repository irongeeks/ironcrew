import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentStatus, CharacterAnimationConfig } from "./types";

export interface SpriteClip {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export function spriteFrameAt(elapsedMs: number, clip: SpriteClip, reducedMotion = false): number {
  if (reducedMotion || clip.frames <= 1) return 0;
  const frame = Math.floor((Math.max(0, elapsedMs) * clip.fps) / 1000);
  return clip.loop ? frame % clip.frames : Math.min(frame, clip.frames - 1);
}

export function useReducedCharacterMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return reduced;
}

/** Playback is isolated to this SVG leaf. Frame changes never rerender the office. */
export function CharacterSprite({
  config,
  status,
  fallback,
  onError,
}: {
  config: CharacterAnimationConfig;
  status: AgentStatus;
  fallback: ReactNode;
  onError: () => void;
}): React.JSX.Element {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const viewport = useRef<SVGSVGElement>(null);
  const reducedMotion = useReducedCharacterMotion();
  const clip = config.states[status] ?? config.states.idle;
  const row = clip?.row ?? 0;
  const frames = clip?.frames ?? 0;
  const fps = clip?.fps ?? 1;
  const loop = clip?.loop ?? false;
  const requiredRows = Math.max(0, ...Object.values(config.states).map((state) => state?.row ?? 0)) + 1;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let active = true;
    const source = new Image();
    source.onload = () => {
      if (!active) return;
      const fits =
        requiredRows * config.frameHeight <= source.naturalHeight &&
        config.columns * config.frameWidth <= source.naturalWidth;
      if (!fits) {
        onErrorRef.current();
        return;
      }
      setImage({ url: config.url, width: source.naturalWidth, height: source.naturalHeight });
    };
    source.onerror = () => {
      if (active) onErrorRef.current();
    };
    source.src = config.url;
    return () => {
      active = false;
      source.onload = null;
      source.onerror = null;
    };
  }, [config.url, config.frameWidth, config.frameHeight, config.columns, requiredRows]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || frames < 1 || image?.url !== config.url) return;
    const effectiveClip = { row, frames, fps, loop: status !== "error" && loop };
    let frameRequest = 0;
    let started: number | null = null;
    const show = (index: number) => {
      element.setAttribute(
        "viewBox",
        `${index * config.frameWidth} ${row * config.frameHeight} ${config.frameWidth} ${config.frameHeight}`,
      );
      element.dataset.spriteFrame = String(index);
    };
    show(0);
    const tick = (timestamp: number) => {
      started ??= timestamp;
      const frame = spriteFrameAt(timestamp - started, effectiveClip, reducedMotion);
      show(frame);
      if (effectiveClip.loop || frame < effectiveClip.frames - 1) frameRequest = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frameRequest);
      started = null;
      if (!reducedMotion && frames > 1 && document.visibilityState !== "hidden")
        frameRequest = requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") cancelAnimationFrame(frameRequest);
      else start();
    };
    start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frameRequest);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [row, frames, fps, loop, status, config.url, config.frameWidth, config.frameHeight, image, reducedMotion]);

  if (!clip || image?.url !== config.url) return <g>{fallback}</g>;
  return (
    <svg
      ref={viewport}
      x="0"
      y="-8"
      width="72"
      height="98"
      viewBox={`0 ${clip.row * config.frameHeight} ${config.frameWidth} ${config.frameHeight}`}
      preserveAspectRatio="xMidYMax meet"
      overflow="hidden"
      data-sprite-state={config.states[status] ? status : "idle"}
      data-sprite-frame="0"
      data-reduced-motion={reducedMotion || undefined}
    >
      <image href={config.url} width={image.width} height={image.height} onError={onError} />
    </svg>
  );
}
