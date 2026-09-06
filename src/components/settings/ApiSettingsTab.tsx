import LocalizedText from "../LocalizedText";
import { API_TYPE_PRESETS } from "./constants";
import ApiAssignModal from "./ApiAssignModal";
import type { ApiStateBundle, TFunction } from "./types";
import { DEFAULT_API_FORM } from "./useApiProvidersState";

interface ApiSettingsTabProps {
  t: TFunction;
  localeTag: string;
  apiState: ApiStateBundle;
}

export default function ApiSettingsTab({ t, localeTag, apiState }: ApiSettingsTabProps) {
  const {
    apiProviders,
    apiProvidersLoading,
    apiAddMode,
    apiEditingId,
    apiForm,
    apiSaving,
    apiTesting,
    apiTestResult,
    apiModelsExpanded,
    setApiAddMode,
    setApiEditingId,
    setApiForm,
    setApiModelsExpanded,
    loadApiProviders,
    handleApiProviderSave,
    handleApiProviderDelete,
    handleApiProviderTest,
    handleApiProviderToggle,
    handleApiEditStart,
    handleApiModelAssign,
  } = apiState;

  return (
    <>
      <section
        className="space-y-4 rounded-xl border p-4 sm:p-5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "API Providers", de: "API-Anbieter" })}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadApiProviders()}
              disabled={apiProvidersLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
            >
              🔄 {t({ en: "Refresh", de: "Aktualisieren" })}
            </button>
            {!apiAddMode && (
              <button
                onClick={() => {
                  setApiAddMode(true);
                  setApiEditingId(null);
                  setApiForm(DEFAULT_API_FORM);
                }}
                className="text-xs px-3 py-1 rounded-lg border font-medium transition-colors"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--text-primary, #e4e4e7)",
                }}
              >
                + {t({ en: "Add", de: "Hinzufügen" })}
              </button>
            )}
          </div>
        </div>

        <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "Register APIs for local models (Ollama, etc.), frontier models (OpenAI, Anthropic, etc.), and other services.",
            de: "APIs für lokale Modelle (Ollama usw.), Frontier-Modelle (OpenAI, Anthropic usw.) und andere Dienste registrieren.",
          })}
        </p>

        {apiAddMode && (
          <div
            className="space-y-3 rounded-lg border p-4"
            style={{ borderColor: "var(--bg-glow)", background: "var(--th-input-bg)" }}
          >
            <h4
              className="text-[9px] uppercase tracking-[0.05em]"
              style={{ fontFamily: "'Press Start 2P', monospace", color: "var(--text-muted, #71717a)" }}
            >
              {apiEditingId
                ? t({ en: "Edit Provider", de: "Anbieter bearbeiten" })
                : t({ en: "Add New Provider", de: "Neuen Anbieter hinzufügen" })}
            </h4>

            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Type", de: "Typ" })}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {(
                  Object.entries(API_TYPE_PRESETS) as [
                    keyof typeof API_TYPE_PRESETS,
                    { label: string; base_url: string; allow_local?: boolean },
                  ][]
                )?.map(([key, preset]) => (
                  <button
                    key={key}
                    onClick={() => {
                      setApiForm((prev) => ({
                        ...prev,
                        type: key,
                        base_url: preset.base_url || prev.base_url,
                        name: prev.name || preset.label,
                        allow_local: !!preset.allow_local,
                      }));
                    }}
                    className="px-2.5 py-1 text-[11px] rounded-md border transition-colors"
                    style={
                      apiForm.type === key
                        ? {
                            background: "var(--accent-dim)",
                            borderColor: "var(--accent)",
                            color: "var(--accent)",
                          }
                        : {
                            borderColor: "var(--bg-glow)",
                            color: "var(--text-secondary, #a1a1aa)",
                          }
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Name", de: "Name" })}
              </label>
              <input
                type="text"
                value={apiForm.name}
                onChange={(e) => setApiForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t({ en: "e.g. My OpenAI", de: "z. B. My OpenAI" })}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
            </div>

            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
                <LocalizedText en="Base URL" de="Basis-URL" />
              </label>
              <input
                type="text"
                value={apiForm.base_url}
                onChange={(e) => setApiForm((prev) => ({ ...prev, base_url: e.target.value }))}
                placeholder="https://api.openai.com/v1"
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
            </div>

            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
                <LocalizedText en="API Key" de="API-Schlüssel" />{" "}
                {apiForm.type === "ollama" && (
                  <span className="text-[var(--text-muted)]">
                    ({t({ en: "usually not needed for local", de: "für lokale Nutzung meist nicht nötig" })})
                  </span>
                )}
              </label>
              <input
                type="password"
                value={apiForm.api_key}
                onChange={(e) => setApiForm((prev) => ({ ...prev, api_key: e.target.value }))}
                placeholder={
                  apiEditingId
                    ? t({ en: "Enter to change (blank=keep)", de: "Zum Ändern eingeben (leer = beibehalten)" })
                    : "sk-..."
                }
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={apiForm.allow_local}
                onChange={(e) => setApiForm((prev) => ({ ...prev, allow_local: e.target.checked }))}
                className="accent-emerald-500"
              />
              <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  en: "Allow local/private network targets (Ollama, LM Studio, etc.)",
                  de: "Lokale/private Netzwerk-Ziele erlauben (Ollama, LM Studio usw.)",
                })}
              </span>
            </label>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleApiProviderSave()}
                disabled={apiSaving || !apiForm.name.trim() || !apiForm.base_url.trim()}
                className="px-4 py-2 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--text-primary, #e4e4e7)",
                }}
              >
                {apiSaving
                  ? t({ en: "Saving...", de: "Speichern..." })
                  : apiEditingId
                    ? t({ en: "Update", de: "Aktualisieren" })
                    : t({ en: "Add", de: "Hinzufügen" })}
              </button>
              <button
                onClick={() => {
                  setApiAddMode(false);
                  setApiEditingId(null);
                  setApiForm(DEFAULT_API_FORM);
                }}
                className="px-4 py-2 text-xs font-medium rounded-lg transition-colors"
                style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
              >
                {t({ en: "Cancel", de: "Abbrechen" })}
              </button>
            </div>
          </div>
        )}

        {apiProvidersLoading ? (
          <div className="text-xs animate-pulse py-4 text-center" style={{ color: "var(--th-text-muted)" }}>
            {t({ en: "Loading...", de: "Laden..." })}
          </div>
        ) : apiProviders.length === 0 && !apiAddMode ? (
          <div className="text-xs py-6 text-center" style={{ color: "var(--th-text-muted)" }}>
            {t({
              en: "No API providers registered. Click + Add above to get started.",
              de: "Keine API-Anbieter registriert. Klicken Sie oben auf + Hinzufügen.",
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {apiProviders.map((provider) => {
              const testResult = apiTestResult[provider.id];
              const isExpanded = apiModelsExpanded[provider.id];
              return (
                <div
                  key={provider.id}
                  className={`rounded-lg border p-3 transition-colors ${provider.enabled ? "" : "opacity-60"}`}
                  style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: provider.enabled ? "var(--accent)" : "var(--status-idle)" }}
                      />
                      <span className="text-sm font-medium truncate" style={{ color: "var(--th-text-heading)" }}>
                        {provider.name}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded uppercase flex-shrink-0"
                        style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
                      >
                        {provider.type}
                      </span>
                      {provider.has_api_key && <span className="text-[10px] text-emerald-400 flex-shrink-0">🔑</span>}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => void handleApiProviderTest(provider.id)}
                        disabled={apiTesting === provider.id}
                        className="text-[10px] px-2 py-1 rounded border transition-colors disabled:opacity-50"
                        style={{
                          borderColor: "var(--status-idle)",
                          background: "var(--border)",
                          color: "var(--text-secondary, #a1a1aa)",
                        }}
                        title={t({ en: "Test Connection", de: "Verbindung testen" })}
                      >
                        {apiTesting === provider.id ? "..." : t({ en: "Test", de: "Testen" })}
                      </button>
                      <button
                        onClick={() => handleApiEditStart(provider)}
                        className="text-[10px] px-2 py-1 rounded border transition-colors"
                        style={{
                          borderColor: "var(--status-idle)",
                          background: "var(--border)",
                          color: "var(--text-secondary, #a1a1aa)",
                        }}
                      >
                        {t({ en: "Edit", de: "Bearbeiten" })}
                      </button>
                      <button
                        onClick={() => void handleApiProviderToggle(provider.id, provider.enabled)}
                        className="text-[10px] px-2 py-1 rounded border transition-colors"
                        style={{
                          borderColor: "var(--status-idle)",
                          background: "var(--border)",
                          color: "var(--text-secondary, #a1a1aa)",
                        }}
                      >
                        {provider.enabled
                          ? t({ en: "Disable", de: "Deaktivieren" })
                          : t({ en: "Enable", de: "Aktivieren" })}
                      </button>
                      <button
                        onClick={() => void handleApiProviderDelete(provider.id)}
                        className="text-[10px] px-2 py-1 rounded border transition-colors"
                        style={{
                          borderColor: "rgba(255,100,100,0.3)",
                          background: "rgba(255,100,100,0.08)",
                          color: "#f87171",
                        }}
                      >
                        {t({ en: "Delete", de: "Löschen" })}
                      </button>
                    </div>
                  </div>

                  <div className="mt-1.5 text-[11px] font-mono truncate" style={{ color: "var(--th-text-muted)" }}>
                    {provider.base_url}
                  </div>

                  {testResult && (
                    <div
                      className={`mt-2 text-[11px] px-2.5 py-1.5 rounded ${
                        testResult.ok
                          ? "bg-green-500/10 text-green-400 border border-green-500/20"
                          : "bg-red-500/10 text-red-400 border border-red-500/20"
                      }`}
                    >
                      {testResult.ok ? "✓ " : "✗ "}
                      {testResult.msg}
                    </div>
                  )}

                  {provider.models_cache && provider.models_cache.length > 0 && (
                    <div className="mt-2">
                      <button
                        onClick={() => setApiModelsExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                        className="text-[11px] transition-colors"
                        style={{ color: "var(--th-text-secondary)" }}
                      >
                        {isExpanded ? "▼" : "▶"} {t({ en: "Models", de: "Modelle" })} ({provider.models_cache.length})
                        {provider.models_cached_at && (
                          <span className="text-[var(--text-muted)] ml-1">
                            ·{" "}
                            {new Date(provider.models_cached_at).toLocaleString(localeTag, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                      </button>
                      {isExpanded && (
                        <div
                          className="mt-1.5 max-h-48 overflow-y-auto rounded border p-2"
                          style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
                        >
                          {provider.models_cache.map((model) => (
                            <div
                              key={model}
                              className="flex items-center justify-between text-[11px] font-mono py-0.5 group/model rounded px-1 -mx-1"
                              style={{ color: "var(--th-text-secondary)" }}
                            >
                              <span className="truncate">{model}</span>
                              <button
                                onClick={() => void handleApiModelAssign(provider.id, model)}
                                className="text-[10px] px-1.5 py-0.5 rounded border opacity-0 group-hover/model:opacity-100 transition-opacity whitespace-nowrap ml-2"
                                style={{
                                  borderColor: "var(--border-strong)",
                                  background: "var(--bg-surface-hover)",
                                  color: "var(--text-primary, #e4e4e7)",
                                }}
                                title={t({ en: "Assign to agent", de: "Agent zuweisen" })}
                              >
                                {t({ en: "Assign", de: "Zuweisen" })}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ApiAssignModal t={t} localeTag={localeTag} apiState={apiState} />
    </>
  );
}
