import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfficeMotion } from "./useOfficeMotion";
import type { OfficeGraph, OfficeMotionSubject } from "./office-motion";

const graph: OfficeGraph = {
  nodes: { home: { x: 10, y: 20 }, door: { x: 10, y: 120 }, coffee: { x: 80, y: 120 } },
  edges: [
    ["home", "door"],
    ["door", "coffee"],
  ],
  destinations: [{ id: "coffee", nodeId: "coffee", kind: "coffee" }],
};
const subjects: OfficeMotionSubject[] = [{ id: "Ada", status: "idle", homeNodeId: "home", anchor: graph.nodes.home }];
let callbacks: Map<number, FrameRequestCallback>;
let media: MediaQueryList;
let hidden: boolean;
function Harness({
  paused = false,
  enabled = true,
  people = subjects,
  viewport,
}: {
  paused?: boolean;
  enabled?: boolean;
  people?: OfficeMotionSubject[];
  viewport?: { x: number; y: number; width: number; height: number };
}) {
  const { refFor } = useOfficeMotion({ graph, subjects: people, paused, enabled, viewport });
  return (
    <div ref={refFor("Ada")} data-testid="actor">
      <button>Agent öffnen</button>
    </div>
  );
}
function tick(timestamp: number) {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  });
}
const position = (node: HTMLElement) => [
  node.style.getPropertyValue("--office-x"),
  node.style.getPropertyValue("--office-y"),
];
beforeEach(() => {
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  media = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList;
  vi.stubGlobal("matchMedia", () => media);
  callbacks = new Map();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("office motion DOM driver", () => {
  it("removes clipped actors from navigation, restores visitors on entry and cleans viewport state", () => {
    const viewport = { x: 0, y: 100, width: 100, height: 50 };
    const { rerender, unmount } = render(<Harness viewport={viewport} />);
    const actor = screen.getByTestId("actor");
    expect(actor.inert).toBe(true);
    expect(actor).toHaveAttribute("aria-hidden", "true");
    tick(0);
    tick(30000);
    tick(34000);
    expect(actor.inert).toBe(false);
    expect(actor).not.toHaveAttribute("aria-hidden");
    const visited = position(actor);
    rerender(<Harness viewport={{ x: 300, y: 300, width: 100, height: 100 }} />);
    expect(position(actor)).toEqual(visited);
    expect(actor.inert).toBe(true);
    rerender(<Harness />);
    expect(actor.inert).toBe(false);
    expect(actor).not.toHaveAttribute("aria-hidden");
    rerender(<Harness viewport={{ x: 300, y: 300, width: 100, height: 100 }} />);
    unmount();
    expect(actor.inert).toBeFalsy();
    expect(actor).not.toHaveAttribute("aria-hidden");
  });

  it("writes the anchor immediately, uses frame refs and holds actors under keyboard or pointer focus", () => {
    render(<Harness />);
    const actor = screen.getByTestId("actor");
    expect(position(actor)).toEqual(["10", "20"]);
    tick(0);
    tick(30000);
    tick(31000);
    expect(position(actor)).not.toEqual(["10", "20"]);
    fireEvent.focusIn(screen.getByRole("button"));
    const focused = position(actor);
    tick(32000);
    expect(position(actor)).toEqual(focused);
    expect(actor).toHaveAttribute("data-motion-paused", "true");
    fireEvent.pointerEnter(actor);
    fireEvent.focusOut(screen.getByRole("button"));
    tick(33000);
    expect(position(actor)).toEqual(focused);
    fireEvent.pointerLeave(actor);
    tick(34000);
    expect(position(actor)).not.toEqual(focused);
  });
  it("stops animation for user pause, reduced motion and hidden tabs, without a resume leap", () => {
    const { rerender } = render(<Harness />);
    const actor = screen.getByTestId("actor");
    tick(0);
    tick(30000);
    tick(31000);
    rerender(<Harness paused />);
    const frozen = position(actor);
    expect(callbacks.size).toBe(0);
    expect(actor).toHaveAttribute("data-motion-paused", "true");
    rerender(<Harness />);
    tick(900000);
    expect(position(actor)).toEqual(frozen);
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(callbacks.size).toBe(0);
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(callbacks.size).toBe(1);
    Object.defineProperty(media, "matches", { value: true, configurable: true });
    act(() => media.dispatchEvent(new Event("change")));
    expect(callbacks.size).toBe(0);
    expect(position(actor)).toEqual(frozen);
  });
  it("preempts immediately while paused and cleans frame, focus and visibility listeners on unmount", () => {
    const { rerender, unmount } = render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(callbacks.size).toBe(1);
    tick(0);
    tick(30000);
    tick(31000);
    rerender(
      <StrictMode>
        <Harness paused people={[{ ...subjects[0], status: "working", anchor: { x: 400, y: 300 } }]} />
      </StrictMode>,
    );
    const actor = screen.getByTestId("actor");
    expect(position(actor)).toEqual(["400", "300"]);
    expect(actor).toHaveAttribute("data-motion", "resting");
    unmount();
    expect(callbacks.size).toBe(0);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      media.dispatchEvent(new Event("change"));
    });
    fireEvent.pointerEnter(actor);
    expect(callbacks.size).toBe(0);
  });
});
