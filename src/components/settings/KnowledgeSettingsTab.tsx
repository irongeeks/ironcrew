import { useCallback, useEffect, useState } from "react";
import {
  createDocsProvider,
  createDocsProviderBinding,
  deleteDocsProvider,
  deleteDocsProviderBinding,
  getDocsProviderBindings,
  getDocsProviders,
  getProjects,
  testDocsProvider,
  updateDocsProvider,
} from "../../api";
import type { DocsProvider, DocsProviderBinding } from "../../api";
import type { Project } from "../../types";
import type { LocalSettings, SetLocalSettings, TFunction } from "./types";

interface KnowledgeSettingsTabProps {
  t: TFunction;
  form: LocalSettings;
  setForm: SetLocalSettings;
  persistSettings: (next: LocalSettings) => void;
}

interface ProviderFormState {
  name: string;
  vaultPath: string;
  readOnly: boolean;
}

const EMPTY_PROVIDER_FORM: ProviderFormState = { name: "", vaultPath: "", readOnly: false };

export default function KnowledgeSettingsTab({ t, form, setForm, persistSettings }: KnowledgeSettingsTabProps) {
  const [providers, setProviders] = useState<DocsProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(EMPTY_PROVIDER_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // bindings
  const [expandedBindings, setExpandedBindings] = useState<Record<string, boolean>>({});
  const [bindings, setBindings] = useState<Record<string, DocsProviderBinding[]>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [bindingProviderId, setBindingProviderId] = useState<string | null>(null);
  const [bindingProjectId, setBindingProjectId] = useState("");

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getDocsProviders();
      setProviders(list);
    } catch (err) {
      console.error("Failed to load docs providers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const handleSave = async () => {
    if (!providerForm.vaultPath.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await updateDocsProvider(editingId, {
          name: providerForm.name.trim() || undefined,
          vaultPath: providerForm.vaultPath.trim(),
          readOnly: providerForm.readOnly,
        });
      } else {
        await createDocsProvider({
          name: providerForm.name.trim() || "Obsidian Vault",
          vaultPath: providerForm.vaultPath.trim(),
          readOnly: providerForm.readOnly,
        });
      }
      setAddMode(false);
      setEditingId(null);
      setProviderForm(EMPTY_PROVIDER_FORM);
      await loadProviders();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !window.confirm(
        t({
          ko: "이 Vault 연결을 삭제하시겠습니까?",
          en: "Delete this vault connection?",
          ja: "この Vault 接続を削除しますか？",
          zh: "Delete this vault connection?",
          de: "Diese Vault-Verbindung löschen?",
        }),
      )
    )
      return;

    try {
      await deleteDocsProvider(id);
      await loadProviders();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testDocsProvider(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: result.reachable
          ? { ok: true, msg: `${result.previewCount ?? 0} notes found` }
          : { ok: false, msg: result.error ?? "Unreachable" },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (provider: DocsProvider) => {
    try {
      await updateDocsProvider(provider.id, { enabled: !provider.enabled });
      await loadProviders();
    } catch (err) {
      console.error("Toggle failed:", err);
    }
  };

  const handleEditStart = (provider: DocsProvider) => {
    setEditingId(provider.id);
    setAddMode(false);
    setProviderForm({ name: provider.name, vaultPath: provider.vaultPath, readOnly: provider.readOnly });
  };

  // ── Bindings ──────────────────────────────────────────────────────────────
  const loadBindings = async (providerId: string) => {
    try {
      const list = await getDocsProviderBindings(providerId);
      setBindings((prev) => ({ ...prev, [providerId]: list }));
    } catch (err) {
      console.error("Failed to load bindings:", err);
    }
  };

  const toggleBindings = async (providerId: string) => {
    const next = !expandedBindings[providerId];
    setExpandedBindings((prev) => ({ ...prev, [providerId]: next }));
    if (next) {
      await loadBindings(providerId);
      if (projects.length === 0) {
        try {
          const res = await getProjects({ page_size: 200 });
          setProjects(res.projects);
        } catch {
          // ignore
        }
      }
    }
  };

  const handleAddBinding = async (providerId: string) => {
    if (!bindingProjectId) return;
    try {
      await createDocsProviderBinding(providerId, { projectId: bindingProjectId });
      setBindingProjectId("");
      setBindingProviderId(null);
      await loadBindings(providerId);
    } catch (err) {
      console.error("Binding creation failed:", err);
    }
  };

  const handleDeleteBinding = async (providerId: string, bindingId: string) => {
    try {
      await deleteDocsProviderBinding(bindingId);
      await loadBindings(providerId);
    } catch (err) {
      console.error("Delete binding failed:", err);
    }
  };

  const toggleAutoBind = () => {
    const next = { ...form, knowledgeAutoBindDefault: !form.knowledgeAutoBindDefault };
    setForm(next);
    persistSettings(next);
  };

  return (
    <>
      {/* Auto-bind setting */}
      <section
        className="rounded-xl border p-4 sm:p-5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
          style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
        >
          <div>
            <label className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "자동 바인딩",
                en: "Auto-bind Vaults",
                ja: "自動バインド",
                zh: "Auto-bind Vaults",
                de: "Vaults automatisch binden",
              })}
            </label>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "새 프로젝트 생성 시 활성화된 모든 Vault를 자동으로 연결합니다",
                en: "Automatically bind all enabled vaults when creating new projects",
                ja: "新しいプロジェクト作成時に有効な全 Vault を自動的にバインドします",
                zh: "Automatically bind all enabled vaults when creating new projects",
                de: "Beim Erstellen neuer Projekte alle aktivierten Vaults automatisch verknüpfen",
              })}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={!!form.knowledgeAutoBindDefault}
            onClick={toggleAutoBind}
            className="relative h-7 w-12 flex-shrink-0 rounded-full transition-colors"
            style={{ background: form.knowledgeAutoBindDefault ? "var(--accent)" : "var(--border-strong)" }}
          >
            <div
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-all ${
                form.knowledgeAutoBindDefault ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </section>

      {/* Provider list */}
      <section
        className="space-y-4 rounded-xl border p-4 sm:p-5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "Obsidian Vault",
              en: "Obsidian Vaults",
              ja: "Obsidian Vault",
              zh: "Obsidian Vaults",
              de: "Obsidian Vaults",
            })}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadProviders()}
              disabled={loading}
              className="text-xs text-blue-400 transition-colors hover:text-blue-300 disabled:opacity-50"
            >
              {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
            </button>
            {!addMode && (
              <button
                onClick={() => {
                  setAddMode(true);
                  setEditingId(null);
                  setProviderForm(EMPTY_PROVIDER_FORM);
                }}
                className="rounded-lg border px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--text-primary, #e4e4e7)",
                }}
              >
                +{" "}
                {t({
                  ko: "Vault 추가",
                  en: "Add Vault",
                  ja: "Vault 追加",
                  zh: "Add Vault",
                  de: "Vault hinzufügen",
                })}
              </button>
            )}
          </div>
        </div>

        <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "Obsidian Vault를 연결하면 에이전트가 노트를 읽고 작성할 수 있습니다.",
            en: "Connect Obsidian vaults so agents can read and write notes as a shared knowledge base.",
            ja: "Obsidian Vault を接続すると、エージェントがノートの読み書きができます。",
            zh: "Connect Obsidian vaults so agents can read and write notes as a shared knowledge base.",
            de: "Obsidian-Vaults verbinden, damit Agenten Notizen als gemeinsame Wissensdatenbank lesen und schreiben können.",
          })}
        </p>

        {/* Add / Edit form */}
        {(addMode || editingId) && (
          <div
            className="space-y-3 rounded-lg border p-4"
            style={{ borderColor: "var(--th-border-strong)", background: "var(--th-input-bg)" }}
          >
            <h4 className="text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
              {editingId
                ? t({ ko: "Vault 수정", en: "Edit Vault", ja: "Vault 編集", zh: "Edit Vault", de: "Vault bearbeiten" })
                : t({
                    ko: "새 Vault 추가",
                    en: "Add New Vault",
                    ja: "新しい Vault 追가",
                    zh: "Add New Vault",
                    de: "Neues Vault hinzufügen",
                  })}
            </h4>

            <div className="space-y-2">
              <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "이름", en: "Name", ja: "名前", zh: "Name", de: "Name" })}
              </label>
              <input
                type="text"
                value={providerForm.name}
                onChange={(e) => setProviderForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My Vault"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "Vault 경로", en: "Vault Path", ja: "Vault パス", zh: "Vault Path", de: "Vault-Pfad" })}
              </label>
              <input
                type="text"
                value={providerForm.vaultPath}
                onChange={(e) => setProviderForm((f) => ({ ...f, vaultPath: e.target.value }))}
                placeholder="/home/user/my-vault"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "Obsidian Vault 폴더의 절대 경로",
                  en: "Absolute path to the Obsidian vault folder on this machine",
                  ja: "このマシン上の Obsidian Vault フォルダの絶対パス",
                  zh: "Absolute path to the Obsidian vault folder on this machine",
                  de: "Absoluter Pfad zum Obsidian-Vault-Ordner auf diesem Gerät",
                })}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={providerForm.readOnly}
                  onChange={(e) => setProviderForm((f) => ({ ...f, readOnly: e.target.checked }))}
                  className="rounded"
                  style={{ borderColor: "var(--th-input-border)" }}
                />
                {t({
                  ko: "읽기 전용",
                  en: "Read-only",
                  ja: "読み取り専用",
                  zh: "Read-only",
                  de: "Nur lesen",
                })}
              </label>
              <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "에이전트가 노트를 수정하지 못하게 합니다",
                  en: "Prevents agents from modifying notes",
                  ja: "エージェントによるノート変更を防止します",
                  zh: "Prevents agents from modifying notes",
                  de: "Verhindert, dass Agenten Notizen verändern",
                })}
              </span>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => void handleSave()}
                disabled={saving || !providerForm.vaultPath.trim()}
                className="rounded-lg border px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--text-primary, #e4e4e7)",
                }}
              >
                {saving
                  ? t({ ko: "저장 중...", en: "Saving...", ja: "保存中...", zh: "Saving...", de: "Speichern..." })
                  : t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
              </button>
              <button
                onClick={() => {
                  setAddMode(false);
                  setEditingId(null);
                  setProviderForm(EMPTY_PROVIDER_FORM);
                }}
                className="rounded-lg border px-4 py-1.5 text-xs transition-colors"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
              >
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
            </div>
          </div>
        )}

        {/* Provider cards */}
        {loading && providers.length === 0 ? (
          <div className="py-8 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>
            {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
          </div>
        ) : providers.length === 0 && !addMode ? (
          <div className="py-8 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "연결된 Vault가 없습니다",
              en: "No vaults connected yet",
              ja: "Vault が接続されていません",
              zh: "No vaults connected yet",
              de: "Noch keine Vaults verbunden",
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="rounded-lg border p-4 transition-colors"
                style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: provider.enabled ? "var(--accent)" : "var(--status-idle)" }}
                      />
                      <h4 className="truncate text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                        {provider.name}
                      </h4>
                      {provider.readOnly && (
                        <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-400">
                          {t({
                            ko: "읽기 전용",
                            en: "Read-only",
                            ja: "読み取り専用",
                            zh: "Read-only",
                            de: "Nur lesen",
                          })}
                        </span>
                      )}
                    </div>
                    <p
                      className="mt-1 truncate text-xs"
                      title={provider.vaultPath}
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      {provider.vaultPath}
                    </p>
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void handleTest(provider.id)}
                      disabled={testingId === provider.id}
                      className="rounded px-2 py-1 text-xs text-blue-400 transition-colors hover:text-blue-300 disabled:opacity-50"
                    >
                      {testingId === provider.id
                        ? t({
                            ko: "테스트 중...",
                            en: "Testing...",
                            ja: "テスト中...",
                            zh: "Testing...",
                            de: "Testen...",
                          })
                        : t({ ko: "테스트", en: "Test", ja: "テスト", zh: "Test", de: "Testen" })}
                    </button>
                    <button
                      onClick={() => handleEditStart(provider)}
                      className="rounded px-2 py-1 text-xs transition-colors"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {t({ ko: "수정", en: "Edit", ja: "編集", zh: "Edit", de: "Bearbeiten" })}
                    </button>
                    <button
                      onClick={() => void handleToggle(provider)}
                      className={`rounded px-2 py-1 text-xs transition-colors ${
                        provider.enabled
                          ? "text-amber-400 hover:text-amber-300"
                          : "text-emerald-400 hover:text-emerald-300"
                      }`}
                    >
                      {provider.enabled
                        ? t({ ko: "비활성화", en: "Disable", ja: "無効化", zh: "Disable", de: "Deaktivieren" })
                        : t({ ko: "활성화", en: "Enable", ja: "有効화", zh: "Enable", de: "Aktivieren" })}
                    </button>
                    <button
                      onClick={() => void handleDelete(provider.id)}
                      className="rounded px-2 py-1 text-xs text-red-400 transition-colors hover:text-red-300"
                    >
                      {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
                    </button>
                  </div>
                </div>

                {/* Test result */}
                {testResults[provider.id] && (
                  <div
                    className={`mt-2 rounded px-3 py-1.5 text-xs ${
                      testResults[provider.id].ok ? "bg-emerald-900/30 text-emerald-400" : "bg-red-900/30 text-red-400"
                    }`}
                  >
                    {testResults[provider.id].ok ? "✓ " : "✗ "}
                    {testResults[provider.id].msg}
                  </div>
                )}

                {/* Bindings toggle */}
                <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--th-border)" }}>
                  <button
                    onClick={() => void toggleBindings(provider.id)}
                    className="text-xs transition-colors"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    {expandedBindings[provider.id] ? "▾" : "▸"}{" "}
                    {t({
                      ko: "프로젝트 바인딩",
                      en: "Project Bindings",
                      ja: "プロジェクトバインディング",
                      zh: "Project Bindings",
                      de: "Projektbindungen",
                    })}
                    {bindings[provider.id] ? ` (${bindings[provider.id].length})` : ""}
                  </button>

                  {expandedBindings[provider.id] && (
                    <div className="mt-2 space-y-2 pl-3">
                      <p className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                        {t({
                          ko: "이 Vault를 특정 프로젝트에 바인딩하면 해당 프로젝트 작업 시 자동으로 노트가 제공됩니다.",
                          en: "Bind this vault to specific projects so notes are automatically available during task execution.",
                          ja: "特定プロジェクトにバインドすると、タスク実行時にノートが自動的に提供されます。",
                          zh: "Bind this vault to specific projects so notes are automatically available during task execution.",
                          de: "Diesen Vault an bestimmte Projekte binden, damit Notizen während der Aufgabenausführung automatisch verfügbar sind.",
                        })}
                      </p>

                      {/* Existing bindings */}
                      {(bindings[provider.id] ?? []).length > 0 && (
                        <div className="space-y-1">
                          {(bindings[provider.id] ?? []).map((binding) => {
                            const proj = projects.find((p) => p.id === binding.project_id);
                            return (
                              <div
                                key={binding.id}
                                className="flex items-center justify-between rounded px-2 py-1.5"
                                style={{ background: "var(--th-card-bg)" }}
                              >
                                <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                                  {proj?.name ?? binding.project_path_prefix ?? binding.project_id ?? "Global"}
                                </span>
                                <button
                                  onClick={() => void handleDeleteBinding(provider.id, binding.id)}
                                  className="text-xs text-red-400 hover:text-red-300"
                                >
                                  {t({ ko: "제거", en: "Remove", ja: "削除", zh: "Remove", de: "Entfernen" })}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add binding */}
                      {bindingProviderId === provider.id ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={bindingProjectId}
                            onChange={(e) => setBindingProjectId(e.target.value)}
                            className="flex-1 rounded border px-2 py-1 text-xs"
                            style={{
                              background: "var(--th-input-bg)",
                              borderColor: "var(--th-input-border)",
                              color: "var(--th-text-primary)",
                            }}
                          >
                            <option value="">
                              {t({
                                ko: "프로젝트 선택...",
                                en: "Select project...",
                                ja: "プロジェクト選択...",
                                zh: "Select project...",
                                de: "Projekt auswählen...",
                              })}
                            </option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => void handleAddBinding(provider.id)}
                            disabled={!bindingProjectId}
                            className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                            style={{
                              borderColor: "var(--border-strong)",
                              background: "var(--bg-surface-hover)",
                              color: "var(--text-primary, #e4e4e7)",
                            }}
                          >
                            {t({ ko: "추가", en: "Add", ja: "추가", zh: "Add", de: "Hinzufügen" })}
                          </button>
                          <button
                            onClick={() => {
                              setBindingProviderId(null);
                              setBindingProjectId("");
                            }}
                            className="text-xs"
                            style={{ color: "var(--th-text-secondary)" }}
                          >
                            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setBindingProviderId(provider.id)}
                          className="text-xs text-blue-400 hover:text-blue-300"
                        >
                          +{" "}
                          {t({
                            ko: "프로젝트 바인딩 추가",
                            en: "Add Project Binding",
                            ja: "プロジェクトバインディング追加",
                            zh: "Add Project Binding",
                            de: "Projektbindung hinzufügen",
                          })}
                        </button>
                      )}

                      {(bindings[provider.id] ?? []).length === 0 && (
                        <p className="text-[11px] italic" style={{ color: "var(--text-muted, #71717a)" }}>
                          {t({
                            ko: "바인딩 없음 — 모든 프로젝트에서 사용 가능",
                            en: "No bindings — vault is available to all projects",
                            ja: "バインディングなし — 全プロジェクトで利用可能",
                            zh: "No bindings — vault is available to all projects",
                            de: "Keine Bindungen — Vault für alle Projekte verfügbar",
                          })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
