import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

describe("usePrefersReducedMotion", () => {
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

  it("returns false by default when user has no reduced-motion preference", () => {
    currentMatches = false;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when prefers-reduced-motion is reduce", () => {
    currentMatches = true;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("updates reactively when matchMedia fires a change event", () => {
    currentMatches = false;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      listeners.forEach((cb) => cb({ matches: true }));
    });
    expect(result.current).toBe(true);
  });

  it("falls back to legacy addListener when addEventListener is missing", () => {
    let legacyListener: ((e: { matches: boolean }) => void) | null = null;
    let removed = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addListener: (cb: (e: { matches: boolean }) => void) => {
          legacyListener = cb;
        },
        removeListener: (_cb: (e: { matches: boolean }) => void) => {
          removed = true;
        },
      })),
    );

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    expect(legacyListener).not.toBeNull();

    act(() => {
      legacyListener?.({ matches: true });
    });
    expect(result.current).toBe(true);

    unmount();
    expect(removed).toBe(true);
  });

  it("is SSR-safe — does not throw when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("cleans up listener on unmount", () => {
    currentMatches = false;
    const { unmount } = renderHook(() => usePrefersReducedMotion());
    expect(listeners.length).toBe(1);
    unmount();
    expect(listeners.length).toBe(0);
  });
});
