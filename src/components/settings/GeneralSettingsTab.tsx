import { useState, useEffect, useMemo } from "react";
import { ReleaseUpdateSection } from "./ReleaseUpdateSection";
import type { CliProvider, MessengerChannelType, PackRegistryEntry, WorkflowPackKey } from "../../types";
import { WORKFLOW_PACK_KEYS } from "../../types";
import { fetchPackRegistry } from "../../api/workflow-packs";
import { put, request } from "../../api/core";
import type { LocalSettings, SetLocalSettings, TFunction } from "./types";

interface GeneralSettingsTabProps {
  t: TFunction;
  form: LocalSettings;
  setForm: SetLocalSettings;
  saved: boolean;
  onSave: () => void;
}

interface ToggleSettingCardProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  title?: string;
}

function ToggleSettingCard({ label, checked, onToggle, title }: ToggleSettingCardProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
    >
      <label className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
        {label}
      </label>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-7 w-12 rounded-full transition-colors ${checked ? "bg-blue-500" : ""}`}
        style={checked ? undefined : { background: "var(--th-bg-surface-hover)" }}
        title={title}
      >
        <div
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function RemoteAccessSection({ t }: { t: TFunction }) {
  const [isPasswordSet, setIsPasswordSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    request<{ passwordConfigured: boolean }>("/api/auth/status")
      .then((res) => setIsPasswordSet(res.passwordConfigured))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const clearFields = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const showMessage = (text: string, error: boolean) => {
    setMessage({ text, error });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleSet = async () => {
    if (newPassword.length < 4) {
      showMessage(
        t({ en: "Password must be at least 4 characters.", de: "Passwort muss mindestens 4 Zeichen lang sein." }),
        true,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      showMessage(t({ en: "Passwords do not match.", de: "Passwörter stimmen nicht überein." }), true);
      return;
    }
    try {
      if (isPasswordSet) {
        await put("/api/auth/password", { current_password: currentPassword, new_password: newPassword });
      } else {
        await put("/api/auth/password", { password: newPassword });
      }
      setIsPasswordSet(true);
      clearFields();
      showMessage(t({ en: "Password has been set.", de: "Passwort wurde gesetzt." }), false);
    } catch {
      showMessage(t({ en: "Failed to set password.", de: "Passwort konnte nicht gesetzt werden." }), true);
    }
  };

  const handleRemove = async () => {
    if (!currentPassword) {
      showMessage(t({ en: "Enter your current password.", de: "Geben Sie Ihr aktuelles Passwort ein." }), true);
      return;
    }
    try {
      await request("/api/auth/password", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword }),
      });
      setIsPasswordSet(false);
      clearFields();
      showMessage(t({ en: "Password has been removed.", de: "Passwort wurde entfernt." }), false);
    } catch {
      showMessage(t({ en: "Failed to remove password.", de: "Passwort konnte nicht entfernt werden." }), true);
    }
  };

  if (loading) return null;

  const inputStyle = {
    background: "var(--th-input-bg)",
    borderColor: "var(--th-input-border)",
    color: "var(--th-text-primary)",
  };

  return (
    <section
      className="rounded-xl p-5 sm:p-6 space-y-5"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
        {t({ en: "Remote Access", de: "Fernzugriff" })}
      </h3>

      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {isPasswordSet
          ? t({ en: "Remote access is password-protected.", de: "Der Fernzugriff ist passwortgeschützt." })
          : t({
              en: "Set a password to enable access from other devices.",
              de: "Legen Sie ein Passwort fest, um den Zugriff von anderen Geräten zu ermöglichen.",
            })}
      </p>

      <div className="space-y-3">
        {isPasswordSet && (
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Current Password", de: "Aktuelles Passwort" })}
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={inputStyle}
            />
          </div>
        )}

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "New Password", de: "Neues Passwort" })}
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={inputStyle}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Confirm Password", de: "Passwort bestätigen" })}
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={inputStyle}
          />
        </div>
      </div>

      {message && (
        <p className="text-xs" style={{ color: message.error ? "#ef4444" : "#22c55e" }}>
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleSet}
          className="min-h-[44px] px-6 py-2 text-white text-sm font-semibold rounded-lg transition-colors"
          style={{ background: "var(--th-accent)" }}
        >
          {isPasswordSet ? t({ en: "Change", de: "Ändern" }) : t({ en: "Enable", de: "Aktivieren" })}
        </button>
        {isPasswordSet && (
          <button
            onClick={handleRemove}
            className="min-h-[44px] px-6 py-2 text-sm font-semibold rounded-lg border transition-colors"
            style={{ borderColor: "var(--th-card-border)", color: "var(--th-text-secondary)" }}
          >
            {t({ en: "Remove", de: "Entfernen" })}
          </button>
        )}
      </div>
    </section>
  );
}

export default function GeneralSettingsTab({ t, form, setForm, saved, onSave }: GeneralSettingsTabProps) {
  const [registryPacks, setRegistryPacks] = useState<PackRegistryEntry[]>([]);
  useEffect(() => {
    fetchPackRegistry()
      .then(setRegistryPacks)
      .catch(() => {});
  }, []);

  const packKeys = registryPacks.length > 0 ? registryPacks.map((p) => p.key) : [...WORKFLOW_PACK_KEYS];

  const registryLabelMap = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    for (const p of registryPacks) map.set(p.key, p.ui.label);
    return map;
  }, [registryPacks]);

  const locale = form.language ?? "en";

  const updateMessengerReceiveEnabled = (channel: MessengerChannelType, enabled: boolean) => {
    const nextChannels = { ...(form.messengerChannels ?? {}) } as NonNullable<LocalSettings["messengerChannels"]>;
    const current = nextChannels[channel] ?? { token: "", sessions: [], receiveEnabled: false };
    nextChannels[channel] = { ...current, receiveEnabled: enabled };
    setForm({
      ...form,
      messengerChannels: nextChannels,
    });
  };

  const workflowPackLabel = (pack: WorkflowPackKey): string => {
    if (pack === "development") return t({ en: "Development", de: "Entwicklung" });
    if (pack === "design_studio") return t({ en: "Design Studio", de: "Design Studio" });
    if (pack === "video_preprod") return t({ en: "Video Pre-Prod", de: "Video-Vorproduktion" });
    if (pack === "web_research_report") return t({ en: "Web Research", de: "Web-Recherche" });
    return t({ en: "Roleplay", de: "Roleplay" });
  };

  return (
    <>
      <section
        className="rounded-xl p-5 sm:p-6 space-y-5"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "Company", de: "Unternehmen" })}
        </h3>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Company Name", de: "Unternehmensname" })}
          </label>
          <input
            type="text"
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "CEO Name", de: "CEO-Name" })}
          </label>
          <input
            type="text"
            value={form.ceoName}
            onChange={(e) => setForm({ ...form, ceoName: e.target.value })}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ToggleSettingCard
            label={t({ en: "Auto Assign", de: "Automatische Zuweisung" })}
            checked={form.autoAssign}
            onToggle={() => setForm({ ...form, autoAssign: !form.autoAssign })}
          />

          <ToggleSettingCard
            label={t({ en: "YOLO Mode", de: "YOLO-Modus" })}
            checked={form.yoloMode === true}
            onToggle={() => setForm({ ...form, yoloMode: !(form.yoloMode === true) })}
            title={t({
              en: "When enabled, the planning lead auto-analyzes decision steps and proceeds automatically.",
              de: "Wenn aktiviert, analysiert die Planungsleitung Entscheidungsschritte automatisch und fährt selbstständig fort.",
            })}
          />

          <ToggleSettingCard
            label={t({ en: "OAuth Auto Swap", de: "OAuth Auto-Wechsel" })}
            checked={form.oauthAutoSwap !== false}
            onToggle={() => setForm({ ...form, oauthAutoSwap: !(form.oauthAutoSwap !== false) })}
            title={t({
              en: "Auto-switch to next OAuth account on failures/limits",
              de: "Bei Fehlern oder Limits automatisch zum nächsten OAuth-Konto wechseln",
            })}
          />
        </div>

        {/* ── Autonomous Mode ─────────────────────────────────── */}
        <h3 className="text-sm font-semibold uppercase tracking-wider mt-6" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "Autonomous Mode", de: "Autonomer Modus" })}
        </h3>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ToggleSettingCard
            label={t({ en: "Autonomous Scheduler", de: "Autonomer Scheduler" })}
            checked={form.autonomousMode === true}
            onToggle={() => setForm({ ...form, autonomousMode: !(form.autonomousMode === true) })}
            title={t({
              en: "Auto-assign and execute waiting tasks with idle agents.",
              de: "Wartende Aufgaben automatisch inaktiven Agenten zuweisen und ausführen.",
            })}
          />

          <ToggleSettingCard
            label={t({ en: "CEO Orchestrator", de: "CEO-Orchestrator" })}
            checked={form.ceoOrchestratorEnabled === true}
            onToggle={() => setForm({ ...form, ceoOrchestratorEnabled: !(form.ceoOrchestratorEnabled === true) })}
            title={t({
              en: "CEO uses LLM to analyze inbox and auto-create/route tasks.",
              de: "Der CEO nutzt ein LLM zur Posteingangsanalyse und erstellt/leitet Aufgaben automatisch.",
            })}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Max Concurrent Agents", de: "Maximale gleichzeitige Agenten" })}
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={form.autonomousMaxConcurrent ?? 2}
              onChange={(e) => setForm({ ...form, autonomousMaxConcurrent: Math.max(1, Number(e.target.value) || 2) })}
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "CEO Tick Interval (sec)", de: "CEO-Takt-Intervall (Sek.)" })}
            </label>
            <input
              type="number"
              min={30}
              max={600}
              value={Math.round((form.ceoOrchestratorIntervalMs ?? 120000) / 1000)}
              onChange={(e) =>
                setForm({ ...form, ceoOrchestratorIntervalMs: Math.max(30, Number(e.target.value) || 120) * 1000 })
              }
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Default CLI Provider", de: "Standard-CLI-Anbieter" })}
          </label>
          <select
            value={form.defaultProvider}
            onChange={(e) => setForm({ ...form, defaultProvider: e.target.value as CliProvider })}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="gemini">Gemini CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Default Workflow Pack", de: "Standard-Workflow-Pack" })}
          </label>
          <select
            value={form.officeWorkflowPack ?? "development"}
            onChange={(e) => setForm({ ...form, officeWorkflowPack: e.target.value as WorkflowPackKey })}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            {packKeys.map((pack) => (
              <option key={pack} value={pack}>
                {registryLabelMap.get(pack)?.[locale] ?? workflowPackLabel(pack)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Language", de: "Sprache" })}
          </label>
          <select
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value as LocalSettings["language"] })}
            className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </div>

        <div className="space-y-2 rounded-lg border p-3 sm:p-4" style={{ borderColor: "var(--th-card-border)" }}>
          <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
            {t({ en: "Notification Channels", de: "Benachrichtigungskanäle" })}
          </h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ["telegram", "Telegram"],
                ["discord", "Discord"],
                ["slack", "Slack"],
                ["whatsapp", "WhatsApp"],
              ] as Array<[MessengerChannelType, string]>
            ).map(([channel, label]) => (
              <ToggleSettingCard
                key={channel}
                label={label}
                checked={Boolean(form.messengerChannels?.[channel]?.receiveEnabled)}
                onToggle={() =>
                  updateMessengerReceiveEnabled(channel, !form.messengerChannels?.[channel]?.receiveEnabled)
                }
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Default Project Path", de: "Standard-Projektpfad" })}
            </label>
            <input
              type="text"
              value={form.defaultProjectPath ?? ""}
              onChange={(e) => setForm({ ...form, defaultProjectPath: e.target.value })}
              placeholder="/home/user/projects/my-workspace"
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Theme", de: "Design" })}
            </label>
            <select
              value={form.theme}
              onChange={(e) => setForm({ ...form, theme: e.target.value as LocalSettings["theme"] })}
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            >
              <option value="dark">{t({ en: "Dark", de: "Dunkel" })}</option>
              <option value="light">{t({ en: "Light", de: "Hell" })}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "API Request Timeout (ms)", de: "API-Anfrage-Timeout (ms)" })}
            </label>
            <input
              type="number"
              min={1000}
              step={1000}
              value={form.apiRequestTimeoutMs ?? 30000}
              onChange={(e) =>
                setForm({
                  ...form,
                  apiRequestTimeoutMs: Math.max(1000, Number(e.target.value || 1000)),
                })
              }
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Task Execution Timeout (ms)", de: "Aufgaben-Ausführungs-Timeout (ms)" })}
            </label>
            <input
              type="number"
              min={60000}
              step={60000}
              value={form.taskExecutionTimeoutMs ?? 3600000}
              onChange={(e) =>
                setForm({
                  ...form,
                  taskExecutionTimeoutMs: Math.max(60000, Number(e.target.value || 60000)),
                })
              }
              className="min-h-[44px] w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap justify-end gap-3">
        {saved && (
          <span className="text-green-400 text-sm self-center">✅ {t({ en: "Saved", de: "Gespeichert" })}</span>
        )}
        <button
          onClick={onSave}
          className="min-h-[44px] w-full px-8 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-all hover:shadow-blue-500/30 sm:w-auto"
        >
          {t({ en: "Save", de: "Speichern" })}
        </button>
      </div>

      <ReleaseUpdateSection />
      <RemoteAccessSection t={t} />
    </>
  );
}
