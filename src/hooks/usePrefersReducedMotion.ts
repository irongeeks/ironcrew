import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

interface LegacyMediaQueryList {
  matches: boolean;
  media: string;
  addListener?: (cb: (e: { matches: boolean }) => void) => void;
  removeListener?: (cb: (e: { matches: boolean }) => void) => void;
  addEventListener?: (type: string, cb: (e: { matches: boolean }) => void) => void;
  removeEventListener?: (type: string, cb: (e: { matches: boolean }) => void) => void;
}

function getInitialMatch(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Reactively reports the user's `prefers-reduced-motion` OS-level preference.
 *
 * SSR-safe (returns false when window/matchMedia is unavailable) and falls
 * back to the legacy `addListener`/`removeListener` API when modern
 * `addEventListener` is not implemented (older Safari).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(getInitialMatch);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    let mql: LegacyMediaQueryList;
    try {
      mql = window.matchMedia(QUERY) as LegacyMediaQueryList;
    } catch {
      return;
    }

    setReduced(mql.matches);
    const handler = (e: { matches: boolean }) => setReduced(e.matches);

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => {
        mql.removeEventListener?.("change", handler);
      };
    }

    if (typeof mql.addListener === "function") {
      mql.addListener(handler);
      return () => {
        mql.removeListener?.(handler);
      };
    }

    return;
  }, []);

  return reduced;
}
