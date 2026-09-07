import { useLayoutEffect, useRef, type ReactNode } from "react";
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Draft = { value: string; checked?: boolean };
/** Session-memory drafts for ordinary fields only. No credentials, files, approval flags or browser storage. */
export default function SetupDraft({ step, children }: { step: number; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null),
    drafts = useRef(new Map<number, Map<string, Draft>>());
  useLayoutEffect(() => {
    const container = root.current!;
    const values = drafts.current.get(step) ?? new Map<string, Draft>();
    drafts.current.set(step, values);
    const restored = new WeakSet<Element>();
    let applying = false;
    const controls = () => Array.from(container.querySelectorAll<Control>("input,select,textarea"));
    const key = (control: Control) => {
      const labels = Array.from(control.labels ?? [])
        .map((label) => label.textContent?.trim() ?? "")
        .join("|");
      const name = control.name || labels;
      const reference = /ref\.|share.?id|item.?id|field|feldname/i.test(name);
      if (
        !name ||
        (control instanceof HTMLInputElement &&
          ["password", "file", "hidden", "checkbox", "radio"].includes(control.type))
      )
        return null;
      if (!reference && /password|passwort|secret|geheimnis|token|credential|zugangscode/i.test(name + " " + labels))
        return null;
      const formIndex = Array.from(container.querySelectorAll("form")).indexOf(control.form!);
      return `${formIndex}|${name}|${labels}`;
    };
    const capture = (event: Event) => {
      if (applying) return;
      const control = event.target;
      if (
        !(
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          control instanceof HTMLSelectElement
        )
      )
        return;
      const id = key(control);
      if (id) values.set(id, { value: control.value });
    };
    const restore = () => {
      applying = true;
      try {
        for (const control of controls()) {
          if (restored.has(control)) continue;
          const id = key(control),
            draft = id ? values.get(id) : undefined;
          if (!draft) continue;
          // Wait for asynchronously loaded options before restoring a controlled selection.
          if (
            control instanceof HTMLSelectElement &&
            !Array.from(control.options).some((option) => option.value === draft.value)
          )
            continue;
          restored.add(control);
          const prototype =
            control instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : control instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLSelectElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, draft.value);
          control.dispatchEvent(
            new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
          );
        }
      } finally {
        applying = false;
      }
    };
    container.addEventListener("input", capture);
    container.addEventListener("change", capture);
    const observer = new MutationObserver(restore);
    observer.observe(container, { childList: true, subtree: true });
    restore();
    return () => {
      observer.disconnect();
      container.removeEventListener("input", capture);
      container.removeEventListener("change", capture);
    };
  }, [step]);
  return <div ref={root}>{children}</div>;
}
