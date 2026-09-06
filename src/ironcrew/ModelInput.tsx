import { useGovernanceI18n } from "./governance-i18n";
import { useEffect, useId, useState, type InputHTMLAttributes } from "react";
import { request } from "../api/core";
import type { OpenRouterCatalog } from "../shared/openrouter-models";
import "./ModelInput.css";

interface ModelInputProps extends InputHTMLAttributes<HTMLInputElement> {
  runtime: string;
}

/** Suggestions never validate or replace a manually entered model ID. */
export function ModelInput({ runtime, ...input }: ModelInputProps): React.JSX.Element {
  const { tx, t } = useGovernanceI18n();
  const listId = useId();
  const helpId = `${listId}-help`;
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const isOpenRouter = runtime === "openrouter";

  useEffect(() => {
    if (!isOpenRouter) return;
    let active = true;
    setStatus("loading");
    void request<OpenRouterCatalog>("/api/crew/models/openrouter").then(
      (result) => {
        if (!active) return;
        if (!Array.isArray(result.models)) {
          setStatus("error");
          return;
        }
        setCatalog(result);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [isOpenRouter]);

  if (!isOpenRouter) return <input {...input} />;
  const selected = catalog?.models.find((model) => model.id === input.value);
  return (
    <span className="ic-model-input">
      <input
        {...input}
        list={listId}
        autoComplete="off"
        aria-describedby={[input["aria-describedby"], helpId].filter(Boolean).join(" ")}
      />
      <datalist id={listId}>
        {catalog?.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
            {model.outputModalities.length ? ` · ${model.outputModalities.join(", ")}` : ""}
          </option>
        ))}
      </datalist>
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
    </span>
  );
}
