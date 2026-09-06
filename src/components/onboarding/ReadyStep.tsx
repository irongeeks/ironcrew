import { useI18n } from "../../i18n";
import type { SetupStatus } from "../../api/messaging-runtime-oauth";

interface ReadyStepProps {
  setupStatus: SetupStatus | null;
  onFinish: () => void;
  onBack: () => void;
}

interface CheckDisplay {
  key: string;
  label: { en: string; de: string };
  required: boolean;
}

const REQUIRED_CHECKS: CheckDisplay[] = [
  { key: "database", label: { en: "Database", de: "Datenbank" }, required: true },
  { key: "encryption_secret", label: { en: "Encryption secret", de: "Verschlüsselungsschlüssel" }, required: true },
  { key: "webhook_secret", label: { en: "Webhook secret", de: "Webhook-Schlüssel" }, required: true },
  { key: "agents_seeded", label: { en: "Agents seeded", de: "Agenten angelegt" }, required: true },
  { key: "departments_seeded", label: { en: "Departments seeded", de: "Abteilungen angelegt" }, required: true },
  { key: "cli_provider_configured", label: { en: "CLI provider", de: "CLI-Anbieter" }, required: true },
];

const OPTIONAL_CHECKS: CheckDisplay[] = [
  { key: "api_key_configured", label: { en: "API key", de: "API-Schlüssel" }, required: false },
  { key: "oauth_configured", label: { en: "OAuth connected", de: "OAuth verbunden" }, required: false },
  { key: "agents_md_injected", label: { en: "AGENTS.md injected", de: "AGENTS.md eingerichtet" }, required: false },
  {
    key: "knowledge_vault_configured",
    label: { en: "Knowledge vault connected", de: "Wissens-Vault verbunden" },
    required: false,
  },
];

export default function ReadyStep({ setupStatus, onFinish, onBack }: ReadyStepProps) {
  const { t } = useI18n();
  const allRequiredOk = setupStatus?.required_ok ?? false;

  const detailTranslations: Record<string, string> = {
    "No agents found — run setup": "Keine Agenten gefunden — bitte die Einrichtung ausführen",
    "No departments found — run setup": "Keine Abteilungen gefunden — bitte die Einrichtung ausführen",
    "No default CLI provider configured in settings": "Kein Standard-CLI-Anbieter in den Einstellungen eingerichtet",
    "No API provider keys configured (optional)": "Keine API-Schlüssel eingerichtet (optional)",
    "api_providers table unavailable (optional)": "Tabelle api_providers nicht verfügbar (optional)",
    "No OAuth credentials configured (optional)": "Keine OAuth-Zugangsdaten eingerichtet (optional)",
    "oauth_credentials table unavailable (optional)": "Tabelle oauth_credentials nicht verfügbar (optional)",
    "No knowledge vault configured (optional)": "Kein Wissens-Vault eingerichtet (optional)",
    "docs_providers table unavailable (optional)": "Tabelle docs_providers nicht verfügbar (optional)",
    "AGENTS.md exists but missing orchestration rules — run pnpm run setup":
      "In AGENTS.md fehlen die Orchestrierungsregeln — bitte pnpm run setup ausführen",
    "AGENTS.md not found — run pnpm run setup": "AGENTS.md nicht gefunden — bitte pnpm run setup ausführen",
  };
  const translateDetail = (detail: string) => {
    let german = detailTranslations[detail];
    if (!german) {
      german = detail
        .replace(/ not found in \.env$/, " nicht in .env gefunden")
        .replace(/ not configured$/, " nicht eingerichtet")
        .replace(/^Runtime credentials configured: /, "Laufzeit-Zugangsdaten eingerichtet: ")
        .replace(/^Database unreachable: /, "Datenbank nicht erreichbar: ")
        .replace(/^(agents|departments|settings) table error: /, "Fehler in Tabelle $1: ");
    }
    return t({ en: detail, de: german });
  };

  const renderCheck = (check: CheckDisplay) => {
    const result = setupStatus?.checks[check.key];
    const isOk = result?.ok ?? false;
    const detail = result?.detail;

    return (
      <div
        key={check.key}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          borderRadius: 6,
          border: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 14, flexShrink: 0 }}>
          {setupStatus == null ? "⏳" : isOk ? "✅" : check.required ? "❌" : "⚠️"}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: "var(--text-primary)",
            }}
          >
            {t(check.label)}
          </div>
          {detail && (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: "var(--text-muted)",
                marginTop: 2,
              }}
            >
              {translateDetail(detail)}
            </div>
          )}
        </div>
        {!check.required && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {t({ en: "optional", de: "optional" })}
          </span>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>{allRequiredOk ? "🚀" : "⚠️"}</div>
        <h2
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 14,
            color: allRequiredOk ? "var(--accent)" : "#f59e0b",
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          {setupStatus == null
            ? t({ en: "Checking...", de: "Wird geprüft..." })
            : allRequiredOk
              ? t({ en: "You're All Set!", de: "Alles bereit!" })
              : t({ en: "Almost Ready", de: "Fast bereit" })}
        </h2>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {allRequiredOk
            ? t({
                en: "All required checks passed. Your office is ready to launch.",
                de: "Alle erforderlichen Prüfungen waren erfolgreich. Dein Büro ist startbereit.",
              })
            : t({
                en: "Some required checks failed. You may still proceed, but some features may not work.",
                de: "Einige erforderliche Prüfungen sind fehlgeschlagen. Du kannst fortfahren, aber manche Funktionen sind möglicherweise nicht verfügbar.",
              })}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            {t({ en: "Required", de: "Erforderlich" })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{REQUIRED_CHECKS.map(renderCheck)}</div>
        </div>

        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            {t({ en: "Optional", de: "Optional" })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{OPTIONAL_CHECKS.map(renderCheck)}</div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button
          onClick={onBack}
          style={{
            padding: "10px 20px",
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {t({ en: "← Back", de: "← Zurück" })}
        </button>
        <button
          onClick={onFinish}
          style={{
            padding: "12px 32px",
            background: "var(--accent)",
            color: "#0d0d0f",
            border: "none",
            borderRadius: 6,
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 11,
            cursor: "pointer",
            letterSpacing: "0.05em",
          }}
        >
          {t({ en: "Launch Office →", de: "Büro öffnen →" })}
        </button>
      </div>
    </div>
  );
}
