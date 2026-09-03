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
        {t({ ko: "인증 상태", en: "Auth Status", ja: "認証状態", zh: "Auth Status", de: "Authentifizierungsstatus" })}
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
                    {t({ ko: "CLI 감지", en: "CLI detected", ja: "CLI 検出", zh: "CLI detected", de: "CLI erkannt" })}
                  </span>
                )}
                {isWebOAuth && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                    {t({ ko: "웹 OAuth", en: "Web OAuth", ja: "Web OAuth", zh: "Web OAuth", de: "Web OAuth" })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {!isRunnable ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                    {t({
                      ko: "감지됨 (실행 불가)",
                      en: "Detected (not runnable)",
                      ja: "検出済み（実行不可）",
                      zh: "Detected (not runnable)",
                      de: "Erkannt (nicht ausführbar)",
                    })}
                  </span>
                ) : !isExpired ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                    {info.lastRefreshed
                      ? t({
                          ko: "자동 갱신됨",
                          en: "Auto-refreshed",
                          ja: "自動更新済",
                          zh: "Auto-refreshed",
                          de: "Automatisch erneuert",
                        })
                      : t({ ko: "연결됨", en: "Connected", ja: "接続中", zh: "Connected", de: "Verbunden" })}
                  </span>
                ) : info.refreshFailed ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">
                    {t({
                      ko: "갱신 실패",
                      en: "Refresh failed",
                      ja: "更新失敗",
                      zh: "Refresh failed",
                      de: "Aktualisierung fehlgeschlagen",
                    })}
                  </span>
                ) : isExpired && !info.hasRefreshToken ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({
                      ko: "만료됨 — 재인증 필요",
                      en: "Expired — re-auth needed",
                      ja: "期限切れ — 再認証が必要",
                      zh: "Expired — re-auth needed",
                      de: "Abgelaufen — erneute Authentifizierung erforderlich",
                    })}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({ ko: "만료됨", en: "Expired", ja: "期限切れ", zh: "Expired", de: "Abgelaufen" })}
                  </span>
                )}

                {info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => void onRefreshToken(provider as OAuthConnectProvider)}
                    disabled={refreshing === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors disabled:opacity-50"
                  >
                    {refreshing === provider
                      ? t({
                          ko: "갱신 중...",
                          en: "Refreshing...",
                          ja: "更新中...",
                          zh: "Refreshing...",
                          de: "Wird aktualisiert...",
                        })
                      : t({ ko: "갱신", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
                  </button>
                )}

                {isExpired && !info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => onConnect(provider as OAuthConnectProvider)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  >
                    {t({ ko: "재연결", en: "Reconnect", ja: "再接続", zh: "Reconnect", de: "Erneut verbinden" })}
                  </button>
                )}

                {isWebOAuth && (
                  <button
                    onClick={() => void onDisconnect(provider as OAuthConnectProvider)}
                    disabled={disconnecting === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 transition-colors disabled:opacity-50"
                  >
                    {disconnecting === provider
                      ? t({
                          ko: "해제 중...",
                          en: "Disconnecting...",
                          ja: "切断中...",
                          zh: "Disconnecting...",
                          de: "Wird getrennt...",
                        })
                      : t({ ko: "연결 해제", en: "Disconnect", ja: "接続解除", zh: "Disconnect", de: "Trennen" })}
                  </button>
                )}
              </div>
            </div>

            {info.requiresWebOAuth && (
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
                {t({
                  ko: "CLI에서 감지된 자격 증명은 OctoOffice 실행에 직접 사용되지 않습니다. Web OAuth로 다시 연결하세요.",
                  en: "CLI-detected credentials are not used directly for OctoOffice execution. Reconnect with Web OAuth.",
                  ja: "CLI 検出の資格情報は OctoOffice 実行では直接利用されません。Web OAuth で再接続してください。",
                  zh: "CLI-detected credentials are not used directly for OctoOffice execution. Reconnect with Web OAuth.",
                  de: "CLI-erkannte Anmeldedaten werden nicht direkt für die OctoOffice-Ausführung verwendet. Bitte über Web OAuth erneut verbinden.",
                })}
              </div>
            )}

            {(info.scope || expiresAt || info.created_at > 0) && (
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                {info.scope && (
                  <div className="col-span-2">
                    <span style={{ color: "var(--th-text-muted)" }}>
                      {t({ ko: "스코프", en: "Scope", ja: "スコープ", zh: "Scope", de: "Bereich" })}:{" "}
                    </span>
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
                    <span style={{ color: "var(--th-text-muted)" }}>
                      {t({ ko: "만료", en: "Expires", ja: "期限", zh: "Expires", de: "Läuft ab" })}:{" "}
                    </span>
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
                    <span style={{ color: "var(--th-text-muted)" }}>
                      {t({ ko: "등록", en: "Created", ja: "登録", zh: "Created", de: "Erstellt" })}:{" "}
                    </span>
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
                    {t({ ko: "모델:", en: "Model:", ja: "モデル:", zh: "Model:", de: "Modell:" })}
                  </span>
                  {modelsLoading ? (
                    <span className="text-xs animate-pulse" style={{ color: "var(--th-text-muted)" }}>
                      {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
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
                      {!currentModel && (
                        <option value="">
                          {t({
                            ko: "선택하세요...",
                            en: "Select...",
                            ja: "選択してください...",
                            zh: "Select...",
                            de: "Auswählen...",
                          })}
                        </option>
                      )}
                      {modelList.map((model, idx) => (
                        <option key={`${model}-${idx}`} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {t({
                          ko: "모델 목록 없음",
                          en: "No models",
                          ja: "モデル一覧なし",
                          zh: "No models",
                          de: "Keine Modelle",
                        })}
                      </span>
                      {provider === "github-copilot" && (
                        <span className="text-[11px] text-amber-400/80">
                          {t({
                            ko: "GitHub Copilot 구독이 없으면 모델을 사용할 수 없습니다. 리포 가져오기만 사용하려면 무시해도 됩니다.",
                            en: "Models require a GitHub Copilot subscription. You can ignore this if you only need repo import.",
                            ja: "モデル利用には GitHub Copilot サブスクリプションが必要です。リポインポートのみなら無視できます。",
                            zh: "Models require a GitHub Copilot subscription. You can ignore this if you only need repo import.",
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
                    {t({
                      ko: "계정 풀",
                      en: "Account Pool",
                      ja: "アカウントプール",
                      zh: "Account Pool",
                      de: "Kontopool",
                    })}
                  </div>
                  <div className="text-[10px] text-right" style={{ color: "var(--th-text-muted)" }}>
                    {t({
                      ko: "여러 계정을 동시에 활성 가능 · 우선순위 숫자가 낮을수록 먼저 시도",
                      en: "Multiple active accounts supported · lower priority runs first",
                      ja: "複数アクティブ対応 · 優先度の数字が小さいほど先に実行",
                      zh: "Multiple active accounts supported · lower priority runs first",
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
                          {account.active
                            ? t({ ko: "활성", en: "Active", ja: "有効", zh: "Active", de: "Aktiv" })
                            : t({ ko: "대기", en: "Standby", ja: "待機", zh: "Standby", de: "Bereitschaft" })}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            account.executionReady ? "bg-blue-500/20 text-blue-300" : "bg-amber-500/20 text-amber-300"
                          }`}
                        >
                          {account.executionReady
                            ? t({ ko: "실행 가능", en: "Runnable", ja: "実行可能", zh: "Runnable", de: "Ausführbar" })
                            : t({
                                ko: "실행 불가",
                                en: "Not runnable",
                                ja: "実行不可",
                                zh: "Not runnable",
                                de: "Nicht ausführbar",
                              })}
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
                            {t({ ko: "라벨", en: "Label", ja: "ラベル", zh: "Label", de: "Bezeichnung" })}
                          </span>
                          <input
                            value={draft.label}
                            onChange={(e) => onUpdateAccountDraft(account.id, { label: e.target.value })}
                            placeholder={t({
                              ko: "계정 별칭",
                              en: "Account alias",
                              ja: "アカウント別名",
                              zh: "Account alias",
                              de: "Kontoalias",
                            })}
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
                            {t({
                              ko: "모델 오버라이드",
                              en: "Model Override",
                              ja: "モデル上書き",
                              zh: "Model Override",
                              de: "Modell-Überschreibung",
                            })}
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
                              {t({
                                ko: "프로바이더 기본값 사용",
                                en: "Use provider default",
                                ja: "プロバイダ既定値を使用",
                                zh: "Use provider default",
                                de: "Anbieter-Standard verwenden",
                              })}
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
                            {t({ ko: "우선순위", en: "Priority", ja: "優先度", zh: "Priority", de: "Priorität" })}
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
                            ? t({
                                ko: "풀 해제",
                                en: "Pool Off",
                                ja: "プール解除",
                                zh: "Pool Off",
                                de: "Pool deaktivieren",
                              })
                            : t({
                                ko: "풀 추가",
                                en: "Pool On",
                                ja: "プール追加",
                                zh: "Pool On",
                                de: "Pool aktivieren",
                              })}
                        </button>

                        <button
                          onClick={() => void onSaveAccount(account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 disabled:opacity-50"
                        >
                          {t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
                        </button>

                        <button
                          onClick={() =>
                            void onToggleAccount(account.id, account.status === "active" ? "disabled" : "active")
                          }
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-amber-600/20 hover:bg-amber-600/35 text-amber-200 disabled:opacity-50"
                        >
                          {account.status === "active"
                            ? t({ ko: "비활성", en: "Disable", ja: "無効化", zh: "Disable", de: "Deaktivieren" })
                            : t({ ko: "활성화", en: "Enable", ja: "有効化", zh: "Enable", de: "Aktivieren" })}
                        </button>

                        <button
                          onClick={() => void onDeleteAccount(provider as OAuthConnectProvider, account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/35 text-red-300 disabled:opacity-50"
                        >
                          {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
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
