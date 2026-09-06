import LocalizedText from "../LocalizedText";
import { useEffect, useState } from "react";
import { getSettingsRaw, saveSettingsPatch } from "../../api";
import type { TFunction } from "./types";

export default function GitHubOAuthAppConfig({ t }: { t: TFunction }) {
  const [ghClientId, setGhClientId] = useState("");
  const [ghClientIdSaved, setGhClientIdSaved] = useState(false);
  const [ghClientIdLoaded, setGhClientIdLoaded] = useState(false);

  useEffect(() => {
    getSettingsRaw()
      .then((settings) => {
        const val = settings?.github_oauth_client_id;
        if (val) setGhClientId(String(val).replace(/^"|"$/g, ""));
        setGhClientIdLoaded(true);
      })
      .catch(() => setGhClientIdLoaded(true));
  }, []);

  const saveClientId = () => {
    const val = ghClientId.trim();
    saveSettingsPatch({ github_oauth_client_id: val || null })
      .then(() => {
        setGhClientIdSaved(true);
        setTimeout(() => setGhClientIdSaved(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div
      className="space-y-2 rounded-xl border p-4"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-secondary)" }}>
          {t({ en: "GitHub OAuth App (Private repo access)", de: "GitHub OAuth App (Privater Repo-Zugriff)" })}
        </h4>
        {ghClientIdSaved && <span className="text-[10px] text-green-400">{t({ en: "Saved", de: "Gespeichert" })}</span>}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--th-text-muted)" }}>
        {t({
          en: "Default GitHub uses Copilot OAuth which limits private repo access. Register your own OAuth App for full access.",
          de: "Die Standard-GitHub-Verbindung verwendet Copilot OAuth, das den Zugriff auf private Repos einschränkt. Registrieren Sie Ihre eigene OAuth App für vollständigen Zugriff.",
        })}
      </p>
      <details className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        <summary className="cursor-pointer text-blue-400 hover:text-blue-300">
          {t({ en: "How to create OAuth App", de: "OAuth App erstellen – Anleitung" })}
        </summary>
        <ol className="mt-2 ml-4 list-decimal space-y-1" style={{ color: "var(--th-text-secondary)" }}>
          <li>GitHub → Settings → Developer settings → OAuth Apps → New OAuth App</li>
          <li>
            {t({
              en: "Application name: any name (e.g. My IronCrew)",
              de: "Application name: beliebiger Name (z. B. My IronCrew)",
            })}
          </li>
          <li>
            <LocalizedText en="Homepage URL:" de="Homepage-URL:" /> {window.location.origin}
          </li>
          <li>
            <LocalizedText en="Callback URL:" de="Callback-URL:" /> {window.location.origin + "/oauth/callback"}
          </li>
          <li>{t({ en: "☑ Check 'Enable Device Flow'", de: "☑ 'Enable Device Flow' aktivieren" })}</li>
          <li>{t({ en: "Register → Paste Client ID below", de: "Register → Client ID unten einfügen" })}</li>
        </ol>
      </details>
      {ghClientIdLoaded && (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="Iv23li..."
            value={ghClientId}
            onChange={(e) => setGhClientId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveClientId();
            }}
            className="flex-1 rounded-lg border px-3 py-1.5 text-xs outline-none focus:border-blue-500 font-mono"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
          <button
            onClick={saveClientId}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-500"
          >
            {t({ en: "Save", de: "Speichern" })}
          </button>
        </div>
      )}
      {ghClientId.trim() && (
        <p className="text-[10px] text-amber-400">
          {t({
            en: "After saving, reconnect your GitHub account using the 'Connect' or 'Add Account' button above.",
            de: "Nach dem Speichern GitHub-Konto über die Schaltfläche 'Verbinden' oder 'Konto hinzufügen' oben erneut verbinden.",
          })}
        </p>
      )}
    </div>
  );
}
