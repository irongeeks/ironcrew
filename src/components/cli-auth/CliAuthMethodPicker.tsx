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
              ko: "Claude Code 인증 방법을 선택하세요:",
              en: "Choose how to authenticate Claude Code:",
              ja: "Claude Code の認証方法を選択してください:",
              zh: "Choose how to authenticate Claude Code:",
              de: "Wählen Sie die Authentifizierungsmethode für Claude Code:",
            })
          : t({
              ko: "Codex CLI 인증 방법을 선택하세요:",
              en: "Choose how to authenticate Codex CLI:",
              ja: "Codex CLI の認証方法を選択してください:",
              zh: "Choose how to authenticate Codex CLI:",
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
              ? t({
                  ko: "Claude 계정",
                  en: "Claude Account",
                  ja: "Claudeアカウント",
                  zh: "Claude Account",
                  de: "Claude-Konto",
                })
              : t({
                  ko: "ChatGPT 계정",
                  en: "ChatGPT Account",
                  ja: "ChatGPTアカウント",
                  zh: "ChatGPT Account",
                  de: "ChatGPT-Konto",
                })}
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {isClaude
              ? t({
                  ko: "claude.ai 계정으로 로그인 (브라우저 필요)",
                  en: "Log in with your claude.ai account (requires browser access)",
                  ja: "claude.aiアカウントでログイン（ブラウザが必要）",
                  zh: "Log in with your claude.ai account (requires browser access)",
                  de: "Mit Ihrem claude.ai-Konto anmelden (Browser erforderlich)",
                })
              : t({
                  ko: "ChatGPT Plus/Pro 계정으로 로그인",
                  en: "Log in with your ChatGPT Plus/Pro account",
                  ja: "ChatGPT Plus/Proアカウントでログイン",
                  zh: "Log in with your ChatGPT Plus/Pro account",
                  de: "Mit Ihrem ChatGPT Plus/Pro-Konto anmelden",
                })}
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
            {t({ ko: "API 키", en: "API Key", ja: "APIキー", zh: "API Key", de: "API-Schlüssel" })}
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {isClaude
              ? t({
                  ko: "Anthropic API 키를 직접 사용 (console.anthropic.com)",
                  en: "Use an Anthropic API key directly (console.anthropic.com)",
                  ja: "Anthropic APIキーを直接使用 (console.anthropic.com)",
                  zh: "Use an Anthropic API key directly (console.anthropic.com)",
                  de: "Anthropic-API-Schlüssel direkt verwenden (console.anthropic.com)",
                })
              : t({
                  ko: "OpenAI API 키를 직접 사용",
                  en: "Use an OpenAI API key directly",
                  ja: "OpenAI APIキーを直接使用",
                  zh: "Use an OpenAI API key directly",
                  de: "OpenAI-API-Schlüssel direkt verwenden",
                })}
          </div>
        </button>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border px-3 py-2 text-xs"
        style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
      >
        {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
      </button>
    </div>
  );
}
