import { useI18n } from "../../i18n";
import { useRef, useState } from "react";
import { createDocsProvider, deleteDocsProvider, testDocsProvider, updateDocsProvider } from "../../api/knowledge-docs";
import { saveSettingsPatch } from "../../api/messaging-runtime-oauth";
import type { DocsTestResult } from "../../api/knowledge-docs";

interface KnowledgeStepProps {
  onNext: () => void;
  onBack: () => void;
}

export default function KnowledgeStep({ onNext, onBack }: KnowledgeStepProps) {
  const { t } = useI18n();
  const [vaultPath, setVaultPath] = useState("data/vault");
  const [autoBind, setAutoBind] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DocsTestResult | null>(null);
  const createdProviderIdRef = useRef<string | null>(null);

  const testSucceeded = testResult?.ok === true;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let providerId = createdProviderIdRef.current;
      if (providerId) {
        // Update existing provider with new path instead of creating duplicate
        await updateDocsProvider(providerId, { vaultPath, enabled: false });
      } else {
        const provider = await createDocsProvider({
          name: "Obsidian Vault",
          vaultPath,
          enabled: false,
          readOnly: false,
        });
        providerId = provider.id;
        createdProviderIdRef.current = providerId;
      }
      const result = await testDocsProvider(providerId);
      if (result.ok) await updateDocsProvider(providerId, { enabled: true });
      setTestResult(result);
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        reachable: false,
        error: err instanceof Error ? err.message : t({ en: "Unknown error", de: "Unbekannter Fehler" }),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleContinue = async () => {
    await saveSettingsPatch({ knowledgeAutoBindDefault: autoBind });
    onNext();
  };

  const handleSkip = async () => {
    // Clean up provider if created but user skips
    if (createdProviderIdRef.current) {
      try {
        await deleteDocsProvider(createdProviderIdRef.current);
      } catch {
        // non-fatal — orphaned provider is harmless
      }
      createdProviderIdRef.current = null;
    }
    onNext();
  };

  const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVaultPath(e.target.value);
    setTestResult(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ textAlign: "center" }}>
        <svg
          role="img"
          aria-label={t({ en: "Obsidian logo", de: "Obsidian-Logo" })}
          width="40"
          height="40"
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: "inline-block", marginBottom: 12 }}
        >
          {/* outer diamond */}
          <polygon points="50,5 90,30 90,70 50,95 10,70 10,30" fill="#7c3aed" />
          {/* left facet — lighter */}
          <polygon points="50,5 10,30 35,55" fill="#a78bfa" />
          {/* right facet — darker */}
          <polygon points="50,5 90,30 65,55" fill="#5b21b6" />
          {/* bottom facet */}
          <polygon points="35,55 65,55 50,95 10,70" fill="#6d28d9" />
          {/* center highlight */}
          <polygon points="50,5 35,55 65,55" fill="#8b5cf6" />
        </svg>
        <h2
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 14,
            color: "var(--accent)",
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          {t({ en: "Knowledge Base", de: "Wissensbasis" })}
        </h2>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {t({
            en: "Optional: connect an Obsidian vault so agents can read and write shared knowledge.",
            de: "Optional: Verbinde einen Obsidian-Vault, damit Agenten gemeinsames Wissen lesen und ergänzen können.",
          })}
        </p>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.6,
            marginTop: 8,
          }}
        >
          {t({
            en: "The default data/vault folder is created when you test it. For Obsidian Sync, choose your existing local\n          folder. You can also skip this step and configure knowledge later.",
            de: "Der Standardordner data/vault wird beim Testen erstellt. Wähle für Obsidian Sync deinen vorhandenen lokalen Ordner. Du kannst diesen Schritt auch überspringen und die Wissensbasis später einrichten.",
          })}
        </p>
      </div>

      {/* Vault path input */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label
          htmlFor="wizard-vault-path"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {t({ en: "Vault Path", de: "Vault-Pfad" })}
        </label>
        <input
          id="wizard-vault-path"
          type="text"
          value={vaultPath}
          onChange={handlePathChange}
          style={{
            padding: "10px 14px",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            outline: "none",
          }}
        />
      </div>

      {/* Auto-bind checkbox */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={autoBind}
          onChange={(e) => setAutoBind(e.target.checked)}
          style={{ accentColor: "var(--accent)" }}
        />
        {t({ en: "Auto-bind vault to all new tasks", de: "Vault automatisch mit allen neuen Aufgaben verknüpfen" })}
      </label>

      {/* Test Connection button */}
      <button
        onClick={handleTest}
        disabled={testing || !vaultPath.trim()}
        style={{
          padding: "10px 20px",
          background: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          cursor: testing ? "wait" : "pointer",
          opacity: testing ? 0.7 : 1,
        }}
      >
        {testing
          ? t({ en: "Testing...", de: "Wird getestet..." })
          : t({ en: "Test Connection", de: "Verbindung testen" })}
      </button>

      {/* Test result display */}
      {testResult && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            background: testResult.ok ? "rgba(52, 211, 153, 0.15)" : "rgba(239, 68, 68, 0.15)",
            color: testResult.ok ? "#34d399" : "#ef4444",
            border: `1px solid ${testResult.ok ? "#34d399" : "#ef4444"}`,
          }}
        >
          {testResult.ok
            ? t({
                en: `${testResult.previewCount ?? 0} notes found`,
                de: `${testResult.previewCount ?? 0} Notizen gefunden`,
              })
            : `${testResult.error || t({ en: "Connection failed", de: "Verbindung fehlgeschlagen" })}`}
        </div>
      )}

      {/* Navigation buttons */}
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

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleSkip}
            style={{
              padding: "10px 20px",
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t({ en: "Skip", de: "Überspringen" })}
          </button>
          <button
            onClick={handleContinue}
            disabled={!testSucceeded}
            style={{
              padding: "12px 32px",
              background: testSucceeded ? "var(--accent)" : "var(--bg-secondary)",
              color: testSucceeded ? "#0d0d0f" : "var(--text-muted)",
              border: testSucceeded ? "none" : "1px solid var(--border)",
              borderRadius: 6,
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 11,
              cursor: testSucceeded ? "pointer" : "not-allowed",
              letterSpacing: "0.05em",
              opacity: testSucceeded ? 1 : 0.5,
            }}
          >
            {t({ en: "Continue", de: "Weiter" })}
          </button>
        </div>
      </div>
    </div>
  );
}
