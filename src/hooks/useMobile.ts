import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = "(max-width: 1023px)";

/**
 * SSR/test-safe media-query hook for the mobile breakpoint.
 *
 * - The lazy `useState` initializer guards `window` access so that the hook can
 *   be evaluated in non-DOM environments (SSR, Vitest without jsdom, etc.).
 * - Subscription is set up inside `useEffect`, which already only runs in the
 *   browser, but we still guard against `window` being undefined defensively.
 * - Falls back to the legacy `addListener` / `removeListener` API for older
 *   Safari (<14) where MediaQueryList does not implement `addEventListener`.
 */
export function useMobile(): { isMobile: boolean } {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(MOBILE_BREAKPOINT).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mql = window.matchMedia(MOBILE_BREAKPOINT);
    const handler = (e: MediaQueryListEvent | { matches: boolean }) => setIsMobile(e.matches);

    let usedLegacy = false;
    try {
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", handler);
      } else {
        // Legacy Safari (<14) and other older browsers.
        usedLegacy = true;
        mql.addListener(handler);
      }
    } catch {
      usedLegacy = true;
      try {
        mql.addListener(handler);
      } catch {
        // No subscription possible — bail without throwing.
        return;
      }
    }

    return () => {
      try {
        if (!usedLegacy && typeof mql.removeEventListener === "function") {
          mql.removeEventListener("change", handler);
        } else {
          mql.removeListener(handler);
        }
      } catch {
        try {
          mql.removeListener(handler);
        } catch {
          // Swallow — nothing more we can do during cleanup.
        }
      }
    };
  }, []);

  return { isMobile };
}
