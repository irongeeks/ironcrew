import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import "./detail-dialog.css";

const openDialogs: HTMLDialogElement[] = [];
const candidates =
  'a[href], area[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [contenteditable="true"], [tabindex]';

function isAvailable(element: HTMLElement): boolean {
  if (element.matches(":disabled") || element.closest("[hidden], [inert]")) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).display === "none") return false;
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      const summary = parent.querySelector(":scope > summary");
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}

/** Recomputed on each Tab: async panels can insert, disable or hide controls. */
export function dialogTabStops(dialog: HTMLElement): HTMLElement[] {
  const elements = Array.from(dialog.querySelectorAll<HTMLElement>(candidates)).filter(
    (element) => element.tabIndex >= 0 && isAvailable(element),
  );
  return elements
    .filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
      const group = elements.filter(
        (other): other is HTMLInputElement =>
          other instanceof HTMLInputElement &&
          other.type === "radio" &&
          other.name === element.name &&
          other.form === element.form,
      );
      return element === (group.find((radio) => radio.checked) ?? group[0]);
    })
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

/** Native modal semantics provide the top layer and make the background inert. */
export function DetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    openDialogs.push(dialog);
    // Start at the title, so long forms open at their beginning rather than at
    // the closing button. Never override focus again when live data rerenders.
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      const wasTopmost = openDialogs.at(-1) === dialog;
      const index = openDialogs.indexOf(dialog);
      if (index !== -1) openDialogs.splice(index, 1);
      dialog.close();
      if (wasTopmost && trigger?.isConnected && isAvailable(trigger)) trigger.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="ic-detail-backdrop"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (openDialogs.at(-1) === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        // Keep legacy window Escape listeners behind this modal from also
        // closing. Do not preventDefault: the browser still emits cancel.
        if (event.key === "Escape" && openDialogs.at(-1) === event.currentTarget) {
          event.stopPropagation();
          return;
        }
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const dialog = event.currentTarget;
        if (openDialogs.at(-1) !== dialog) return;
        const stops = dialogTabStops(dialog);
        const first = stops[0];
        const last = stops.at(-1);
        const active = document.activeElement;
        if (!first) {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        } else if (event.shiftKey && (active === first || !stops.some((stop) => stop === active))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (active === last || !stops.some((stop) => stop === active))) {
          event.preventDefault();
          first.focus();
        }
        event.stopPropagation();
      }}
    >
      <div className="ic-detail">
        <h2 id={titleId} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        {children}
        <button type="button" className="ic-btn" onClick={onClose}>
          Schliessen
        </button>
      </div>
    </dialog>
  );
}
