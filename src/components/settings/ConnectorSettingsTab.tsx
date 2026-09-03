import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "./types";
import {
  fetchConnectors,
  fetchConnectorBindings,
  updateConnectorBindings,
  testConnector,
  type ConnectorInfo,
  type BindingConfig,
} from "../../api/connectors";
import { invalidateEditorCaches } from "../../api/workflow-packs";

interface ConnectorSettingsTabProps {
  t: TFunction;
}

export default function ConnectorSettingsTab({ t }: ConnectorSettingsTabProps) {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [bindings, setBindings] = useState<Record<string, BindingConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingConnector, setTestingConnector] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connectorsRes, bindingsRes] = await Promise.all([fetchConnectors(), fetchConnectorBindings()]);
      setConnectors(connectorsRes.connectors);
      setBindings(bindingsRes.bindings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Collect all known capabilities from all registered connectors
  const allCapabilities = Array.from(new Set(connectors.flatMap((c) => c.capabilities.map((cap) => cap.name)))).sort();

  const handleBindingChange = (capability: string, connectorName: string) => {
    setBindings((prev) => {
      if (!connectorName) {
        const next = { ...prev };
        delete next[capability];
        return next;
      }
      return {
        ...prev,
        [capability]: {
          ...prev[capability],
          connector: connectorName,
          connector_config: prev[capability]?.connector_config ?? {},
        },
      };
    });
  };

  const handleSaveBindings = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateConnectorBindings(bindings);
      invalidateEditorCaches();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (connectorName: string) => {
    setTestingConnector(connectorName);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[connectorName];
      return next;
    });
    try {
      const result = await testConnector(connectorName, {});
      setTestResults((prev) => ({ ...prev, [connectorName]: result }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [connectorName]: { ok: false, message: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTestingConnector(null);
    }
  };

  // Find which connectors support a given capability
  const connectorsForCapability = (capability: string): ConnectorInfo[] =>
    connectors.filter((c) => c.capabilities.some((cap) => cap.name === capability));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({
            ko: "커넥터 설정",
            en: "Connector Settings",
            ja: "コネクター設定",
            zh: "Connector Settings",
            de: "Connector-Einstellungen",
          })}
        </h3>
      </div>

      {/* Info box */}
      <div
        className="flex gap-3 rounded-lg border px-4 py-3 text-xs leading-relaxed"
        style={{
          borderColor: "rgba(100, 200, 120, 0.2)",
          background: "rgba(40, 80, 50, 0.15)",
          color: "var(--th-text-secondary)",
        }}
      >
        <span className="shrink-0 text-base">⚡</span>
        <div>
          <p style={{ color: "var(--th-text-primary)" }}>
            {t({
              ko: "커넥터는 외부 서비스에 대한 API 호출을 감싸는 래퍼입니다.",
              en: "Connectors are API wrappers for external services.",
              ja: "コネクターは外部サービスへのAPIラッパーです。",
              zh: "Connectors are API wrappers for external services.",
              de: "Connectors sind API-Wrapper für externe Services.",
            })}
          </p>
          <p className="mt-1" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "에이전트가 직접 API를 호출하는 대신, 커넥터가 자동으로 처리합니다. 예: ComfyUI로 이미지 생성, TTS로 음성 합성. 이전 단계의 출력 파일을 읽어 입력으로 사용합니다. LLM이 필요 없는 작업에 적합합니다.",
              en: "Instead of an agent calling APIs manually, connectors handle it automatically. Example: image generation via ComfyUI, voice synthesis via TTS. They read output files from previous phases as input. Ideal for tasks that don't need an LLM.",
              ja: "エージェントが手動でAPIを呼び出す代わりに、コネクターが自動処理します。例：ComfyUIでの画像生成、TTSでの音声合成。前フェーズの出力ファイルを入力として読み取ります。LLMが不要なタスクに最適です。",
              zh: "Instead of an agent calling APIs manually, connectors handle it automatically. Example: image generation via ComfyUI, voice synthesis via TTS. They read output files from previous phases as input. Ideal for tasks that don't need an LLM.",
              de: "Statt dass ein Agent APIs manuell aufruft, erledigen Connectors das automatisch. Beispiel: Bildgenerierung via ComfyUI, Sprachsynthese via TTS. Sie lesen Output-Dateien der vorherigen Phase als Input. Ideal für Aufgaben, die kein LLM brauchen.",
            })}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          Loading...
        </p>
      ) : (
        <>
          {/* ── Capability Bindings ── */}
          <section>
            <h4 className="mb-3 text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "기능 바인딩",
                en: "Capability Bindings",
                ja: "ケイパビリティ バインディング",
                zh: "Capability Bindings",
                de: "Fähigkeits-Bindungen",
              })}
            </h4>
            <p className="mb-3 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "각 기능을 처리할 커넥터를 선택하세요.",
                en: "Select which connector handles each capability.",
                ja: "各ケイパビリティを処理するコネクターを選択してください。",
                zh: "Select which connector handles each capability.",
                de: "Wählen Sie, welcher Connector jede Fähigkeit verarbeitet.",
              })}
            </p>

            {allCapabilities.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "등록된 기능이 없습니다.",
                  en: "No capabilities registered.",
                  ja: "登録されているケイパビリティはありません。",
                  zh: "No capabilities registered.",
                  de: "Keine Fähigkeiten registriert.",
                })}
              </p>
            ) : (
              <div className="space-y-2">
                {allCapabilities.map((capability) => {
                  const capConnectors = connectorsForCapability(capability);
                  const currentBinding = bindings[capability];
                  return (
                    <div
                      key={capability}
                      className="flex items-center gap-3 rounded-lg border px-4 py-3"
                      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                    >
                      <div className="min-w-0 flex-1">
                        <span
                          className="rounded px-2 py-0.5 font-mono text-xs"
                          style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                        >
                          {capability}
                        </span>
                      </div>
                      <select
                        value={currentBinding?.connector ?? ""}
                        onChange={(e) => handleBindingChange(capability, e.target.value)}
                        className="w-48 rounded border px-2 py-1.5 text-xs"
                        style={{
                          background: "var(--th-input-bg)",
                          borderColor: "var(--th-input-border)",
                          color: "var(--th-text-primary)",
                        }}
                      >
                        <option value="">
                          — {t({ ko: "없음", en: "none", ja: "なし", zh: "none", de: "keine" })} —
                        </option>
                        {capConnectors.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}

            {allCapabilities.length > 0 && (
              <button
                onClick={() => void handleSaveBindings()}
                disabled={saving}
                className="mt-4 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {saving
                  ? "..."
                  : saved
                    ? t({ ko: "저장됨", en: "Saved", ja: "保存済み", zh: "Saved", de: "Gespeichert" })
                    : t({
                        ko: "저장",
                        en: "Save Bindings",
                        ja: "バインドを保存",
                        zh: "Save Bindings",
                        de: "Bindungen speichern",
                      })}
              </button>
            )}
          </section>

          {/* ── Installed Connectors ── */}
          <section>
            <h4 className="mb-3 text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "설치된 커넥터",
                en: "Installed Connectors",
                ja: "インストール済みコネクター",
                zh: "Installed Connectors",
                de: "Installierte Connectors",
              })}
            </h4>

            {connectors.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "등록된 커넥터가 없습니다.",
                  en: "No connectors registered.",
                  ja: "登録されているコネクターはありません。",
                  zh: "No connectors registered.",
                  de: "Keine Connectors registriert.",
                })}
              </p>
            ) : (
              <div className="space-y-2">
                {connectors.map((connector) => {
                  const testResult = testResults[connector.name];
                  return (
                    <div
                      key={connector.name}
                      className="rounded-lg border px-4 py-3"
                      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-slate-200">{connector.name}</span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {connector.capabilities.map((cap) => (
                              <span
                                key={cap.name}
                                className="rounded px-1.5 py-0.5 text-[10px]"
                                style={{
                                  background: "var(--th-bg-surface-hover)",
                                  color: "var(--th-text-secondary)",
                                }}
                                title={cap.description}
                              >
                                {cap.name}
                              </span>
                            ))}
                          </div>
                          {testResult && (
                            <p className={`mt-1 text-[10px] ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                              {testResult.ok ? "✓" : "✗"} {testResult.message}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => void handleTest(connector.name)}
                          disabled={testingConnector === connector.name}
                          className="ml-3 shrink-0 rounded border px-2 py-1 text-[10px] disabled:opacity-50"
                          style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
                        >
                          {testingConnector === connector.name
                            ? "..."
                            : t({ ko: "테스트", en: "Test", ja: "テスト", zh: "Test", de: "Testen" })}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
