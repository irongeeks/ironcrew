import { useState } from "react";
import { saveClaudeApiKey, saveCodexApiKey } from "../../api";
import { useI18n } from "../../i18n";

interface CliAuthApiKeyFlowProps {
  provider?: "claude" | "codex";
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CliAuthApiKeyFlow({ provider = "codex", onSuccess, onCancel }: CliAuthApiKeyFlowProps) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isClaude = provider === "claude";
  const keyPrefix = isClaude ? "sk-ant-" : "sk-";
  const isValid = apiKey.startsWith(keyPrefix) && apiKey.length > 10;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      const result = await (isClaude ? saveClaudeApiKey(apiKey) : saveCodexApiKey(apiKey));
      if (result.authenticated) {
        setSuccess(true);
        setTimeout(onSuccess, 1500);
      } else {
        setError(t({ en: "API key is not valid.", de: "API-Schlüssel ist ungültig." }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (success) {
    return (
      <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-400">
        {t({ en: "API key saved successfully!", de: "API-Schlüssel erfolgreich gespeichert!" })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {isClaude
          ? t({
              en: "Enter your Anthropic API key. It should start with sk-ant-.",
              de: "Geben Sie Ihren Anthropic-API-Schlüssel ein. Er sollte mit sk-ant- beginnen.",
            })
          : t({
              en: "Enter your OpenAI API key. It should start with sk-.",
              de: "Geben Sie Ihren OpenAI-API-Schlüssel ein. Er sollte mit sk- beginnen.",
            })}
      </p>

      <div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setError(null);
          }}
          placeholder="sk-..."
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
        {apiKey.length > 0 && !isValid && (
          <p className="mt-1 text-xs text-rose-400">
            {isClaude
              ? t({
                  en: "Enter a valid API key (starts with sk-ant-, more than 10 characters)",
                  de: "Geben Sie einen gültigen API-Schlüssel ein (beginnt mit sk-ant-, mehr als 10 Zeichen)",
                })
              : t({
                  en: "Enter a valid API key (starts with sk-, more than 10 characters)",
                  de: "Geben Sie einen gültigen API-Schlüssel ein (beginnt mit sk-, mehr als 10 Zeichen)",
                })}
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!isValid || saving}
          onClick={() => void handleSave()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? t({ en: "Saving...", de: "Speichern..." }) : t({ en: "Save", de: "Speichern" })}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border px-3 py-2 text-xs"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {t({ en: "Cancel", de: "Abbrechen" })}
        </button>
      </div>
    </div>
  );
}
