import { useI18n } from "../../i18n";

interface CliAuthMethodPickerProps {
  provider?: "claude" | "codex";
  onSelectOAuth: () => void;
  onSelectApiKey: () => void;
  onCancel: () => void;
}

export default function CliAuthMethodPicker({
  provider = "codex",
  onSelectOAuth,
  onSelectApiKey,
  onCancel,
}: CliAuthMethodPickerProps) {
  const { t } = useI18n();
  const isClaude = provider === "claude";

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {isClaude
          ? t({
              en: "Choose how to authenticate Claude Code:",
              de: "Wählen Sie die Authentifizierungsmethode für Claude Code:",
            })
          : t({
              en: "Choose how to authenticate Codex CLI:",
              de: "Wählen Sie die Authentifizierungsmethode für Codex CLI:",
            })}
      </p>

      <div className="grid grid-cols-2 gap-3">
        {/* OAuth / Browser login */}
        <button
          type="button"
          onClick={onSelectOAuth}
          className="group rounded-xl border p-4 text-left transition-colors"
          style={{ borderColor: "var(--th-card-border)", background: "var(--th-card-bg)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--th-bg-surface-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--th-card-bg)";
          }}
        >
          <div className="mb-2 text-2xl">{isClaude ? "🟣" : "💬"}</div>
          <div className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
            {isClaude
              ? t({ en: "Claude Account", de: "Claude-Konto" })
              : t({ en: "ChatGPT Account", de: "ChatGPT-Konto" })}
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {isClaude
              ? t({
                  en: "Log in with your claude.ai account (requires browser access)",
                  de: "Mit Ihrem claude.ai-Konto anmelden (Browser erforderlich)",
                })
              : t({ en: "Log in with your ChatGPT Plus/Pro account", de: "Mit Ihrem ChatGPT Plus/Pro-Konto anmelden" })}
          </div>
        </button>

        {/* API Key */}
        <button
          type="button"
          onClick={onSelectApiKey}
          className="group rounded-xl border p-4 text-left transition-colors"
          style={{ borderColor: "var(--th-card-border)", background: "var(--th-card-bg)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--th-bg-surface-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--th-card-bg)";
          }}
        >
          <div className="mb-2 text-2xl">{"🔑"}</div>
          <div className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
            {t({ en: "API Key", de: "API-Schlüssel" })}
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {isClaude
              ? t({
                  en: "Use an Anthropic API key directly (console.anthropic.com)",
                  de: "Anthropic-API-Schlüssel direkt verwenden (console.anthropic.com)",
                })
              : t({ en: "Use an OpenAI API key directly", de: "OpenAI-API-Schlüssel direkt verwenden" })}
          </div>
        </button>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border px-3 py-2 text-xs"
        style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
      >
        {t({ en: "Cancel", de: "Abbrechen" })}
      </button>
    </div>
  );
}
