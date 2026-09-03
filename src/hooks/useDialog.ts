import { useEffect, useRef, type RefObject } from "react";

export interface UseDialogOptions {
  isOpen: boolean;
  onClose: () => void;
}

export interface UseDialogResult<T extends HTMLElement> {
  dialogRef: RefObject<T | null>;
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "area[href]",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
  return nodes.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  });
}

/**
 * useDialog wires Escape-to-close, initial focus, focus restoration, and a Tab
 * focus trap onto a dialog element. Attach the returned `dialogRef` to the
 * dialog root (the element with role="dialog").
 *
 * Behaviour when `isOpen` is true:
 *  - Pressing Escape calls `onClose`.
 *  - On open, focus moves to the first focusable child. If none exists, focus
 *    moves to the dialog root (callers should set `tabIndex={-1}` on the root
 *    so this is possible).
 *  - Tab from the last focusable wraps to the first; Shift+Tab from the first
 *    wraps to the last.
 *  - On close/unmount, the previously-focused element is refocused.
 */
export function useDialog<T extends HTMLElement = HTMLElement>({
  isOpen,
  onClose,
}: UseDialogOptions): UseDialogResult<T> {
  const dialogRef = useRef<T | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Stable ref to onClose so the Escape handler always sees the latest callback
  // without forcing the listener to re-register on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Initial focus + focus restoration.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = getFocusableElements(dialog);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        dialog.focus();
      }
    }
    return () => {
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [isOpen]);

  // Escape + Tab trap.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = getFocusableElements(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen]);

  return { dialogRef };
}
