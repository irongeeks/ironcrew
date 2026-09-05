import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import { OfficeMotionEngine, type OfficeGraph, type OfficeMotionSubject } from "./office-motion";

interface Options {
  graph: OfficeGraph;
  subjects: readonly OfficeMotionSubject[];
  paused?: boolean;
  enabled?: boolean;
  viewport?: { x: number; y: number; width: number; height: number };
}
interface Registration {
  node: HTMLDivElement;
  dispose: () => void;
  isHeld: () => boolean;
}

/** DOM-only animation: no React renders, network calls or business events per frame. */
export function useOfficeMotion({ graph, subjects, paused = false, enabled = true, viewport }: Options): {
  refFor: (id: string) => RefCallback<HTMLDivElement>;
} {
  const engineRef = useRef<OfficeMotionEngine | null>(null);
  if (!engineRef.current) engineRef.current = new OfficeMotionEngine(graph, subjects);
  const graphKey = useRef(JSON.stringify(graph));
  const inputs = useRef({ paused, enabled, viewport });
  inputs.current = { paused, enabled, viewport };
  const registrations = useRef(new Map<string, Registration>());
  const callbacks = useRef(new Map<string, RefCallback<HTMLDivElement>>());
  const repaint = useCallback(() => {
    for (const [id, frame] of engineRef.current!.read()) {
      const node = registrations.current.get(id)?.node;
      if (!node) continue;
      const bounds = inputs.current.viewport;
      const clipped =
        !!bounds &&
        (frame.x < bounds.x ||
          frame.x > bounds.x + bounds.width ||
          frame.y < bounds.y ||
          frame.y > bounds.y + bounds.height);
      if (node.inert !== clipped) node.inert = clipped;
      if (clipped) {
        if (node.getAttribute("aria-hidden") !== "true") node.setAttribute("aria-hidden", "true");
      } else node.removeAttribute("aria-hidden");
      const x = String(Math.round(frame.x * 100) / 100);
      const y = String(Math.round(frame.y * 100) / 100);
      if (node.style.getPropertyValue("--office-x") !== x) node.style.setProperty("--office-x", x);
      if (node.style.getPropertyValue("--office-y") !== y) node.style.setProperty("--office-y", y);
      if (node.dataset.motion !== frame.phase) node.dataset.motion = frame.phase;
      if (node.dataset.facing !== frame.facing) node.dataset.facing = frame.facing;
      if (frame.paused) node.dataset.motionPaused = "true";
      else delete node.dataset.motionPaused;
    }
  }, []);
  const refFor = useCallback(
    (id: string): RefCallback<HTMLDivElement> => {
      let callback = callbacks.current.get(id);
      if (!callback) {
        callback = (node) => {
          registrations.current.get(id)?.dispose();
          registrations.current.delete(id);
          engineRef.current!.setFocused(id, false);
          if (!node) return;
          const originalInert = node.inert;
          const originalAriaHidden = node.getAttribute("aria-hidden");
          let hovered = false;
          let focused = node.contains(document.activeElement);
          const hold = () => {
            engineRef.current!.setFocused(id, hovered || focused);
            repaint();
          };
          const enter = () => {
            hovered = true;
            hold();
          };
          const leave = () => {
            hovered = false;
            hold();
          };
          const focus = () => {
            focused = true;
            hold();
          };
          const blur = (event: FocusEvent) => {
            if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
            focused = false;
            hold();
          };
          node.addEventListener("pointerenter", enter);
          node.addEventListener("pointerleave", leave);
          node.addEventListener("focusin", focus);
          node.addEventListener("focusout", blur);
          registrations.current.set(id, {
            node,
            isHeld: () => hovered || focused,
            dispose: () => {
              node.removeEventListener("pointerenter", enter);
              node.removeEventListener("pointerleave", leave);
              node.removeEventListener("focusin", focus);
              node.removeEventListener("focusout", blur);
              node.inert = originalInert;
              if (originalAriaHidden === null) node.removeAttribute("aria-hidden");
              else node.setAttribute("aria-hidden", originalAriaHidden);
            },
          });
          hold();
        };
        callbacks.current.set(id, callback);
      }
      return callback;
    },
    [repaint],
  );

  const control = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const nextKey = JSON.stringify(graph);
    if (graphKey.current !== nextKey) {
      graphKey.current = nextKey;
      engineRef.current = new OfficeMotionEngine(graph, subjects);
    } else engineRef.current!.sync(subjects);
    for (const [id, registration] of registrations.current) engineRef.current!.setFocused(id, registration.isHeld());
    for (const id of callbacks.current.keys())
      if (!subjects.some((subject) => subject.id === id)) callbacks.current.delete(id);
    control.current();
    repaint();
  }, [graph, subjects, paused, enabled, viewport, repaint]);

  useLayoutEffect(() => {
    let active = true;
    let frameId: number | null = null;
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const tick = (timestamp: number) => {
      frameId = null;
      if (!active) return;
      engineRef.current!.advance(timestamp);
      repaint();
      frameId = requestAnimationFrame(tick);
    };
    const syncPause = () => {
      const stop =
        inputs.current.paused || !inputs.current.enabled || document.visibilityState === "hidden" || !!media?.matches;
      engineRef.current!.setPaused(stop);
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      if (active && !stop) frameId = requestAnimationFrame(tick);
      repaint();
    };
    control.current = syncPause;
    document.addEventListener("visibilitychange", syncPause);
    media?.addEventListener("change", syncPause);
    syncPause();
    return () => {
      active = false;
      control.current = () => {};
      if (frameId !== null) cancelAnimationFrame(frameId);
      document.removeEventListener("visibilitychange", syncPause);
      media?.removeEventListener("change", syncPause);
    };
  }, [repaint]);
  return { refFor };
}
