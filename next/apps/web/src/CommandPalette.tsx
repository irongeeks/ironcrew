import { useEffect, useId, useRef, useState } from "react";
import { list, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
const destinations = [
  ["/hq", "Hauptquartier", "Headquarters"],
  ["/orders", "Aufträge", "Orders"],
  ["/crew", "Crew", "Crew"],
  ["/knowledge", "Wissen", "Knowledge"],
  ["/settings", "Einstellungen", "Settings"],
  ["/decisions", "Entscheidungen", "Decisions"],
  ["/finance", "Finanzen", "Finance"],
];
export default function CommandPalette({ locale }: { locale: "de" | "en" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <>
      <button
        className={styles.secondary}
        onClick={() => setOpen(true)}
        aria-label={locale === "de" ? "Kommandopalette öffnen" : "Open command palette"}
      >
        ⌘/Ctrl K
      </button>
      {open && <Palette locale={locale} close={() => setOpen(false)} />}
    </>
  );
}
function Palette({ locale, close }: { locale: "de" | "en"; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    id = useId();
  const [query, setQuery] = useState(""),
    [orders, setOrders] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [active, setActive] = useState(0),
    [loading, setLoading] = useState(true);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    const prior = document.activeElement;
    dialog.current?.showModal();
    input.current?.focus();
    let alive = true;
    void list("/orders")
      .then((value) => {
        if (alive) setOrders(value);
      })
      .catch((error) => alive && setError(error.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      if (prior instanceof HTMLElement) prior.focus();
    };
  }, []);
  const results = [
    ...destinations.map(([href, de, en]) => ({
      href: href!,
      title: locale === "de" ? de! : en!,
      kind: t("Navigation", "Navigation"),
    })),
    ...orders.map((order) => ({
      href: `/orders/${encodeURIComponent(str(order, "id"))}`,
      title: str(order, "goal"),
      kind: t("Auftrag", "Order"),
    })),
  ]
    .filter((result) => result.title.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale)))
    .slice(0, 30);
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);
  const go = (href: string) => {
    history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    close();
  };
  return (
    <dialog ref={dialog} className={styles.dialog} onCancel={close} aria-labelledby={`${id}-title`}>
      <div className={styles.panelHeader}>
        <h2 id={`${id}-title`}>{t("Gehe zu…", "Go to…")}</h2>
        <button className={styles.secondary} onClick={close}>
          {t("Schließen", "Close")}
        </button>
      </div>
      <label htmlFor={`${id}-query`}>{t("Navigation und Aufträge suchen", "Search navigation and orders")}</label>
      <input
        ref={input}
        id={`${id}-query`}
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={results[active] ? `${id}-${active}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((value) =>
              Math.max(0, Math.min(results.length - 1, value + (event.key === "ArrowDown" ? 1 : -1))),
            );
          } else if (event.key === "Enter" && results[active]) {
            event.preventDefault();
            go(results[active]!.href);
          }
        }}
      />
      {loading && <p role="status">{t("Aufträge werden geladen…", "Loading orders…")}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label={t("Suchergebnisse", "Search results")}
        className={styles.commandResults}
      >
        {results.map((result, index) => (
          <button
            key={result.href}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === active}
            tabIndex={-1}
            className={styles.secondary}
            onMouseEnter={() => setActive(index)}
            onClick={() => go(result.href)}
          >
            {result.title}
            <span className={styles.muted}> · {result.kind}</span>
          </button>
        ))}
      </div>
      {!loading && !results.length && <p>{t("Keine Treffer.", "No results.")}</p>}
      <p className={styles.muted}>
        {t("↑ ↓ auswählen · Enter öffnen · Escape schließen", "↑ ↓ select · Enter open · Escape close")}
      </p>
    </dialog>
  );
}
