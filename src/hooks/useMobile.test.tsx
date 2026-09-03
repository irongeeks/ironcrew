import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useMobile } from "./useMobile";

describe("useMobile", () => {
  let listeners: Array<(e: { matches: boolean }) => void>;
  let currentMatches: boolean;

  beforeEach(() => {
    listeners = [];
    currentMatches = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: currentMatches,
        media: query,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          listeners.push(cb);
        },
        removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          listeners = listeners.filter((l) => l !== cb);
        },
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when viewport is wider than 1024px", () => {
    currentMatches = false;
    const { result } = renderHook(() => useMobile());
    expect(result.current.isMobile).toBe(false);
  });

  it("returns true when viewport is 1024px or narrower", () => {
    currentMatches = true;
    const { result } = renderHook(() => useMobile());
    expect(result.current.isMobile).toBe(true);
  });

  it("updates when matchMedia fires a change event", () => {
    currentMatches = false;
    const { result } = renderHook(() => useMobile());
    expect(result.current.isMobile).toBe(false);

    act(() => {
      listeners.forEach((cb) => cb({ matches: true }));
    });
    expect(result.current.isMobile).toBe(true);
  });

  it("cleans up listener on unmount", () => {
    currentMatches = false;
    const { unmount } = renderHook(() => useMobile());
    expect(listeners.length).toBe(1);
    unmount();
    expect(listeners.length).toBe(0);
  });
});

describe("useMobile SSR safety", () => {
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    // Snapshot and remove the window global to simulate an SSR/non-DOM environment.
    originalWindow = globalThis.window;
    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    if (originalWindow !== undefined) {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("does not throw during server-side rendering when window is undefined", () => {
    expect(typeof globalThis.window).toBe("undefined");

    function Probe() {
      const { isMobile } = useMobile();
      return createElement("span", { "data-mobile": String(isMobile) }, "ok");
    }

    let html = "";
    expect(() => {
      html = renderToString(createElement(Probe));
    }).not.toThrow();

    // The lazy initializer must default to `false` when window is unavailable.
    expect(html).toContain('data-mobile="false"');
  });
});

describe("useMobile legacy MediaQueryList (Safari < 14)", () => {
  let legacyListeners: Array<(e: { matches: boolean }) => void>;
  let addListenerCalls: number;
  let removeListenerCalls: number;

  beforeEach(() => {
    legacyListeners = [];
    addListenerCalls = 0;
    removeListenerCalls = 0;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        // No addEventListener/removeEventListener — simulate legacy Safari behavior.
        addListener: (cb: (e: { matches: boolean }) => void) => {
          addListenerCalls += 1;
          legacyListeners.push(cb);
        },
        removeListener: (cb: (e: { matches: boolean }) => void) => {
          removeListenerCalls += 1;
          legacyListeners = legacyListeners.filter((l) => l !== cb);
        },
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to addListener when addEventListener is unavailable", () => {
    const { result } = renderHook(() => useMobile());
    expect(result.current.isMobile).toBe(false);
    expect(addListenerCalls).toBe(1);
    expect(legacyListeners.length).toBe(1);

    act(() => {
      legacyListeners.forEach((cb) => cb({ matches: true }));
    });
    expect(result.current.isMobile).toBe(true);
  });

  it("uses removeListener on unmount when addEventListener is unavailable", () => {
    const { unmount } = renderHook(() => useMobile());
    expect(legacyListeners.length).toBe(1);
    unmount();
    expect(removeListenerCalls).toBe(1);
    expect(legacyListeners.length).toBe(0);
  });
});
