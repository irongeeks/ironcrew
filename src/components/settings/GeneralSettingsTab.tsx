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
        t({
          ko: "비밀번호는 4자 이상이어야 합니다.",
          en: "Password must be at least 4 characters.",
          ja: "パスワードは4文字以上でなければなりません。",
          zh: "Password must be at least 4 characters.",
          de: "Passwort muss mindestens 4 Zeichen lang sein.",
        }),
        true,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      showMessage(
        t({
          ko: "비밀번호가 일치하지 않습니다.",
          en: "Passwords do not match.",
          ja: "パスワードが一致しません。",
          zh: "Passwords do not match.",
          de: "Passwörter stimmen nicht überein.",
        }),
        true,
      );
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
      showMessage(
        t({
          ko: "비밀번호가 설정되었습니다.",
          en: "Password has been set.",
          ja: "パスワードが設定されました。",
          zh: "Password has been set.",
          de: "Passwort wurde gesetzt.",
        }),
        false,
      );
    } catch {
      showMessage(
        t({
          ko: "비밀번호 설정에 실패했습니다.",
          en: "Failed to set password.",
          ja: "パスワードの設定に失敗しました。",
          zh: "Failed to set password.",
          de: "Passwort konnte nicht gesetzt werden.",
        }),
        true,
      );
    }
  };

  const handleRemove = async () => {
    if (!currentPassword) {
      showMessage(
        t({
          ko: "현재 비밀번호를 입력하세요.",
          en: "Enter your current password.",
          ja: "現在のパスワードを入力してください。",
          zh: "Enter your current password.",
          de: "Geben Sie Ihr aktuelles Passwort ein.",
        }),
        true,
      );
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
      showMessage(
        t({
          ko: "비밀번호가 제거되었습니다.",
          en: "Password has been removed.",
          ja: "パスワードが削除されました。",
          zh: "Password has been removed.",
          de: "Passwort wurde entfernt.",
        }),
        false,
      );
    } catch {
      showMessage(
        t({
          ko: "비밀번호 제거에 실패했습니다.",
          en: "Failed to remove password.",
          ja: "パスワードの削除に失敗しました。",
          zh: "Failed to remove password.",
          de: "Passwort konnte nicht entfernt werden.",
        }),
        true,
      );
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
        {t({
          ko: "원격 접속",
          en: "Remote Access",
          ja: "リモートアクセス",
          zh: "Remote Access",
          de: "Fernzugriff",
        })}
      </h3>

      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {isPasswordSet
          ? t({
              ko: "원격 접속이 비밀번호로 보호되고 있습니다.",
              en: "Remote access is password-protected.",
              ja: "リモートアクセスはパスワードで保護されています。",
              zh: "Remote access is password-protected.",
              de: "Der Fernzugriff ist passwortgeschützt.",
            })
          : t({
              ko: "다른 기기에서 접속하려면 비밀번호를 설정하세요.",
              en: "Set a password to enable access from other devices.",
              ja: "他のデバイスからアクセスするにはパスワードを設定してください。",
              zh: "Set a password to enable access from other devices.",
              de: "Legen Sie ein Passwort fest, um den Zugriff von anderen Geräten zu ermöglichen.",
            })}
      </p>

      <div className="space-y-3">
        {isPasswordSet && (
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "현재 비밀번호",
                en: "Current Password",
                ja: "現在のパスワード",
                zh: "Current Password",
                de: "Aktuelles Passwort",
              })}
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
            {t({
              ko: "새 비밀번호",
              en: "New Password",
              ja: "新しいパスワード",
              zh: "New Password",
              de: "Neues Passwort",
            })}
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
            {t({
              ko: "비밀번호 확인",
              en: "Confirm Password",
              ja: "パスワード確認",
              zh: "Confirm Password",
              de: "Passwort bestätigen",
            })}
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
          {isPasswordSet
            ? t({ ko: "변경", en: "Change", ja: "変更", zh: "Change", de: "Ändern" })
            : t({ ko: "활성화", en: "Enable", ja: "有効化", zh: "Enable", de: "Aktivieren" })}
        </button>
        {isPasswordSet && (
          <button
            onClick={handleRemove}
            className="min-h-[44px] px-6 py-2 text-sm font-semibold rounded-lg border transition-colors"
            style={{ borderColor: "var(--th-card-border)", color: "var(--th-text-secondary)" }}
          >
            {t({ ko: "제거", en: "Remove", ja: "削除", zh: "Remove", de: "Entfernen" })}
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
    if (pack === "development")
      return t({ ko: "기본 개발", en: "Development", ja: "開発", zh: "Development", de: "Entwicklung" });
    if (pack === "design_studio")
      return t({
        ko: "디자인 스튜디오",
        en: "Design Studio",
        ja: "デザインスタジオ",
        zh: "Design Studio",
        de: "Design Studio",
      });
    if (pack === "video_preprod")
      return t({
        ko: "영상 프리프로덕션",
        en: "Video Pre-Prod",
        ja: "動画プリプロ",
        zh: "Video Pre-Prod",
        de: "Video-Vorproduktion",
      });
    if (pack === "web_research_report")
      return t({
        ko: "웹 리서치 리포트",
        en: "Web Research",
        ja: "Webリサーチ",
        zh: "Web Research",
        de: "Web-Recherche",
      });
    return t({ ko: "롤플레이", en: "Roleplay", ja: "ロールプレイ", zh: "Roleplay", de: "Roleplay" });
  };

  return (
    <>
      <section
        className="rounded-xl p-5 sm:p-6 space-y-5"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({ ko: "회사 정보", en: "Company", ja: "会社情報", zh: "Company", de: "Unternehmen" })}
        </h3>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "회사명", en: "Company Name", ja: "会社名", zh: "Company Name", de: "Unternehmensname" })}
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
            {t({ ko: "CEO 이름", en: "CEO Name", ja: "CEO 名", zh: "CEO Name", de: "CEO-Name" })}
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
            label={t({
              ko: "자동 배정",
              en: "Auto Assign",
              ja: "自動割り当て",
              zh: "Auto Assign",
              de: "Automatische Zuweisung",
            })}
            checked={form.autoAssign}
            onToggle={() => setForm({ ...form, autoAssign: !form.autoAssign })}
          />

          <ToggleSettingCard
            label={t({ ko: "YOLO 모드", en: "YOLO Mode", ja: "YOLO モード", zh: "YOLO Mode", de: "YOLO-Modus" })}
            checked={form.yoloMode === true}
            onToggle={() => setForm({ ...form, yoloMode: !(form.yoloMode === true) })}
            title={t({
              ko: "켜면 기획팀장이 의사결정 단계를 자동으로 분석하고 다음 단계를 진행합니다.",
              en: "When enabled, the planning lead auto-analyzes decision steps and proceeds automatically.",
              ja: "有効にすると、企画リードが意思決定段階を自動分析して次段階へ進めます。",
              zh: "When enabled, the planning lead auto-analyzes decision steps and proceeds automatically.",
              de: "Wenn aktiviert, analysiert die Planungsleitung Entscheidungsschritte automatisch und fährt selbstständig fort.",
            })}
          />

          <ToggleSettingCard
            label={t({
              ko: "OAuth 자동 스왑",
              en: "OAuth Auto Swap",
              ja: "OAuth 自動スワップ",
              zh: "OAuth Auto Swap",
              de: "OAuth Auto-Wechsel",
            })}
            checked={form.oauthAutoSwap !== false}
            onToggle={() => setForm({ ...form, oauthAutoSwap: !(form.oauthAutoSwap !== false) })}
            title={t({
              ko: "실패/한도 시 다음 OAuth 계정으로 자동 전환",
              en: "Auto-switch to next OAuth account on failures/limits",
              ja: "失敗/上限時に次の OAuth アカウントへ自動切替",
              zh: "Auto-switch to next OAuth account on failures/limits",
              de: "Bei Fehlern oder Limits automatisch zum nächsten OAuth-Konto wechseln",
            })}
          />
        </div>

        {/* ── Autonomous Mode ─────────────────────────────────── */}
        <h3 className="text-sm font-semibold uppercase tracking-wider mt-6" style={{ color: "var(--th-text-primary)" }}>
          {t({
            ko: "자율 모드",
            en: "Autonomous Mode",
            ja: "自律モード",
            zh: "Autonomous Mode",
            de: "Autonomer Modus",
          })}
        </h3>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ToggleSettingCard
            label={t({
              ko: "자율 스케줄러",
              en: "Autonomous Scheduler",
              ja: "自律スケジューラ",
              zh: "Autonomous Scheduler",
              de: "Autonomer Scheduler",
            })}
            checked={form.autonomousMode === true}
            onToggle={() => setForm({ ...form, autonomousMode: !(form.autonomousMode === true) })}
            title={t({
              ko: "대기 중인 태스크를 유휴 에이전트에 자동 배정 및 실행합니다.",
              en: "Auto-assign and execute waiting tasks with idle agents.",
              ja: "待機タスクをアイドルエージェントに自動割り当て・実行します。",
              zh: "Auto-assign and execute waiting tasks with idle agents.",
              de: "Wartende Aufgaben automatisch inaktiven Agenten zuweisen und ausführen.",
            })}
          />

          <ToggleSettingCard
            label={t({
              ko: "CEO 오케스트레이터",
              en: "CEO Orchestrator",
              ja: "CEO オーケストレータ",
              zh: "CEO Orchestrator",
              de: "CEO-Orchestrator",
            })}
            checked={form.ceoOrchestratorEnabled === true}
            onToggle={() => setForm({ ...form, ceoOrchestratorEnabled: !(form.ceoOrchestratorEnabled === true) })}
            title={t({
              ko: "CEO가 LLM으로 인박스를 분석하고 자동으로 태스크를 생성/라우팅합니다.",
              en: "CEO uses LLM to analyze inbox and auto-create/route tasks.",
              ja: "CEOがLLMでインボックスを分析し、タスクを自動作成・ルーティングします。",
              zh: "CEO uses LLM to analyze inbox and auto-create/route tasks.",
              de: "Der CEO nutzt ein LLM zur Posteingangsanalyse und erstellt/leitet Aufgaben automatisch.",
            })}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "최대 동시 에이전트",
                en: "Max Concurrent Agents",
                ja: "最大同時エージェント",
                zh: "Max Concurrent Agents",
                de: "Maximale gleichzeitige Agenten",
              })}
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
              {t({
                ko: "CEO 틱 간격 (초)",
                en: "CEO Tick Interval (sec)",
                ja: "CEO ティック間隔 (秒)",
                zh: "CEO Tick Interval (sec)",
                de: "CEO-Takt-Intervall (Sek.)",
              })}
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
            {t({
              ko: "기본 CLI 프로바이더",
              en: "Default CLI Provider",
              ja: "デフォルト CLI プロバイダ",
              zh: "Default CLI Provider",
              de: "Standard-CLI-Anbieter",
            })}
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
            {t({
              ko: "기본 워크플로우 팩",
              en: "Default Workflow Pack",
              ja: "デフォルトワークフローパック",
              zh: "Default Workflow Pack",
              de: "Standard-Workflow-Pack",
            })}
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
            {t({ ko: "언어", en: "Language", ja: "言語", zh: "Language", de: "Sprache" })}
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
            <option value="ko">
              {t({ ko: "한국어", en: "Korean", ja: "韓国語", zh: "Korean", de: "Koreanisch" })}
            </option>
            <option value="en">{t({ ko: "영어", en: "English", ja: "英語", zh: "English", de: "Englisch" })}</option>
            <option value="ja">
              {t({ ko: "일본어", en: "Japanese", ja: "日本語", zh: "Japanese", de: "Japanisch" })}
            </option>
            <option value="zh">
              {t({ ko: "중국어", en: "Chinese", ja: "中国語", zh: "Chinese", de: "Chinesisch" })}
            </option>
            <option value="de">{t({ ko: "독일어", en: "German", ja: "ドイツ語", zh: "German", de: "Deutsch" })}</option>
          </select>
        </div>

        <div className="space-y-2 rounded-lg border p-3 sm:p-4" style={{ borderColor: "var(--th-card-border)" }}>
          <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
            {t({
              ko: "알림 수신 채널",
              en: "Notification Channels",
              ja: "通知チャネル",
              zh: "Notification Channels",
              de: "Benachrichtigungskanäle",
            })}
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
              {t({
                ko: "기본 프로젝트 경로",
                en: "Default Project Path",
                ja: "デフォルトプロジェクトパス",
                zh: "Default Project Path",
                de: "Standard-Projektpfad",
              })}
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
              {t({ ko: "테마", en: "Theme", ja: "テーマ", zh: "Theme", de: "Design" })}
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
              <option value="dark">{t({ ko: "다크", en: "Dark", ja: "ダーク", zh: "Dark", de: "Dunkel" })}</option>
              <option value="light">{t({ ko: "라이트", en: "Light", ja: "ライト", zh: "Light", de: "Hell" })}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "API 요청 타임아웃 (ms)",
                en: "API Request Timeout (ms)",
                ja: "APIリクエストタイムアウト (ms)",
                zh: "API Request Timeout (ms)",
                de: "API-Anfrage-Timeout (ms)",
              })}
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
              {t({
                ko: "작업 실행 최대 시간 (ms)",
                en: "Task Execution Timeout (ms)",
                ja: "タスク実行タイムアウト (ms)",
                zh: "Task Execution Timeout (ms)",
                de: "Aufgaben-Ausführungs-Timeout (ms)",
              })}
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
          <span className="text-green-400 text-sm self-center">
            ✅ {t({ ko: "저장 완료", en: "Saved", ja: "保存完了", zh: "Saved", de: "Gespeichert" })}
          </span>
        )}
        <button
          onClick={onSave}
          className="min-h-[44px] w-full px-8 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-all hover:shadow-blue-500/30 sm:w-auto"
        >
          {t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
        </button>
      </div>

      <ReleaseUpdateSection />
      <RemoteAccessSection t={t} />
    </>
  );
}
