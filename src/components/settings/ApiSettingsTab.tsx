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
            {t({
              ko: "API 프로바이더",
              en: "API Providers",
              ja: "API プロバイダー",
              zh: "API Providers",
              de: "API-Anbieter",
            })}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadApiProviders()}
              disabled={apiProvidersLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
            >
              🔄 {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
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
                + {t({ ko: "추가", en: "Add", ja: "追加", zh: "Add", de: "Hinzufügen" })}
              </button>
            )}
          </div>
        </div>

        <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "로컬 모델(Ollama 등), 프론티어 모델(OpenAI, Anthropic 등), 기타 서비스의 API를 등록하여 언어모델에 접근합니다.",
            en: "Register APIs for local models (Ollama, etc.), frontier models (OpenAI, Anthropic, etc.), and other services.",
            ja: "ローカルモデル（Ollama等）、フロンティアモデル（OpenAI, Anthropic等）、その他サービスのAPIを登録します。",
            zh: "Register APIs for local models (Ollama, etc.), frontier models (OpenAI, Anthropic, etc.), and other services.",
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
                ? t({
                    ko: "프로바이더 수정",
                    en: "Edit Provider",
                    ja: "プロバイダー編集",
                    zh: "Edit Provider",
                    de: "Anbieter bearbeiten",
                  })
                : t({
                    ko: "새 프로바이더 추가",
                    en: "Add New Provider",
                    ja: "新規プロバイダー追加",
                    zh: "Add New Provider",
                    de: "Neuen Anbieter hinzufügen",
                  })}
            </h4>

            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "유형", en: "Type", ja: "タイプ", zh: "Type", de: "Typ" })}
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
                {t({ ko: "이름", en: "Name", ja: "名前", zh: "Name", de: "Name" })}
              </label>
              <input
                type="text"
                value={apiForm.name}
                onChange={(e) => setApiForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t({
                  ko: "예: My OpenAI",
                  en: "e.g. My OpenAI",
                  ja: "例: My OpenAI",
                  zh: "e.g. My OpenAI",
                  de: "z. B. My OpenAI",
                })}
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
                Base URL
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
                API Key{" "}
                {apiForm.type === "ollama" && (
                  <span className="text-[var(--text-muted)]">
                    (
                    {t({
                      ko: "로컬은 보통 불필요",
                      en: "usually not needed for local",
                      ja: "ローカルは通常不要",
                      zh: "usually not needed for local",
                      de: "für lokale Nutzung meist nicht nötig",
                    })}
                    )
                  </span>
                )}
              </label>
              <input
                type="password"
                value={apiForm.api_key}
                onChange={(e) => setApiForm((prev) => ({ ...prev, api_key: e.target.value }))}
                placeholder={
                  apiEditingId
                    ? t({
                        ko: "변경하려면 입력 (빈칸=유지)",
                        en: "Enter to change (blank=keep)",
                        ja: "変更する場合は入力",
                        zh: "Enter to change (blank=keep)",
                        de: "Zum Ändern eingeben (leer = beibehalten)",
                      })
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
                  ko: "로컬/사설 네트워크 대상 허용 (Ollama, LM Studio 등)",
                  en: "Allow local/private network targets (Ollama, LM Studio, etc.)",
                  ja: "ローカル/プライベートネットワーク対象を許可 (Ollama, LM Studio等)",
                  zh: "Allow local/private network targets (Ollama, LM Studio, etc.)",
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
                  ? t({ ko: "저장 중...", en: "Saving...", ja: "保存中...", zh: "Saving...", de: "Speichern..." })
                  : apiEditingId
                    ? t({ ko: "수정", en: "Update", ja: "更新", zh: "Update", de: "Aktualisieren" })
                    : t({ ko: "추가", en: "Add", ja: "追가", zh: "Add", de: "Hinzufügen" })}
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
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
            </div>
          </div>
        )}

        {apiProvidersLoading ? (
          <div className="text-xs animate-pulse py-4 text-center" style={{ color: "var(--th-text-muted)" }}>
            {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
          </div>
        ) : apiProviders.length === 0 && !apiAddMode ? (
          <div className="text-xs py-6 text-center" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "등록된 API 프로바이더가 없습니다. 위의 + 추가 버튼으로 시작하세요.",
              en: "No API providers registered. Click + Add above to get started.",
              ja: "APIプロバイダーが登録されていません。上の+追加ボタンから始めてください。",
              zh: "No API providers registered. Click + Add above to get started.",
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
                        title={t({
                          ko: "연결 테스트",
                          en: "Test Connection",
                          ja: "接続テスト",
                          zh: "Test Connection",
                          de: "Verbindung testen",
                        })}
                      >
                        {apiTesting === provider.id
                          ? "..."
                          : t({ ko: "테스트", en: "Test", ja: "テスト", zh: "Test", de: "Testen" })}
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
                        {t({ ko: "수정", en: "Edit", ja: "編集", zh: "Edit", de: "Bearbeiten" })}
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
                          ? t({ ko: "비활성화", en: "Disable", ja: "無効化", zh: "Disable", de: "Deaktivieren" })
                          : t({ ko: "활성화", en: "Enable", ja: "有効化", zh: "Enable", de: "Aktivieren" })}
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
                        {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
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
                        {isExpanded ? "▼" : "▶"}{" "}
                        {t({ ko: "모델 목록", en: "Models", ja: "モデル一覧", zh: "Models", de: "Modelle" })} (
                        {provider.models_cache.length})
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
                                title={t({
                                  ko: "에이전트에 배정",
                                  en: "Assign to agent",
                                  ja: "エージェントに割り当て",
                                  zh: "Assign to agent",
                                  de: "Agent zuweisen",
                                })}
                              >
                                {t({ ko: "배정", en: "Assign", ja: "割当", zh: "Assign", de: "Zuweisen" })}
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
