import { useGovernanceI18n } from "./governance-i18n";
import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { request } from "../api/core";
import type { OpenRouterCatalog } from "../shared/openrouter-models";
import "./ModelInput.css";

interface ModelInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "defaultValue"> {
  runtime: string;
  value: string;
  onValueChange: (value: string) => void;
}

// Routing forms mount several inputs together. Share in-flight requests;
// freshness and failure backoff are owned by the server.
let pendingCatalog: Promise<OpenRouterCatalog> | null = null;
function loadCatalog(force: boolean): Promise<OpenRouterCatalog> {
  if (!pendingCatalog) {
    pendingCatalog = request<OpenRouterCatalog>(`/api/crew/models/openrouter${force ? "?refresh=1" : ""}`)
      .then((result) => {
        if (!Array.isArray(result.models)) throw new Error("Invalid model catalog");
        return result;
      })
      .finally(() => {
        pendingCatalog = null;
      });
  }
  return pendingCatalog;
}

/** Suggestions never validate or replace a manually entered model ID. */
export function ModelInput({ runtime, onValueChange, ...input }: ModelInputProps): React.JSX.Element {
  if (runtime !== "openrouter") return <input {...input} onChange={(event) => onValueChange(event.target.value)} />;
  return <OpenRouterInput {...input} onValueChange={onValueChange} />;
}

function OpenRouterInput({ onValueChange, ...input }: Omit<ModelInputProps, "runtime">): React.JSX.Element {
  const { tx, t, locale } = useGovernanceI18n();
  const listId = useId();
  const helpId = `${listId}-help`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refresh, setRefresh] = useState({ revision: 0, force: false });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [modality, setModality] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const editable = !input.disabled && !input.readOnly;
  const expanded = open && editable;

  useEffect(() => {
    let active = true;
    setStatus("loading");
    void loadCatalog(refresh.force).then(
      (result) => {
        if (active) {
          setCatalog(result);
          setStatus("ready");
        }
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!expanded) return;
    const timer = window.setInterval(() => {
      setRefresh((previous) => ({ revision: previous.revision + 1, force: false }));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [expanded]);

  const providers = useMemo(
    () => [...new Set(catalog?.models.map((model) => model.id.split("/")[0]) ?? [])].sort(),
    [catalog],
  );
  const modalities = useMemo(
    () => [...new Set(catalog?.models.flatMap((model) => model.outputModalities) ?? [])].sort(),
    [catalog],
  );
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (
      catalog?.models.filter(
        (model) =>
          (!provider || model.id.split("/")[0] === provider) &&
          (!modality || model.outputModalities.includes(modality)) &&
          terms.every((term) => `${model.name} ${model.id}`.toLowerCase().includes(term)),
      ) ?? []
    );
  }, [catalog, query, provider, modality]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [results, expanded]);
  useEffect(() => {
    if (activeIndex >= 0) listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function choose(modelId: string) {
    if (!editable) return;
    onValueChange(modelId);
    inputRef.current?.focus();
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }
  function showAll() {
    setQuery("");
    setProvider("");
    setModality("");
    setActiveIndex(-1);
  }
  function showSuggestions() {
    if (!editable) return;
    // Focus browses the entire catalog; typing starts a name or ID search.
    if (!expanded) setQuery("");
    setOpen(true);
  }
  function modalityLabel(value: string) {
    return (
      (
        {
          text: t({ de: "Text", en: "Text" }),
          image: t({ de: "Bild", en: "Image" }),
          audio: "Audio",
          video: "Video",
        } as Record<string, string>
      )[value] ?? value
    );
  }
  const selected = catalog?.models.find((model) => model.id === input.value);
  return (
    <div
      className="ic-model-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          inputRef.current?.focus();
          setOpen(false);
        }
      }}
    >
      <div className="ic-model-input-control">
        <input
          {...input}
          ref={inputRef}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={[input["aria-describedby"], helpId].filter(Boolean).join(" ")}
          onFocus={(event) => {
            input.onFocus?.(event);
            showSuggestions();
          }}
          onChange={(event) => {
            onValueChange(event.target.value);
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            input.onKeyDown?.(event);
            if (event.defaultPrevented || event.nativeEvent.isComposing || !editable) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!expanded) {
                showSuggestions();
                return;
              }
              setActiveIndex((index) =>
                event.key === "ArrowDown"
                  ? Math.min(index + 1, results.length - 1)
                  : index <= 0
                    ? results.length - 1
                    : index - 1,
              );
            } else if (event.key === "Enter" && expanded && results[activeIndex]) {
              event.preventDefault();
              choose(results[activeIndex].id);
            }
          }}
        />
        <button
          type="button"
          disabled={!editable}
          aria-expanded={expanded}
          aria-label={t({ de: "Alle Modelle anzeigen", en: "Show all models" })}
          onClick={() => {
            if (expanded) {
              setOpen(false);
            } else {
              inputRef.current?.focus();
              showAll();
              setOpen(true);
            }
          }}
        >
          {t({ de: "Modelle", en: "Models" })}
        </button>
      </div>
      <small id={helpId} className="ic-model-input-help" role="status">
        {status === "loading"
          ? tx("OpenRouter-Modelle werden geladen. Modell-ID ist frei eingebbar.")
          : status === "error"
            ? tx("Katalog nicht erreichbar. Modell-ID direkt eingeben.")
            : t({
                de: `${catalog?.models.length ?? 0} Modelle · Nach Name oder ID suchen oder eine ID direkt eingeben.${catalog?.stale ? " Katalog vorübergehend veraltet." : ""}`,
                en: `${catalog?.models.length ?? 0} models · Search by name or ID, or enter an ID directly.${catalog?.stale ? " Catalog temporarily outdated." : ""}`,
              })}
        {selected && selected.outputModalities.length > 0 && !selected.outputModalities.includes("text") && (
          <> {tx("Dieses Modell liefert keine Textausgabe; die Agenten-Runtime benötigt Text-Chat.")}</>
        )}
      </small>
      {expanded && (
        <div className="ic-model-catalog">
          <div className="ic-model-catalog-toolbar">
            <span className="ic-model-input-help">
              {catalog &&
                t({
                  de: `Stand: ${new Date(catalog.fetchedAt).toLocaleString(locale)}`,
                  en: `Updated: ${new Date(catalog.fetchedAt).toLocaleString(locale)}`,
                })}
            </span>
            <button
              type="button"
              disabled={status === "loading"}
              onClick={() => setRefresh((previous) => ({ revision: previous.revision + 1, force: true }))}
            >
              {t({ de: "Live aktualisieren", en: "Refresh live" })}
            </button>
          </div>
          <div className="ic-model-catalog-filters">
            <label>
              {t({ de: "Modellanbieter", en: "Model author" })}
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="">{t({ de: "Alle Anbieter", en: "All authors" })}</option>
                {providers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t({ de: "Ausgabe", en: "Output" })}
              <select value={modality} onChange={(event) => setModality(event.target.value)}>
                <option value="">{t({ de: "Alle Ausgabetypen", en: "All output types" })}</option>
                {modalities.map((name) => (
                  <option key={name} value={name}>
                    {modalityLabel(name)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ic-model-catalog-toolbar">
            <small role="status">
              {t({
                de: `${results.length} von ${catalog?.models.length ?? 0} Modellen`,
                en: `${results.length} of ${catalog?.models.length ?? 0} models`,
              })}
            </small>
            {(query || provider || modality) && (
              <button type="button" onClick={showAll}>
                {t({ de: "Suche & Filter zurücksetzen", en: "Reset search & filters" })}
              </button>
            )}
          </div>
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label={t({ de: "OpenRouter-Modelle", en: "OpenRouter models" })}
            aria-busy={status === "loading"}
            className="ic-model-catalog-list"
          >
            {results.map((model, index) => (
              <li
                key={model.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={model.id === input.value}
                data-active={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(model.id)}
              >
                <strong>{model.name}</strong>
                <span className="ic-model-id">{model.id}</span>
                <small>
                  {model.outputModalities.map(modalityLabel).join(" · ")}
                  {model.contextLength
                    ? ` · ${model.contextLength.toLocaleString(locale)} ${t({ de: "Kontext-Token", en: "context tokens" })}`
                    : ""}
                </small>
              </li>
            ))}
          </ul>
          {results.length === 0 && status !== "loading" && (
            <p className="ic-model-input-help">
              {t({
                de: "Keine Treffer. Suche oder Filter ändern oder eine Modell-ID direkt eingeben.",
                en: "No matches. Change your search or filters, or enter a model ID directly.",
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
