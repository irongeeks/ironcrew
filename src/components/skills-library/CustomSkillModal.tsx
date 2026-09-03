import { createPortal } from "react-dom";
import type { RefObject } from "react";
import type { SkillLearnProvider } from "../../api";
import type { Agent } from "../../types";
import AgentAvatar from "../AgentAvatar";
import { providerLabel, type TFunction } from "./model";

interface CustomSkillModalProps {
  t: TFunction;
  show: boolean;
  agents: Agent[];
  representatives: Array<{ provider: SkillLearnProvider; agent: Agent | null }>;
  preferKoreanName: boolean;
  customSkillName: string;
  setCustomSkillName: (value: string) => void;
  customSkillContent: string;
  customSkillFileName: string;
  customSkillProviders: SkillLearnProvider[];
  customSkillSubmitting: boolean;
  customSkillError: string | null;
  customFileInputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleProvider: (provider: SkillLearnProvider) => void;
  onSubmit: () => void;
}

export default function CustomSkillModal({
  t,
  show,
  agents,
  representatives,
  preferKoreanName,
  customSkillName,
  setCustomSkillName,
  customSkillContent,
  customSkillFileName,
  customSkillProviders,
  customSkillSubmitting,
  customSkillError,
  customFileInputRef,
  onClose,
  onFileSelect,
  onToggleProvider,
  onSubmit,
}: CustomSkillModalProps) {
  if (!show) return null;

  return createPortal(
    <div
      className="custom-skill-modal fixed inset-0 z-[80] flex items-center justify-center backdrop-blur-sm p-4"
      style={{ background: "rgba(var(--th-backdrop-rgb, 2 6 23) / 0.75)" }}
    >
      <div
        className="custom-skill-modal-card w-full max-w-lg max-h-[90vh] overflow-hidden rounded-2xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        <div
          className="flex items-start justify-between gap-4 border-b px-5 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div>
            <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: "var(--th-text-heading)" }}>
              <span>✏️</span>
              {t({
                ko: "커스텀 스킬 추가",
                en: "Add Custom Skill",
                ja: "カスタムスキル追加",
                zh: "Add Custom Skill",
                de: "Benutzerdefinierter Skill hinzufügen",
              })}
            </h3>
            <div className="mt-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "skills.md 파일을 첨부하고 CLI 대표자를 선택하세요",
                en: "Attach a skills.md file and select CLI representatives",
                ja: "skills.md ファイルを添付し、CLI代表を選択してください",
                zh: "Attach a skills.md file and select CLI representatives",
                de: "skills.md-Datei anhängen und CLI-Vertreter auswählen",
              })}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={customSkillSubmitting}
            className="rounded-lg border px-2.5 py-1 text-xs transition-all"
            style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
          >
            {t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 max-h-[calc(90vh-72px)]">
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--th-text-secondary)" }}>
              {t({ ko: "스킬명", en: "Skill Name", ja: "スキル名", zh: "Skill Name", de: "Skill-Name" })}
            </label>
            <input
              type="text"
              value={customSkillName}
              onChange={(e) => setCustomSkillName(e.target.value)}
              placeholder={t({
                ko: "예: my-custom-skill",
                en: "e.g. my-custom-skill",
                ja: "例: my-custom-skill",
                zh: "e.g. my-custom-skill",
                de: "z. B. my-custom-skill",
              })}
              className="w-full border rounded-lg px-3 py-2 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/25"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
            <div className="text-[10px] mt-1" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "영문, 숫자, 하이픈(-), 언더스코어(_)만 사용 가능",
                en: "Only alphanumeric, dash (-), underscore (_) allowed",
                ja: "英数字、ハイフン(-)、アンダースコア(_)のみ使用可能",
                zh: "Only alphanumeric, dash (-), underscore (_) allowed",
                de: "Nur Buchstaben, Zahlen, Bindestrich (-) und Unterstrich (_) erlaubt",
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "skills.md 파일",
                en: "skills.md File",
                ja: "skills.md ファイル",
                zh: "skills.md File",
                de: "skills.md-Datei",
              })}
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => customFileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 text-xs border rounded-lg transition-all"
                style={{
                  background: "var(--th-card-bg)",
                  borderColor: "var(--th-border-strong)",
                  color: "var(--th-text-secondary)",
                }}
              >
                <span>📎</span>
                {t({
                  ko: "파일 선택",
                  en: "Choose File",
                  ja: "ファイル選択",
                  zh: "Choose File",
                  de: "Datei auswählen",
                })}
              </button>
              <input
                ref={customFileInputRef}
                type="file"
                accept=".md,.txt,.markdown"
                onChange={onFileSelect}
                className="hidden"
              />
              {customSkillFileName && (
                <span className="text-xs text-emerald-300 truncate max-w-[200px]">📄 {customSkillFileName}</span>
              )}
            </div>
            {customSkillContent && (
              <div
                className="mt-2 rounded-lg border p-2 max-h-32 overflow-y-auto"
                style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
              >
                <pre
                  className="text-[10px] whitespace-pre-wrap break-all"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  {customSkillContent.slice(0, 500)}
                  {customSkillContent.length > 500 && "..."}
                </pre>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "학습시킬 CLI 대표자",
                en: "CLI Representatives to Train",
                ja: "学習させるCLI代表",
                zh: "CLI Representatives to Train",
                de: "CLI-Vertreter für das Training",
              })}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {representatives.map((row) => {
                const isSelected = customSkillProviders.includes(row.provider);
                const hasAgent = !!row.agent;
                const displayName = row.agent
                  ? preferKoreanName
                    ? row.agent.name_ko || row.agent.name
                    : row.agent.name || row.agent.name_ko
                  : t({ ko: "없음", en: "None", ja: "なし", zh: "None", de: "Keiner" });
                return (
                  <button
                    key={`custom-${row.provider}`}
                    onClick={() => hasAgent && onToggleProvider(row.provider)}
                    disabled={!hasAgent}
                    className={`flex items-center gap-2 p-2 rounded-lg border text-left transition-all ${
                      !hasAgent
                        ? "cursor-not-allowed opacity-50"
                        : isSelected
                          ? "border-violet-500/50 bg-violet-500/10"
                          : "hover:border-slate-500/70"
                    }`}
                    style={
                      !hasAgent
                        ? { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                        : isSelected
                          ? undefined
                          : { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                    }
                  >
                    <AgentAvatar agent={row.agent ?? undefined} agents={agents} size={32} rounded="xl" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                        {providerLabel(row.provider)}
                      </div>
                      <div className="text-xs truncate" style={{ color: "var(--th-text-heading)" }}>
                        {displayName}
                      </div>
                    </div>
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                        isSelected ? "border-violet-400 bg-violet-500/30 text-violet-200" : ""
                      }`}
                      style={
                        isSelected
                          ? undefined
                          : { borderColor: "var(--th-border-strong)", background: "var(--th-card-bg)" }
                      }
                    >
                      {isSelected && "✓"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {customSkillError && (
            <div className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
              {customSkillError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              disabled={customSkillSubmitting}
              className="px-3 py-1.5 rounded-lg text-xs border transition-all"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
            >
              {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
            </button>
            <button
              onClick={onSubmit}
              disabled={
                !customSkillName.trim() ||
                !customSkillContent.trim() ||
                customSkillProviders.length === 0 ||
                customSkillSubmitting
              }
              className={`custom-skill-submit-btn px-4 py-1.5 rounded-lg text-xs border transition-all flex items-center gap-1.5 ${
                !customSkillName.trim() || !customSkillContent.trim() || customSkillProviders.length === 0
                  ? "cursor-not-allowed text-slate-600"
                  : "border-violet-500/50 bg-violet-500/20 text-violet-200 hover:bg-violet-500/30"
              }`}
            >
              {customSkillSubmitting ? (
                <>
                  <span className="animate-spin w-3 h-3 border border-violet-400 border-t-transparent rounded-full" />
                  {t({
                    ko: "등록중...",
                    en: "Submitting...",
                    ja: "登録中...",
                    zh: "Submitting...",
                    de: "Wird eingereicht...",
                  })}
                </>
              ) : (
                <>
                  <span>🎓</span>
                  {t({
                    ko: "학습 시작",
                    en: "Start Training",
                    ja: "学習開始",
                    zh: "Start Training",
                    de: "Training starten",
                  })}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
