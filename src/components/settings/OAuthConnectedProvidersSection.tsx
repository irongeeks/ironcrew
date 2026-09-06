import type { OAuthConnectProvider } from "../../api";
import { OAUTH_INFO } from "./constants";
import { AntigravityLogo, GitHubCopilotLogo } from "./Logos";
import type { OAuthCommonProps } from "./types";

export default function OAuthConnectedProvidersSection({
  t,
  localeTag,
  form,
  setForm,
  persistSettings,
  oauthStatus,
  models,
  modelsLoading,
  refreshing,
  disconnecting,
  savingAccountId,
  accountDrafts,
  onConnect,
  onDisconnect,
  onRefreshToken,
  onUpdateAccountDraft,
  onActivateAccount,
  onSaveAccount,
  onToggleAccount,
  onDeleteAccount,
}: OAuthCommonProps) {
  const detectedProviders = Object.entries(oauthStatus.providers).filter(([, info]) =>
    Boolean(info.detected ?? info.connected),
  );
  if (detectedProviders.length === 0) return null;

  const logoMap: Record<string, ({ className }: { className?: string }) => React.ReactElement> = {
    "github-copilot": GitHubCopilotLogo,
    antigravity: AntigravityLogo,
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--th-text-muted)" }}>
        {t({ en: "Auth Status", de: "Authentifizierungsstatus" })}
      </div>
      {detectedProviders.map(([provider, info]) => {
        const oauthInfo = OAUTH_INFO[provider];
        const LogoComp = logoMap[provider];
        const expiresAt = info.expires_at ? new Date(info.expires_at) : null;
        const isExpired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        const isWebOAuth = info.source === "web-oauth";
        const isFileDetected = info.source === "file-detected";
        const isRunnable = Boolean(info.executionReady ?? info.connected);
        const accountList = info.accounts ?? [];

        return (
          <div
            key={provider}
            className="space-y-2 overflow-hidden rounded-lg p-4"
            style={{ background: "var(--th-bg-surface-hover)" }}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                {LogoComp ? <LogoComp className="w-5 h-5" /> : <span className="text-lg">🔑</span>}
                <span className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                  {oauthInfo?.label ?? provider}
                </span>
                {info.email && (
                  <span className="max-w-full break-all text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {info.email}
                  </span>
                )}
                {isFileDetected && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
                  >
                    {t({ en: "CLI detected", de: "CLI erkannt" })}
                  </span>
                )}
                {isWebOAuth && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                    {t({ en: "Web OAuth", de: "Web OAuth" })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {!isRunnable ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                    {t({ en: "Detected (not runnable)", de: "Erkannt (nicht ausführbar)" })}
                  </span>
                ) : !isExpired ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                    {info.lastRefreshed
                      ? t({ en: "Auto-refreshed", de: "Automatisch erneuert" })
                      : t({ en: "Connected", de: "Verbunden" })}
                  </span>
                ) : info.refreshFailed ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">
                    {t({ en: "Refresh failed", de: "Aktualisierung fehlgeschlagen" })}
                  </span>
                ) : isExpired && !info.hasRefreshToken ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({ en: "Expired — re-auth needed", de: "Abgelaufen — erneute Authentifizierung erforderlich" })}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({ en: "Expired", de: "Abgelaufen" })}
                  </span>
                )}

                {info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => void onRefreshToken(provider as OAuthConnectProvider)}
                    disabled={refreshing === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors disabled:opacity-50"
                  >
                    {refreshing === provider
                      ? t({ en: "Refreshing...", de: "Wird aktualisiert..." })
                      : t({ en: "Refresh", de: "Aktualisieren" })}
                  </button>
                )}

                {isExpired && !info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => onConnect(provider as OAuthConnectProvider)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  >
                    {t({ en: "Reconnect", de: "Erneut verbinden" })}
                  </button>
                )}

                {isWebOAuth && (
                  <button
                    onClick={() => void onDisconnect(provider as OAuthConnectProvider)}
                    disabled={disconnecting === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 transition-colors disabled:opacity-50"
                  >
                    {disconnecting === provider
                      ? t({ en: "Disconnecting...", de: "Wird getrennt..." })
                      : t({ en: "Disconnect", de: "Trennen" })}
                  </button>
                )}
              </div>
            </div>

            {info.requiresWebOAuth && (
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
                {t({
                  en: "CLI-detected credentials are not used directly for IronCrew execution. Reconnect with Web OAuth.",
                  de: "CLI-erkannte Anmeldedaten werden nicht direkt für die IronCrew-Ausführung verwendet. Bitte über Web OAuth erneut verbinden.",
                })}
              </div>
            )}

            {(info.scope || expiresAt || info.created_at > 0) && (
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                {info.scope && (
                  <div className="col-span-2">
                    <span style={{ color: "var(--th-text-muted)" }}>{t({ en: "Scope", de: "Bereich" })}: </span>
                    <span
                      className="break-all font-mono text-[10px] leading-relaxed"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {info.scope}
                    </span>
                  </div>
                )}
                {expiresAt && (
                  <div>
                    <span style={{ color: "var(--th-text-muted)" }}>{t({ en: "Expires", de: "Läuft ab" })}: </span>
                    <span
                      className={isExpired ? "text-red-400" : ""}
                      style={isExpired ? undefined : { color: "var(--th-text-secondary)" }}
                    >
                      {expiresAt.toLocaleString(localeTag)}
                    </span>
                  </div>
                )}
                {info.created_at > 0 && (
                  <div>
                    <span style={{ color: "var(--th-text-muted)" }}>{t({ en: "Created", de: "Erstellt" })}: </span>
                    <span style={{ color: "var(--th-text-secondary)" }}>
                      {new Date(info.created_at).toLocaleString(localeTag)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {(() => {
              const modelKey =
                provider === "github-copilot" ? "copilot" : provider === "antigravity" ? "antigravity" : null;
              if (!modelKey) return null;
              const modelList = models?.[modelKey];
              const currentModel = form.providerModelConfig?.[modelKey]?.model || "";

              return (
                <div className="flex min-w-0 flex-col items-stretch gap-1.5 pt-1 sm:flex-row sm:items-center sm:gap-2">
                  <span className="w-auto shrink-0 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "Model:", de: "Modell:" })}
                  </span>
                  {modelsLoading ? (
                    <span className="text-xs animate-pulse" style={{ color: "var(--th-text-muted)" }}>
                      {t({ en: "Loading...", de: "Laden..." })}
                    </span>
                  ) : modelList && modelList.length > 0 ? (
                    <select
                      value={currentModel}
                      onChange={(e) => {
                        const newConfig = {
                          ...form.providerModelConfig,
                          [modelKey]: { model: e.target.value },
                        };
                        const newForm = { ...form, providerModelConfig: newConfig };
                        setForm(newForm);
                        persistSettings(newForm);
                      }}
                      className="w-full min-w-0 rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none sm:flex-1"
                      style={{
                        background: "var(--th-input-bg)",
                        borderColor: "var(--th-input-border)",
                        color: "var(--th-text-primary)",
                      }}
                    >
                      {!currentModel && <option value="">{t({ en: "Select...", de: "Auswählen..." })}</option>}
                      {modelList.map((model, idx) => (
                        <option key={`${model}-${idx}`} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {t({ en: "No models", de: "Keine Modelle" })}
                      </span>
                      {provider === "github-copilot" && (
                        <span className="text-[11px] text-amber-400/80">
                          {t({
                            en: "Models require a GitHub Copilot subscription. You can ignore this if you only need repo import.",
                            de: "Für Modelle ist ein GitHub Copilot-Abonnement erforderlich. Bei ausschließlicher Nutzung des Repo-Imports kann dies ignoriert werden.",
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {accountList.length > 0 && (
              <div
                className="space-y-2 rounded-lg border p-2.5"
                style={{ borderColor: "var(--th-border-strong)", background: "var(--th-card-bg)" }}
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    {t({ en: "Account Pool", de: "Kontopool" })}
                  </div>
                  <div className="text-[10px] text-right" style={{ color: "var(--th-text-muted)" }}>
                    {t({
                      en: "Multiple active accounts supported · lower priority runs first",
                      de: "Mehrere aktive Konten unterstützt · niedrigere Prioritätszahl wird zuerst verwendet",
                    })}
                  </div>
                </div>

                {accountList.map((account) => {
                  const modelKey =
                    provider === "github-copilot" ? "copilot" : provider === "antigravity" ? "antigravity" : null;
                  const modelList = modelKey ? (models?.[modelKey] ?? []) : [];
                  const draft = accountDrafts[account.id] ?? {
                    label: account.label ?? "",
                    modelOverride: account.modelOverride ?? "",
                    priority: String(account.priority ?? 100),
                  };
                  const hasCustomOverride = Boolean(draft.modelOverride) && !modelList.includes(draft.modelOverride);

                  return (
                    <div
                      key={account.id}
                      className="rounded border p-2.5 space-y-2"
                      style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            account.active ? "bg-green-500/20 text-green-300" : ""
                          }`}
                          style={
                            account.active
                              ? undefined
                              : { background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }
                          }
                        >
                          {account.active ? t({ en: "Active", de: "Aktiv" }) : t({ en: "Standby", de: "Bereitschaft" })}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            account.executionReady ? "bg-blue-500/20 text-blue-300" : "bg-amber-500/20 text-amber-300"
                          }`}
                        >
                          {account.executionReady
                            ? t({ en: "Runnable", de: "Ausführbar" })
                            : t({ en: "Not runnable", de: "Nicht ausführbar" })}
                        </span>
                        {account.email && (
                          <span className="text-[11px] break-all" style={{ color: "var(--th-text-secondary)" }}>
                            {account.email}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <label className="space-y-1">
                          <span
                            className="block text-[10px] uppercase tracking-wider"
                            style={{ color: "var(--th-text-muted)" }}
                          >
                            {t({ en: "Label", de: "Bezeichnung" })}
                          </span>
                          <input
                            value={draft.label}
                            onChange={(e) => onUpdateAccountDraft(account.id, { label: e.target.value })}
                            placeholder={t({ en: "Account alias", de: "Kontoalias" })}
                            className="w-full rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                            style={{
                              background: "var(--th-input-bg)",
                              borderColor: "var(--th-input-border)",
                              color: "var(--th-text-primary)",
                            }}
                          />
                        </label>

                        <label className="space-y-1">
                          <span
                            className="block text-[10px] uppercase tracking-wider"
                            style={{ color: "var(--th-text-muted)" }}
                          >
                            {t({ en: "Model Override", de: "Modell-Überschreibung" })}
                          </span>
                          <select
                            value={draft.modelOverride}
                            onChange={(e) => onUpdateAccountDraft(account.id, { modelOverride: e.target.value })}
                            className="w-full rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                            style={{
                              background: "var(--th-input-bg)",
                              borderColor: "var(--th-input-border)",
                              color: "var(--th-text-primary)",
                            }}
                          >
                            <option value="">
                              {t({ en: "Use provider default", de: "Anbieter-Standard verwenden" })}
                            </option>
                            {hasCustomOverride && <option value={draft.modelOverride}>{draft.modelOverride}</option>}
                            {modelList.map((model, idx) => (
                              <option key={`${model}-${idx}`} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="space-y-1">
                          <span
                            className="block text-[10px] uppercase tracking-wider"
                            style={{ color: "var(--th-text-muted)" }}
                          >
                            {t({ en: "Priority", de: "Priorität" })}
                          </span>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={draft.priority}
                            onChange={(e) => onUpdateAccountDraft(account.id, { priority: e.target.value })}
                            placeholder="100"
                            className="w-full rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                            style={{
                              background: "var(--th-input-bg)",
                              borderColor: "var(--th-input-border)",
                              color: "var(--th-text-primary)",
                            }}
                          />
                        </label>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <button
                          onClick={() =>
                            void onActivateAccount(provider as OAuthConnectProvider, account.id, account.active)
                          }
                          disabled={savingAccountId === account.id || account.status !== "active"}
                          className={`text-[11px] px-2 py-1 rounded disabled:opacity-50 ${
                            account.active
                              ? "bg-orange-600/20 hover:bg-orange-600/35 text-orange-200"
                              : "bg-blue-600/30 hover:bg-blue-600/45 text-blue-200"
                          }`}
                        >
                          {account.active
                            ? t({ en: "Pool Off", de: "Pool deaktivieren" })
                            : t({ en: "Pool On", de: "Pool aktivieren" })}
                        </button>

                        <button
                          onClick={() => void onSaveAccount(account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 disabled:opacity-50"
                        >
                          {t({ en: "Save", de: "Speichern" })}
                        </button>

                        <button
                          onClick={() =>
                            void onToggleAccount(account.id, account.status === "active" ? "disabled" : "active")
                          }
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-amber-600/20 hover:bg-amber-600/35 text-amber-200 disabled:opacity-50"
                        >
                          {account.status === "active"
                            ? t({ en: "Disable", de: "Deaktivieren" })
                            : t({ en: "Enable", de: "Aktivieren" })}
                        </button>

                        <button
                          onClick={() => void onDeleteAccount(provider as OAuthConnectProvider, account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/35 text-red-300 disabled:opacity-50"
                        >
                          {t({ en: "Delete", de: "Löschen" })}
                        </button>
                      </div>

                      {account.lastError && (
                        <div className="text-[10px] text-red-300 break-words">{account.lastError}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
