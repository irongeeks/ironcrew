import { useCallback, useState } from "react";
import { useI18n } from "../../i18n";
import CliAuthTerminal from "./CliAuthTerminal";
import CliAuthApiKeyFlow from "./CliAuthApiKeyFlow";
import CliAuthMethodPicker from "./CliAuthMethodPicker";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

interface CliAuthModalProps {
  provider: "claude" | "codex" | "gemini";
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function CliAuthModal({ provider, open, onClose, onSuccess }: CliAuthModalProps) {
  const { t } = useI18n();
  // Codex uses a method picker (OAuth vs API key); Claude and Gemini go straight to terminal
  const [codexMethod, setCodexMethod] = useState<"pick" | "terminal" | "apikey">("pick");

  const handleSuccess = useCallback(() => {
    onSuccess();
    setTimeout(onClose, 2000);
  }, [onSuccess, onClose]);

  const handleClose = useCallback(() => {
    setCodexMethod("pick");
    onClose();
  }, [onClose]);

  if (!open) return null;

  const label = PROVIDER_LABELS[provider] ?? provider;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={handleClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Modal — wider for terminal */}
      <div
        className="relative z-10 w-full max-w-2xl rounded-2xl border p-6 shadow-2xl"
        style={{ background: "var(--th-card-bg)", borderColor: "var(--th-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold" style={{ color: "var(--th-text-heading)" }}>
            {t({
              ko: `${label} 인증`,
              en: `${label} Authentication`,
              ja: `${label} 認証`,
              zh: `${label} Authentication`,
              de: `${label}-Authentifizierung`,
            })}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-sm transition-colors hover:bg-white/10"
            style={{ color: "var(--th-text-muted)" }}
          >
            {"✕"}
          </button>
        </div>

        {/* Body */}
        {provider === "codex" ? (
          <>
            {codexMethod === "pick" && (
              <CliAuthMethodPicker
                onSelectOAuth={() => setCodexMethod("terminal")}
                onSelectApiKey={() => setCodexMethod("apikey")}
                onCancel={handleClose}
              />
            )}
            {codexMethod === "terminal" && (
              <CliAuthTerminal provider="codex" onSuccess={handleSuccess} onCancel={handleClose} />
            )}
            {codexMethod === "apikey" && <CliAuthApiKeyFlow onSuccess={handleSuccess} onCancel={handleClose} />}
          </>
        ) : (
          <CliAuthTerminal provider={provider} onSuccess={handleSuccess} onCancel={handleClose} />
        )}
      </div>
    </div>
  );
}
