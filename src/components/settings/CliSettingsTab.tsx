import { useState } from "react";
import CliAuthModal from "../cli-auth/CliAuthModal";
import { CLI_INFO } from "./constants";
import type { CliSettingsTabProps } from "./types";

export default function CliSettingsTab({
  t,
  cliStatus,
  cliModels,
  cliModelsLoading,
  form,
  setForm,
  persistSettings,
  onRefresh,
}: CliSettingsTabProps) {
  const [authModalProvider, setAuthModalProvider] = useState<"claude" | "codex" | "gemini" | null>(null);
  const cliAuthProviders = ["claude", "codex", "gemini"];

  return (
    <section
      className="rounded-xl p-5 sm:p-6 space-y-5"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "CLI Tool Status", de: "CLI-Tool-Status" })}
        </h3>
        <button onClick={onRefresh} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          🔄 {t({ en: "Refresh", de: "Aktualisieren" })}
        </button>
      </div>

      {cliStatus ? (
        <div className="space-y-2">
          {Object.entries(cliStatus)
            .filter(([provider]) => !["copilot", "antigravity"].includes(provider))
            .map(([provider, status]) => {
              const info = CLI_INFO[provider];
              const isReady = status.installed && status.authenticated;
              const hasSubModel = provider === "claude" || provider === "codex";
              const modelList = cliModels?.[provider] ?? [];
              const currentModel = form.providerModelConfig?.[provider]?.model || "";
              const currentSubModel = form.providerModelConfig?.[provider]?.subModel || "";
              const currentReasoningLevel = form.providerModelConfig?.[provider]?.reasoningLevel || "";

              const selectedModel = modelList.find((m) => m.slug === currentModel);
              const reasoningLevels = selectedModel?.reasoningLevels;
              const defaultReasoning = selectedModel?.defaultReasoningLevel || "";

              return (
                <div
                  key={provider}
                  className="rounded-lg p-3 space-y-2"
                  style={{ background: "color-mix(in srgb, var(--th-bg-surface-hover) 30%, transparent)" }}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{info?.icon ?? "?"}</span>
                    <div className="flex-1">
                      <div className="text-sm" style={{ color: "var(--th-text-heading)" }}>
                        {info?.label ?? provider}
                      </div>
                      <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {status.version ??
                          (status.installed
                            ? t({ en: "Version unknown", de: "Version unbekannt" })
                            : t({ en: "Not installed", de: "Nicht installiert" }))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          status.installed ? "bg-green-500/20 text-green-400" : ""
                        }`}
                        style={
                          status.installed
                            ? undefined
                            : {
                                background: "color-mix(in srgb, var(--th-bg-surface-hover) 50%, transparent)",
                                color: "var(--th-text-secondary)",
                              }
                        }
                      >
                        {status.installed
                          ? t({ en: "Installed", de: "Installiert" })
                          : t({ en: "Not installed", de: "Nicht installiert" })}
                      </span>
                      {status.installed && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            status.authenticated ? "bg-blue-500/20 text-blue-400" : "bg-yellow-500/20 text-yellow-400"
                          }`}
                        >
                          {status.authenticated
                            ? t({ en: "Authenticated", de: "Authentifiziert" })
                            : t({ en: "Not Authenticated", de: "Nicht authentifiziert" })}
                        </span>
                      )}
                      {cliAuthProviders.includes(provider) && status.installed && !status.authenticated && (
                        <button
                          onClick={() => setAuthModalProvider(provider as "claude" | "codex" | "gemini")}
                          className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                        >
                          {t({ en: "Login", de: "Anmelden" })}
                        </button>
                      )}
                      {cliAuthProviders.includes(provider) && status.installed && status.authenticated && (
                        <button
                          onClick={() => setAuthModalProvider(provider as "claude" | "codex" | "gemini")}
                          className="text-xs px-2 py-0.5 rounded-lg bg-transparent hover:bg-blue-600/20 text-blue-400 transition-colors"
                          style={{ border: "1px solid color-mix(in srgb, var(--th-border) 50%, transparent)" }}
                        >
                          {t({ en: "Re-authenticate", de: "Erneut authentifizieren" })}
                        </button>
                      )}
                    </div>
                  </div>

                  {isReady && (
                    <div className="space-y-1.5 pl-0 sm:pl-8">
                      <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                        <span className="w-auto shrink-0 text-xs sm:w-20" style={{ color: "var(--th-text-secondary)" }}>
                          {hasSubModel
                            ? t({ en: "Main model:", de: "Hauptmodell:" })
                            : t({ en: "Model:", de: "Modell:" })}
                        </span>
                        {cliModelsLoading ? (
                          <span className="text-xs animate-pulse" style={{ color: "var(--th-text-muted)" }}>
                            {t({ en: "Loading...", de: "Laden..." })}
                          </span>
                        ) : modelList.length > 0 ? (
                          <select
                            value={currentModel}
                            onChange={(e) => {
                              const newSlug = e.target.value;
                              const newModel = modelList.find((m) => m.slug === newSlug);
                              const prev = form.providerModelConfig?.[provider] || {};
                              const newConfig = {
                                ...form.providerModelConfig,
                                [provider]: {
                                  ...prev,
                                  model: newSlug,
                                  reasoningLevel: newModel?.defaultReasoningLevel || undefined,
                                },
                              };
                              const newForm = { ...form, providerModelConfig: newConfig };
                              setForm(newForm);
                              persistSettings(newForm);
                            }}
                            className="w-full min-w-0 rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none sm:flex-1"
                            style={{
                              borderColor: "var(--th-border)",
                              background: "var(--th-input-bg)",
                              color: "var(--th-text-heading)",
                            }}
                          >
                            <option value="">{t({ en: "Default", de: "Standard" })}</option>
                            {modelList.map((m) => (
                              <option key={m.slug} value={m.slug}>
                                {m.displayName || m.slug}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {t({ en: "No models", de: "Keine Modelle" })}
                          </span>
                        )}
                      </div>

                      {provider === "codex" && reasoningLevels && reasoningLevels.length > 0 && (
                        <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                          <span
                            className="w-auto shrink-0 text-xs sm:w-20"
                            style={{ color: "var(--th-text-secondary)" }}
                          >
                            {t({ en: "Reasoning:", de: "Schlussfolgerung:" })}
                          </span>
                          <select
                            value={currentReasoningLevel || defaultReasoning}
                            onChange={(e) => {
                              const prev = form.providerModelConfig?.[provider] || { model: "" };
                              const newConfig = {
                                ...form.providerModelConfig,
                                [provider]: { ...prev, reasoningLevel: e.target.value },
                              };
                              const newForm = { ...form, providerModelConfig: newConfig };
                              setForm(newForm);
                              persistSettings(newForm);
                            }}
                            className="w-full min-w-0 rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none sm:flex-1"
                            style={{
                              borderColor: "var(--th-border)",
                              background: "var(--th-input-bg)",
                              color: "var(--th-text-heading)",
                            }}
                          >
                            {reasoningLevels.map((rl) => (
                              <option key={rl.effort} value={rl.effort}>
                                {rl.effort} ({rl.description})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {hasSubModel && (
                        <>
                          <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                            <span
                              className="w-auto shrink-0 text-xs sm:w-20"
                              style={{ color: "var(--th-text-secondary)" }}
                            >
                              {t({ en: "Sub-agent model:", de: "Subagent-Modell:" })}
                            </span>
                            {cliModelsLoading ? (
                              <span className="text-xs animate-pulse" style={{ color: "var(--th-text-muted)" }}>
                                {t({ en: "Loading...", de: "Laden..." })}
                              </span>
                            ) : modelList.length > 0 ? (
                              <select
                                value={currentSubModel}
                                onChange={(e) => {
                                  const newSlug = e.target.value;
                                  const newSubModel = modelList.find((m) => m.slug === newSlug);
                                  const prev = form.providerModelConfig?.[provider] || { model: "" };
                                  const newConfig = {
                                    ...form.providerModelConfig,
                                    [provider]: {
                                      ...prev,
                                      subModel: newSlug,
                                      subModelReasoningLevel: newSubModel?.defaultReasoningLevel || undefined,
                                    },
                                  };
                                  const newForm = { ...form, providerModelConfig: newConfig };
                                  setForm(newForm);
                                  persistSettings(newForm);
                                }}
                                className="w-full min-w-0 rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none sm:flex-1"
                                style={{
                                  borderColor: "var(--th-border)",
                                  background: "var(--th-input-bg)",
                                  color: "var(--th-text-heading)",
                                }}
                              >
                                <option value="">{t({ en: "Default", de: "Standard" })}</option>
                                {modelList.map((m) => (
                                  <option key={m.slug} value={m.slug}>
                                    {m.displayName || m.slug}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                                {t({ en: "No models", de: "Keine Modelle" })}
                              </span>
                            )}
                          </div>

                          {(() => {
                            const subSelected = modelList.find((m) => m.slug === currentSubModel);
                            const subLevels = subSelected?.reasoningLevels;
                            const subDefault = subSelected?.defaultReasoningLevel || "";
                            const currentSubRL = form.providerModelConfig?.[provider]?.subModelReasoningLevel || "";
                            if (provider !== "codex" || !subLevels || subLevels.length === 0) return null;
                            return (
                              <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                                <span
                                  className="w-auto shrink-0 text-xs sm:w-20"
                                  style={{ color: "var(--th-text-secondary)" }}
                                >
                                  {t({ en: "Sub reasoning:", de: "Subagent-Schlussfolgerung:" })}
                                </span>
                                <select
                                  value={currentSubRL || subDefault}
                                  onChange={(e) => {
                                    const prev = form.providerModelConfig?.[provider] || { model: "" };
                                    const newConfig = {
                                      ...form.providerModelConfig,
                                      [provider]: { ...prev, subModelReasoningLevel: e.target.value },
                                    };
                                    const newForm = { ...form, providerModelConfig: newConfig };
                                    setForm(newForm);
                                    persistSettings(newForm);
                                  }}
                                  className="w-full min-w-0 rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none sm:flex-1"
                                  style={{
                                    borderColor: "var(--th-border)",
                                    background: "var(--th-input-bg)",
                                    color: "var(--th-text-heading)",
                                  }}
                                >
                                  {subLevels.map((rl) => (
                                    <option key={rl.effort} value={rl.effort}>
                                      {rl.effort} ({rl.description})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      ) : (
        <div className="text-center py-4 text-sm" style={{ color: "var(--th-text-muted)" }}>
          {t({ en: "Loading...", de: "Laden..." })}
        </div>
      )}

      <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
        {t({
          en: "Each agent's CLI tool can be changed in Office by clicking an agent. Configure Copilot/Antigravity models in OAuth tab.",
          de: "Das CLI-Tool jedes Agenten kann im Büro durch Klicken auf einen Agenten geändert werden. Copilot/Antigravity-Modelle werden im OAuth-Tab konfiguriert.",
        })}
      </p>

      {authModalProvider && (
        <CliAuthModal
          provider={authModalProvider}
          open={!!authModalProvider}
          onClose={() => setAuthModalProvider(null)}
          onSuccess={() => {
            setAuthModalProvider(null);
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
