import type { Agent } from "../../types";
import { CLI_LABELS, oauthAccountLabel, type TFunction } from "./constants";
import type { AgentDetailState } from "./useAgentDetailState";

const CLI_MODEL_OVERRIDE_PROVIDERS: Agent["cli_provider"][] = ["claude", "codex", "gemini", "opencode", "openclaw"];

interface CliEditorInlineProps {
  agent: Agent;
  state: AgentDetailState;
  t: TFunction;
}

export default function CliEditorInline({ agent, state, t }: CliEditorInlineProps) {
  const {
    editingCli,
    setEditingCli,
    selectedCli,
    setSelectedCli,
    selectedOAuthAccountId,
    setSelectedOAuthAccountId,
    selectedCliModel,
    setSelectedCliModel,
    selectedCliReasoningLevel,
    setSelectedCliReasoningLevel,
    selectedCliProfile,
    setSelectedCliProfile,
    savingCli,
    oauthLoading,
    cliModelsLoading,
    activeOAuthAccounts,
    requiresOAuthAccount,
    requiresApiProvider,
    supportsCliModelOverride,
    selectedCliModelOptions,
    codexReasoningOptions,
    canSaveCli,
    getReasoningDescription,
    handleSaveCli,
    handleCancelCliEdit,
  } = state;

  if (editingCli) {
    if (selectedCli === "codex") {
      return (
        <div className="space-y-1">
          <div className="flex w-full min-w-0 items-center gap-1 pb-0.5">
            <span className="shrink-0">🔧</span>
            <select
              value={selectedCli}
              onChange={(event) => {
                setSelectedCli(event.target.value as Agent["cli_provider"]);
                setSelectedCliModel("");
                setSelectedCliReasoningLevel("");
              }}
              className="w-[94px] shrink-0 text-xs rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
              style={{
                background: "var(--th-input-bg)",
                color: "var(--th-text-primary)",
                borderColor: "var(--th-input-border)",
                borderWidth: "1px",
                borderStyle: "solid",
              }}
            >
              {Object.entries(CLI_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            {cliModelsLoading ? (
              <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Loading models...", de: "Modelle werden geladen..." })}
              </span>
            ) : selectedCliModelOptions.length > 0 ? (
              <>
                <select
                  value={selectedCliModel}
                  onChange={(event) => {
                    const nextModel = event.target.value;
                    setSelectedCliModel(nextModel);
                    const nextMeta = selectedCliModelOptions.find((model) => model.slug === nextModel);
                    setSelectedCliReasoningLevel(nextMeta?.defaultReasoningLevel || "");
                  }}
                  className="w-0 min-w-0 flex-1 text-xs rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
                  style={{
                    background: "var(--th-input-bg)",
                    color: "var(--th-text-primary)",
                    borderColor: "var(--th-input-border)",
                    borderWidth: "1px",
                    borderStyle: "solid",
                  }}
                >
                  <option value="">{t({ en: "Default (Settings model)", de: "Standard (Einstellungsmodell)" })}</option>
                  {selectedCliModelOptions.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {model.displayName || model.slug}
                    </option>
                  ))}
                </select>
                {codexReasoningOptions.length > 0 && (
                  <select
                    value={selectedCliReasoningLevel}
                    onChange={(event) => setSelectedCliReasoningLevel(event.target.value)}
                    className="w-0 min-w-0 flex-1 text-xs rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
                    style={{
                      background: "var(--th-input-bg)",
                      color: "var(--th-text-primary)",
                      borderColor: "var(--th-input-border)",
                      borderWidth: "1px",
                      borderStyle: "solid",
                    }}
                  >
                    <option value="">
                      {t({ en: "Default (Settings reasoning)", de: "Standard (Einstellungsargumentation)" })}
                    </option>
                    {codexReasoningOptions.map((level) => (
                      <option key={level.effort} value={level.effort}>
                        {level.effort}
                        {getReasoningDescription(level.effort, level.description)
                          ? ` (${getReasoningDescription(level.effort, level.description)})`
                          : ""}
                      </option>
                    ))}
                  </select>
                )}
              </>
            ) : (
              <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "No model list available", de: "Keine Modellliste verfügbar" })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Sub-agent model follows Settings", de: "Unteragenten-Modell folgt den Einstellungen" })}
            </span>
            <button
              disabled={savingCli || !canSaveCli}
              onClick={() => {
                void handleSaveCli();
              }}
              className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            >
              {savingCli ? "..." : t({ en: "Save", de: "Speichern" })}
            </button>
            <button
              onClick={handleCancelCliEdit}
              className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
              style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
            >
              {t({ en: "Cancel", de: "Abbrechen" })}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-1">
        <span>🔧</span>
        <select
          value={selectedCli}
          onChange={(event) => {
            setSelectedCli(event.target.value as Agent["cli_provider"]);
            setSelectedCliModel("");
            setSelectedCliReasoningLevel("");
          }}
          className="text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            color: "var(--th-text-primary)",
            borderColor: "var(--th-input-border)",
            borderWidth: "1px",
            borderStyle: "solid",
          }}
        >
          {Object.entries(CLI_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {requiresOAuthAccount &&
          (oauthLoading ? (
            <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Loading accounts...", de: "Konten werden geladen..." })}
            </span>
          ) : activeOAuthAccounts.length > 0 ? (
            <select
              value={selectedOAuthAccountId}
              onChange={(event) => setSelectedOAuthAccountId(event.target.value)}
              className="text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500 max-w-[170px]"
              style={{
                background: "var(--th-input-bg)",
                color: "var(--th-text-primary)",
                borderColor: "var(--th-input-border)",
                borderWidth: "1px",
                borderStyle: "solid",
              }}
            >
              {activeOAuthAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {oauthAccountLabel(account)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[10px] text-amber-300">
              {t({ en: "No active OAuth account", de: "Kein aktives OAuth-Konto" })}
            </span>
          ))}
        {requiresApiProvider && (
          <span className="text-[10px] text-amber-300">
            {t({ en: "⚙️ Assign models in Settings > API tab", de: "⚙️ Modelle in Einstellungen > API-Tab zuweisen" })}
          </span>
        )}
        {selectedCli === "openclaw" && (
          <input
            type="text"
            value={selectedCliProfile}
            onChange={(event) => setSelectedCliProfile(event.target.value)}
            placeholder={t({ en: "Profile (e.g. qwen)", de: "Profil (z. B. qwen)" })}
            className="text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500 max-w-[130px]"
            style={{
              background: "var(--th-input-bg)",
              color: "var(--th-text-primary)",
              borderColor: "var(--th-input-border)",
              borderWidth: "1px",
              borderStyle: "solid",
            }}
          />
        )}
        {supportsCliModelOverride &&
          (cliModelsLoading ? (
            <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Loading models...", de: "Modelle werden geladen..." })}
            </span>
          ) : selectedCliModelOptions.length > 0 ? (
            <>
              <select
                value={selectedCliModel}
                onChange={(event) => {
                  const nextModel = event.target.value;
                  setSelectedCliModel(nextModel);
                }}
                className="text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500 max-w-[210px]"
                style={{
                  background: "var(--th-input-bg)",
                  color: "var(--th-text-primary)",
                  borderColor: "var(--th-input-border)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                }}
              >
                <option value="">{t({ en: "Default (Settings model)", de: "Standard (Einstellungsmodell)" })}</option>
                {selectedCliModelOptions.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.displayName || model.slug}
                  </option>
                ))}
              </select>
              <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Sub-agent model follows Settings", de: "Unteragenten-Modell folgt den Einstellungen" })}
              </span>
            </>
          ) : (
            <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "No model list available", de: "Keine Modellliste verfügbar" })}
            </span>
          ))}
        <button
          disabled={savingCli || !canSaveCli}
          onClick={() => {
            void handleSaveCli();
          }}
          className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
        >
          {savingCli ? "..." : t({ en: "Save", de: "Speichern" })}
        </button>
        <button
          onClick={handleCancelCliEdit}
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
          style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
        >
          {t({ en: "Cancel", de: "Abbrechen" })}
        </button>
      </div>
    );
  }

  // Display mode (not editing)
  return (
    <button
      onClick={() => setEditingCli(true)}
      className="flex items-center gap-1 transition-colors hover:opacity-80"
      title={t({ en: "Click to change CLI", de: "Klicken zum CLI-Wechsel" })}
    >
      🔧{" "}
      {agent.cli_provider === "api" && agent.api_model
        ? `API: ${agent.api_model}`
        : agent.cli_provider === "openclaw"
          ? `OpenClaw${agent.cli_profile ? ` · ${agent.cli_profile}` : ""}${agent.cli_model ? ` · ${agent.cli_model}` : ""}`
          : agent.cli_model && CLI_MODEL_OVERRIDE_PROVIDERS.includes(agent.cli_provider) && agent.cli_provider !== "api"
            ? `${CLI_LABELS[agent.cli_provider] ?? agent.cli_provider} · ${agent.cli_model}${agent.cli_provider === "codex" && agent.cli_reasoning_level ? ` (${agent.cli_reasoning_level})` : ""}`
            : agent.cli_provider === "codex" && agent.cli_reasoning_level
              ? `${CLI_LABELS[agent.cli_provider] ?? agent.cli_provider} · (${agent.cli_reasoning_level})`
              : (CLI_LABELS[agent.cli_provider] ?? agent.cli_provider)}
      <span className="text-[9px] ml-0.5" style={{ color: "var(--th-text-muted)" }}>
        ✏️
      </span>
    </button>
  );
}
