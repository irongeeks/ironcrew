import {
  I18nProvider,
  useI18n,
  normalizeLanguage,
  LANGUAGE_STORAGE_KEY,
  LANGUAGE_USER_SET_STORAGE_KEY,
} from "../../i18n";
import { writeStoredValue } from "../../storage";
import { useEffect, useState } from "react";
import { getCliStatus, getSetupStatus, saveSettingsPatch } from "../../api/messaging-runtime-oauth";
import type { SetupStatus } from "../../api/messaging-runtime-oauth";
import type { CliProvider, CliStatusMap, CompanySettings } from "../../types";
import WelcomeStep from "./WelcomeStep";
import ProviderStep from "./ProviderStep";
import ExtrasStep from "./ExtrasStep";
import KnowledgeStep from "./KnowledgeStep";
import ReadyStep from "./ReadyStep";

interface SetupWizardProps {
  settings: CompanySettings;
  cliStatus: CliStatusMap | null;
  onComplete: () => void;
}

const STEPS = [
  { en: "Welcome", de: "Willkommen" },
  { en: "Provider", de: "Anbieter" },
  { en: "Extras", de: "Extras" },
  { en: "Knowledge", de: "Wissen" },
  { en: "Ready", de: "Bereit" },
] as const;

export default function SetupWizard({ settings, cliStatus: cliStatusProp, onComplete }: SetupWizardProps) {
  const [language, setLanguage] = useState(() => normalizeLanguage(settings.language));
  const { t } = useI18n(language);
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState(settings.companyName);
  const [ceoName, setCeoName] = useState(settings.ceoName);
  const [provider, setProvider] = useState<CliProvider>(settings.defaultProvider);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [localCliStatus, setLocalCliStatus] = useState<CliStatusMap | null>(cliStatusProp);

  const cliStatus = localCliStatus;

  const refreshSetupStatus = () => {
    getSetupStatus()
      .then(setSetupStatus)
      .catch(() => {
        // non-fatal: ReadyStep handles null gracefully
      });
  };

  // Fetch on mount and re-fetch when entering the Ready step so checks
  // reflect changes made during onboarding (e.g. vault configured in step 3)
  useEffect(() => {
    refreshSetupStatus();
  }, []);

  useEffect(() => {
    if (step === 4) refreshSetupStatus();
  }, [step]);

  useEffect(() => {
    if (localCliStatus) return;
    getCliStatus(true)
      .then(setLocalCliStatus)
      .catch(() => {
        // non-fatal: ProviderStep shows "..." gracefully
      });
  }, [localCliStatus]);

  const handleFinish = async () => {
    setFinishing(true);
    setSaveError(false);
    try {
      await saveSettingsPatch({
        language,
        companyName,
        ceoName,
        defaultProvider: provider,
        onboarding_completed: true,
      });
      writeStoredValue(LANGUAGE_STORAGE_KEY, language);
      writeStoredValue(LANGUAGE_USER_SET_STORAGE_KEY, "1");
      window.dispatchEvent(new Event("ironcrew-language-change"));
      onComplete();
    } catch {
      setSaveError(true);
    } finally {
      setFinishing(false);
    }
  };

  const progressPct = ((step + 1) / STEPS.length) * 100;

  return (
    <I18nProvider language={language}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "var(--bg-base)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          overflowY: "auto",
        }}
      >
        {/* Top progress bar */}
        <div style={{ width: "100%", height: 3, background: "var(--border)", flexShrink: 0 }}>
          <div
            style={{
              height: "100%",
              background: "var(--accent)",
              width: `${progressPct}%`,
              transition: "width 0.3s ease",
              boxShadow: "0 0 8px var(--accent)",
            }}
          />
        </div>

        {/* Step indicator */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "20px 24px 0",
            alignSelf: "flex-start",
          }}
        >
          {STEPS.map((label, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: i < step ? "var(--accent)" : i === step ? "var(--accent)" : "var(--border)",
                    border: i === step ? "2px solid var(--accent)" : "2px solid transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: i <= step ? "#0d0d0f" : "var(--text-muted)",
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {i < step ? "✓" : i + 1}
                </div>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: i === step ? "var(--text-primary)" : "var(--text-muted)",
                    display: "none",
                  }}
                  className="sm:inline"
                >
                  {t(label)}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  style={{
                    width: 24,
                    height: 1,
                    background: i < step ? "var(--accent)" : "var(--border)",
                  }}
                />
              )}
            </div>
          ))}
        </div>

        <label className="mt-4 flex items-center gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
          {t({ en: "Language", de: "Sprache" })}
          <select
            value={language}
            onChange={(event) => setLanguage(normalizeLanguage(event.target.value))}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              padding: "8px 12px",
              borderRadius: 6,
            }}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        {/* Main content area */}
        <div
          style={{
            flex: 1,
            width: "100%",
            maxWidth: 640,
            padding: "40px 24px 48px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "32px 28px",
            }}
          >
            {step === 0 && (
              <WelcomeStep
                companyName={companyName}
                ceoName={ceoName}
                onNext={({ companyName: cn, ceoName: ce }) => {
                  setCompanyName(cn);
                  setCeoName(ce);
                  setStep(1);
                }}
              />
            )}

            {step === 1 && (
              <ProviderStep
                defaultProvider={provider}
                cliStatus={cliStatus}
                onNext={(p) => {
                  setProvider(p);
                  setStep(2);
                }}
                onBack={() => setStep(0)}
                onAuthSuccess={() => {
                  getCliStatus(true)
                    .then(setLocalCliStatus)
                    .catch(() => {});
                }}
              />
            )}

            {step === 2 && <ExtrasStep onNext={() => setStep(3)} onBack={() => setStep(1)} />}

            {step === 3 && <KnowledgeStep onNext={() => setStep(4)} onBack={() => setStep(2)} />}

            {step === 4 && (
              <>
                {saveError && (
                  <div
                    style={{
                      padding: "10px 14px",
                      marginBottom: 16,
                      background: "#2d1215",
                      border: "1px solid #ef4444",
                      borderRadius: 6,
                      color: "#ef4444",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}
                  >
                    {t({
                      en: "Failed to save settings. Please try again.",
                      de: "Einstellungen konnten nicht gespeichert werden. Bitte versuche es erneut.",
                    })}
                  </div>
                )}
                <ReadyStep
                  setupStatus={setupStatus}
                  onFinish={finishing ? () => undefined : handleFinish}
                  onBack={() => setStep(3)}
                />
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            paddingBottom: 20,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: "var(--text-muted)",
          }}
        >
          {t({
            en: `IronCrew — Step ${step + 1} of ${STEPS.length}`,
            de: `IronCrew — Schritt ${step + 1} von ${STEPS.length}`,
          })}
        </div>
      </div>
    </I18nProvider>
  );
}
