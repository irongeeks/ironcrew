import type { SkillHistoryProvider, SkillLearnProvider } from "../../api";
import type { Agent } from "../../types";
import AgentAvatar from "../AgentAvatar";
import {
  learningStatusLabel,
  providerLabel,
  roleLabel,
  type CategorizedSkill,
  type TFunction,
  type UnlearnEffect,
} from "./model";

interface LearningModalProps {
  t: TFunction;
  localeTag: string;
  agents: Agent[];
  learningSkill: CategorizedSkill | null;
  learnInProgress: boolean;
  selectedProviders: SkillLearnProvider[];
  representatives: Array<{ provider: SkillLearnProvider; agent: Agent | null }>;
  preferKoreanName: boolean;
  modalLearnedProviders: Set<SkillHistoryProvider>;
  unlearningProviders: SkillLearnProvider[];
  unlearnEffects: Partial<Record<SkillLearnProvider, UnlearnEffect>>;
  learnJob: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    command: string;
    logTail: string[];
    completedAt: number | null;
    error?: string | null;
  } | null;
  learnError: string | null;
  unlearnError: string | null;
  learnSubmitting: boolean;
  defaultSelectedProviders: SkillLearnProvider[];
  onClose: () => void;
  onToggleProvider: (provider: SkillLearnProvider) => void;
  onUnlearnProvider: (provider: SkillLearnProvider) => void;
  onStartLearning: () => void;
}

export default function LearningModal({
  t,
  localeTag,
  agents,
  learningSkill,
  learnInProgress,
  selectedProviders,
  representatives,
  preferKoreanName,
  modalLearnedProviders,
  unlearningProviders,
  unlearnEffects,
  learnJob,
  learnError,
  unlearnError,
  learnSubmitting,
  defaultSelectedProviders,
  onClose,
  onToggleProvider,
  onUnlearnProvider,
  onStartLearning,
}: LearningModalProps) {
  if (!learningSkill) return null;

  return (
    <div
      className="skills-learn-modal fixed inset-0 z-[80] flex items-center justify-center backdrop-blur-sm p-4"
      style={{ background: "rgba(var(--th-backdrop-rgb, 2 6 23) / 0.75)" }}
    >
      <div
        className="skills-learn-modal-card w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        <div
          className="flex items-start justify-between gap-4 border-b px-5 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div>
            <h3 className="text-base font-semibold" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "스킬 학습 스쿼드",
                en: "Skill Learning Squad",
                ja: "スキル学習スクワッド",
                zh: "Skill Learning Squad",
                de: "Skill-Lernteam",
              })}
            </h3>
            <div className="mt-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {learningSkill.name} · {learningSkill.repo}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={learnInProgress}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-all ${
              learnInProgress ? "cursor-not-allowed text-slate-600" : ""
            }`}
            style={
              learnInProgress
                ? { borderColor: "var(--th-border)" }
                : { borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }
            }
          >
            {learnInProgress
              ? t({ ko: "학습중", en: "Running", ja: "実行中", zh: "Running", de: "Läuft" })
              : t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 max-h-[calc(90vh-72px)]">
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2">
            <div className="text-[11px] text-emerald-200">
              {t({
                ko: "실행 명령",
                en: "Install command",
                ja: "実行コマンド",
                zh: "Install command",
                de: "Installationsbefehl",
              })}
            </div>
            <div className="mt-1 text-[11px] font-mono text-emerald-300 break-all">
              npx skills add {learningSkill.repo}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "CLI 대표자를 선택하세요 (복수 선택 가능)",
                en: "Select CLI representatives (multi-select)",
                ja: "CLI代表を選択してください（複数選択可）",
                zh: "Select CLI representatives (multi-select)",
                de: "CLI-Vertreter auswählen (Mehrfachauswahl)",
              })}
            </div>
            <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              {selectedProviders.length}
              {t({ ko: "명 선택됨", en: " selected", ja: "名を選択", zh: " selected", de: " ausgewählt" })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {representatives.map((row) => {
              const isSelected = selectedProviders.includes(row.provider);
              const hasAgent = !!row.agent;
              const isAnimating = learnInProgress && isSelected && hasAgent;
              const isAlreadyLearned = modalLearnedProviders.has(row.provider);
              const isUnlearning = unlearningProviders.includes(row.provider);
              const unlearnEffect = unlearnEffects[row.provider];
              const isHitAnimating = !!unlearnEffect;
              const displayName = row.agent
                ? preferKoreanName
                  ? row.agent.name_ko || row.agent.name
                  : row.agent.name || row.agent.name_ko
                : t({
                    ko: "배치된 인원 없음",
                    en: "No assigned member",
                    ja: "担当メンバーなし",
                    zh: "No assigned member",
                    de: "Kein zugewiesenes Mitglied",
                  });

              return (
                <div
                  key={row.provider}
                  role={hasAgent ? "button" : undefined}
                  tabIndex={hasAgent ? 0 : -1}
                  onClick={() => {
                    if (!hasAgent || learnInProgress) return;
                    onToggleProvider(row.provider);
                  }}
                  onKeyDown={(event) => {
                    if (!hasAgent || learnInProgress) return;
                    const target = event.target as HTMLElement | null;
                    if (target?.closest("button")) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggleProvider(row.provider);
                    }
                  }}
                  aria-disabled={!hasAgent || learnInProgress}
                  className={`relative overflow-hidden rounded-xl border p-3 text-left transition-all ${
                    !hasAgent
                      ? "cursor-not-allowed opacity-60"
                      : isSelected
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "hover:border-slate-500/80"
                  }`}
                  style={
                    !hasAgent
                      ? { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                      : isSelected
                        ? undefined
                        : { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                  }
                >
                  {isAnimating && (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                      {Array.from({ length: 6 }).map((_, idx) => (
                        <span
                          key={`${row.provider}-book-${idx}`}
                          className="learn-book-drop"
                          style={{ left: `${8 + idx * 15}%`, animationDelay: `${idx * 0.15}s` }}
                        >
                          {idx % 2 === 0 ? "📘" : "📙"}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="relative z-10 flex items-center gap-3">
                    <div
                      className={`relative ${isAnimating ? "learn-avatar-reading" : ""} ${isHitAnimating ? "unlearn-avatar-hit" : ""}`}
                    >
                      <AgentAvatar agent={row.agent ?? undefined} agents={agents} size={50} rounded="xl" />
                      {isAnimating && <span className="learn-reading-book">📖</span>}
                      {unlearnEffect === "pot" && <span className="unlearn-pot-drop">🪴</span>}
                      {unlearnEffect === "hammer" && <span className="unlearn-hammer-swing">🔨</span>}
                      {isHitAnimating && (
                        <span className="unlearn-hit-text">
                          {t({ ko: "깡~", en: "Bonk!", ja: "ゴン!", zh: "Bonk!", de: "Bam!" })}
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                        {providerLabel(row.provider)}
                      </div>
                      <div className="text-sm font-medium truncate" style={{ color: "var(--th-text-heading)" }}>
                        {displayName}
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                        {row.agent
                          ? roleLabel(row.agent.role, t)
                          : t({
                              ko: "사용 불가",
                              en: "Unavailable",
                              ja: "利用不可",
                              zh: "Unavailable",
                              de: "Nicht verfügbar",
                            })}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <div
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          isAlreadyLearned
                            ? "border-emerald-400/50 text-emerald-300 bg-emerald-500/15"
                            : isSelected
                              ? "border-blue-400/50 text-blue-300 bg-blue-500/15"
                              : ""
                        }`}
                        style={
                          !isAlreadyLearned && !isSelected
                            ? {
                                borderColor: "var(--th-border-strong)",
                                color: "var(--th-text-secondary)",
                                background: "var(--th-bg-surface-hover)",
                              }
                            : undefined
                        }
                      >
                        {isAlreadyLearned
                          ? t({ ko: "학습됨", en: "Learned", ja: "学習済み", zh: "Learned", de: "Gelernt" })
                          : isSelected
                            ? t({ ko: "선택됨", en: "Selected", ja: "選択", zh: "Selected", de: "Ausgewählt" })
                            : t({ ko: "대기", en: "Idle", ja: "待機", zh: "Idle", de: "Inaktiv" })}
                      </div>
                      {isAlreadyLearned && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onUnlearnProvider(row.provider);
                          }}
                          disabled={learnInProgress || isUnlearning}
                          className={`skill-unlearn-btn rounded-md border px-2 py-0.5 text-[10px] transition-all ${
                            learnInProgress || isUnlearning
                              ? "cursor-not-allowed text-slate-600"
                              : "border-rose-500/35 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                          }`}
                        >
                          {isUnlearning
                            ? t({
                                ko: "취소중...",
                                en: "Unlearning...",
                                ja: "取消中...",
                                zh: "Unlearning...",
                                de: "Verlernen...",
                              })
                            : t({ ko: "학습 취소", en: "Unlearn", ja: "学習取消", zh: "Unlearn", de: "Verlernen" })}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            className="rounded-xl border p-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "작업 상태", en: "Job status", ja: "ジョブ状態", zh: "Job status", de: "Auftragsstatus" })}:{" "}
                <span
                  className={`font-medium ${
                    learnJob?.status === "succeeded"
                      ? "text-emerald-300"
                      : learnJob?.status === "failed"
                        ? "text-rose-300"
                        : learnJob?.status === "running" || learnJob?.status === "queued"
                          ? "text-amber-300"
                          : ""
                  }`}
                >
                  {learningStatusLabel(learnJob?.status ?? null, t)}
                </span>
              </div>

              {learnJob?.completedAt && (
                <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {new Intl.DateTimeFormat(localeTag, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(new Date(learnJob.completedAt))}
                </div>
              )}
            </div>

            {learnError && <div className="mt-2 text-[11px] text-rose-300">{learnError}</div>}
            {unlearnError && <div className="mt-2 text-[11px] text-rose-300">{unlearnError}</div>}
            {learnJob?.error && <div className="mt-2 text-[11px] text-rose-300">{learnJob.error}</div>}

            {learnJob && (
              <div
                className="mt-2 rounded-lg border p-2 font-mono text-[10px] max-h-32 overflow-y-auto space-y-1"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-bg-secondary)",
                  color: "var(--th-text-secondary)",
                }}
              >
                <div style={{ color: "var(--th-text-muted)" }}>$ {learnJob.command}</div>
                {learnJob.logTail.length > 0 ? (
                  learnJob.logTail.slice(-10).map((line, idx) => <div key={`${learnJob.id}-log-${idx}`}>{line}</div>)
                ) : (
                  <div className="text-slate-600">
                    {t({
                      ko: "로그가 아직 없습니다",
                      en: "No logs yet",
                      ja: "ログはまだありません",
                      zh: "No logs yet",
                      de: "Noch keine Protokolle",
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={learnInProgress}
              className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                learnInProgress ? "cursor-not-allowed text-slate-600" : ""
              }`}
              style={
                learnInProgress
                  ? { borderColor: "var(--th-border)" }
                  : { borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }
              }
            >
              {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
            </button>
            <button
              onClick={onStartLearning}
              disabled={
                selectedProviders.length === 0 ||
                learnSubmitting ||
                learnInProgress ||
                defaultSelectedProviders.length === 0
              }
              className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                selectedProviders.length === 0 || learnInProgress || defaultSelectedProviders.length === 0
                  ? "cursor-not-allowed text-slate-600"
                  : "border-emerald-500/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
              }`}
            >
              {learnSubmitting || learnInProgress
                ? t({ ko: "학습중...", en: "Learning...", ja: "学習中...", zh: "Learning...", de: "Lernen..." })
                : t({
                    ko: "학습 시작",
                    en: "Start Learning",
                    ja: "学習開始",
                    zh: "Start Learning",
                    de: "Lernen starten",
                  })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
