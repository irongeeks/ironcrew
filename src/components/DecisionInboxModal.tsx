import { useEffect, useMemo, useState } from "react";
import { pickLang } from "../i18n";
import type { Agent } from "../types";
import AgentAvatar, { buildSpriteMap } from "./AgentAvatar";
import MessageContent from "./MessageContent";
import type { DecisionInboxItem } from "./chat/decision-inbox";
import { formatDecisionInboxTime as formatTime, type DecisionInboxModalProps } from "./chat/decision-inbox-modal.meta";
import TaskFileBrowser from "./decision-inbox/TaskFileBrowser";

export default function DecisionInboxModal({
  open,
  loading,
  items,
  agents,
  busyKey,
  uiLanguage,
  onClose,
  onRefresh,
  onReplyOption,
  onOpenChat,
  onOpenTaskReport,
  onOpenDiff,
  onOpenTerminal,
}: DecisionInboxModalProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);
  const isKorean = uiLanguage.startsWith("ko");
  const spriteMap = useMemo(() => buildSpriteMap(agents), [agents]);
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);
  const [followupTarget, setFollowupTarget] = useState<{
    itemId: string;
    optionNumber: number;
  } | null>(null);
  const [followupDraft, setFollowupDraft] = useState("");
  const [reviewPickSelections, setReviewPickSelections] = useState<Record<string, number[]>>({});
  const [reviewPickDrafts, setReviewPickDrafts] = useState<Record<string, string>>({});
  const [reviewPickErrors, setReviewPickErrors] = useState<Record<string, string>>({});
  const [expandedContent, setExpandedContent] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFollowupTarget(null);
      setFollowupDraft("");
      setReviewPickSelections({});
      setReviewPickDrafts({});
      setReviewPickErrors({});
      return;
    }
    if (!followupTarget) return;
    const stillExists = items.some((entry) => entry.id === followupTarget.itemId);
    if (!stillExists) {
      setFollowupTarget(null);
      setFollowupDraft("");
    }
  }, [open, followupTarget, items]);

  useEffect(() => {
    setReviewPickSelections((prev) => {
      const keep = new Set(items.map((item) => item.id));
      const next: Record<string, number[]> = {};
      let changed = false;
      for (const [itemId, nums] of Object.entries(prev)) {
        if (!keep.has(itemId)) {
          changed = true;
          continue;
        }
        next[itemId] = nums;
      }
      return changed ? next : prev;
    });
    setReviewPickDrafts((prev) => {
      const keep = new Set(items.map((item) => item.id));
      const next: Record<string, string> = {};
      let changed = false;
      for (const [itemId, draft] of Object.entries(prev)) {
        if (!keep.has(itemId)) {
          changed = true;
          continue;
        }
        next[itemId] = draft;
      }
      return changed ? next : prev;
    });
  }, [items]);

  const followupItem = useMemo(
    () => (followupTarget ? (items.find((entry) => entry.id === followupTarget.itemId) ?? null) : null),
    [followupTarget, items],
  );
  const followupBusyKey = followupTarget ? `${followupTarget.itemId}:${followupTarget.optionNumber}` : null;
  const isFollowupSubmitting = followupBusyKey ? busyKey === followupBusyKey : false;
  const canSubmitFollowup = !!(followupItem && followupDraft.trim() && !isFollowupSubmitting);

  function handleOptionClick(item: DecisionInboxItem, optionNumber: number, action?: string) {
    if (action === "add_followup_request") {
      setFollowupTarget({ itemId: item.id, optionNumber });
      setFollowupDraft("");
      return;
    }
    onReplyOption(item, optionNumber).catch((err) => {
      console.error("[DecisionInbox] reply failed:", err instanceof Error ? err.message : err);
    });
  }

  async function handleSubmitFollowup() {
    if (!followupItem || !followupTarget) return;
    const note = followupDraft.trim();
    if (!note) return;
    try {
      await onReplyOption(followupItem, followupTarget.optionNumber, { note });
      setFollowupTarget(null);
      setFollowupDraft("");
    } catch {
      // Keep the draft so the user can retry
    }
  }

  function handleCancelFollowup() {
    setFollowupTarget(null);
    setFollowupDraft("");
  }

  function getReviewPickOptions(item: DecisionInboxItem) {
    return item.options.filter((option) => option.action === "apply_review_pick");
  }

  function getReviewSkipOption(item: DecisionInboxItem) {
    return item.options.find((option) => option.action === "skip_to_next_round");
  }

  function toggleReviewPick(itemId: string, optionNumber: number) {
    setReviewPickSelections((prev) => {
      const current = prev[itemId] ?? [];
      const exists = current.includes(optionNumber);
      const nextList = exists
        ? current.filter((num) => num !== optionNumber)
        : [...current, optionNumber].sort((a, b) => a - b);
      return {
        ...prev,
        [itemId]: nextList,
      };
    });
  }

  function setReviewDraft(itemId: string, value: string) {
    setReviewPickDrafts((prev) => ({
      ...prev,
      [itemId]: value,
    }));
  }

  function clearReviewInput(itemId: string) {
    setReviewPickSelections((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setReviewPickDrafts((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  async function handleSubmitReviewPick(item: DecisionInboxItem) {
    const pickOptions = getReviewPickOptions(item);
    const selected = reviewPickSelections[item.id] ?? [];
    const extraNote = (reviewPickDrafts[item.id] ?? "").trim();
    const optionNumber = selected[0] ?? pickOptions[0]?.number;
    if (!optionNumber) return;
    if (selected.length <= 0 && !extraNote) {
      setReviewPickErrors((prev) => ({
        ...prev,
        [item.id]: t({
          ko: "최소 1개 선택하거나 추가 의견을 입력해 주세요.",
          en: "Pick at least one option or enter an extra note.",
          ja: "少なくとも1件を選択するか、追加意見を入力してください。",
          zh: "Pick at least one option or enter an extra note.",
          de: "Bitte mindestens eine Option wählen oder eine zusätzliche Notiz eingeben.",
        }),
      }));
      return;
    }
    setReviewPickErrors((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      await onReplyOption(item, optionNumber, {
        selected_option_numbers: selected,
        ...(extraNote ? { note: extraNote } : {}),
      });
      clearReviewInput(item.id);
    } catch {
      // Keep selections so the user can retry
    }
  }

  async function handleSkipReviewRound(item: DecisionInboxItem) {
    const skipOption = getReviewSkipOption(item);
    if (!skipOption) return;
    try {
      await onReplyOption(item, skipOption.number);
      clearReviewInput(item.id);
    } catch {
      // Keep selections so the user can retry
    }
  }

  const getKindLabel = (kind: DecisionInboxItem["kind"]) => {
    if (kind === "project_review_ready") {
      return t({
        ko: "프로젝트 의사결정",
        en: "Project Decision",
        ja: "プロジェクト判断",
        zh: "Project Decision",
        de: "Projektentscheidung",
      });
    }
    if (kind === "task_timeout_resume") {
      return t({
        ko: "중단 작업 재개",
        en: "Timeout Resume",
        ja: "中断タスク再開",
        zh: "Timeout Resume",
        de: "Timeout-Wiederaufnahme",
      });
    }
    if (kind === "review_round_pick") {
      return t({
        ko: "리뷰 라운드 의사결정",
        en: "Review Round Decision",
        ja: "レビューラウンド判断",
        zh: "Review Round Decision",
        de: "Überprüfungsrunden-Entscheidung",
      });
    }
    return t({
      ko: "에이전트 요청",
      en: "Agent Request",
      ja: "エージェント要請",
      zh: "Agent Request",
      de: "Agent-Anfrage",
    });
  };
  const getKindAvatarFallback = (kind: DecisionInboxItem["kind"]) => {
    if (kind === "project_review_ready") return "🧑‍💼";
    if (kind === "task_timeout_resume") return "⏱️";
    if (kind === "review_round_pick") return "🧾";
    return "🤖";
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 w-full max-w-3xl overflow-hidden border border-indigo-500/30 shadow-[var(--shadow-modal)]"
        style={{ background: "var(--th-bg-secondary)", borderRadius: "var(--radius-lg)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧭</span>
            <h2 className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "미결 의사결정",
                en: "Pending Decisions",
                ja: "未決の意思決定",
                zh: "Pending Decisions",
                de: "Ausstehende Entscheidungen",
              })}
            </h2>
            <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-300">
              {items.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              className="rounded-lg border px-3 py-1.5 text-xs transition"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            >
              {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition"
              style={{ color: "var(--th-text-secondary)" }}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {loading ? (
            <div className="py-12 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "미결 목록 불러오는 중...",
                en: "Loading pending decisions...",
                ja: "未決一覧を読み込み中...",
                zh: "Loading pending decisions...",
                de: "Ausstehende Entscheidungen werden geladen...",
              })}
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "현재 미결 의사결정이 없습니다.",
                en: "No pending decisions right now.",
                ja: "現在、未決の意思決定はありません。",
                zh: "No pending decisions right now.",
                de: "Aktuell keine ausstehenden Entscheidungen.",
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border p-3"
                  style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    {(() => {
                      const agent = item.agentId ? agentById.get(item.agentId) : undefined;
                      return (
                        <div className="flex min-w-0 items-start gap-2">
                          {agent ? (
                            <AgentAvatar agent={agent} spriteMap={spriteMap} size={32} className="mt-0.5" />
                          ) : (
                            <span
                              className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-base"
                              style={{ borderColor: "var(--th-border-strong)", background: "var(--th-bg-secondary)" }}
                            >
                              {item.agentAvatar || getKindAvatarFallback(item.kind)}
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                              {isKorean ? item.agentNameKo : item.agentName}
                            </p>
                            <p className="text-[11px] text-indigo-300/90">{getKindLabel(item.kind)}</p>
                            <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                              {formatTime(item.createdAt, uiLanguage)}
                            </p>
                          </div>
                        </div>
                      );
                    })()}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.taskId && onOpenTaskReport ? (
                        <button
                          onClick={() => onOpenTaskReport(item.taskId!)}
                          className="rounded-md border px-2 py-1 text-[11px] font-medium transition hover:opacity-80"
                          style={{
                            borderColor: "var(--accent)",
                            color: "var(--accent)",
                            background: "var(--accent-dim)",
                          }}
                        >
                          {t({
                            ko: "전체 보고서",
                            en: "View Report",
                            ja: "レポートを見る",
                            zh: "View Report",
                            de: "Bericht öffnen",
                          })}
                        </button>
                      ) : null}
                      {item.agentId ? (
                        <button
                          onClick={() => onOpenChat(item.agentId!)}
                          className="rounded-md border px-2 py-1 text-[11px] transition"
                          style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
                        >
                          {t({
                            ko: "채팅 열기",
                            en: "Open Chat",
                            ja: "チャットを開く",
                            zh: "Open Chat",
                            de: "Chat öffnen",
                          })}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className="relative rounded-lg border text-xs"
                    style={{
                      borderColor: "var(--th-border)",
                      background: "var(--th-bg-secondary)",
                      color: "var(--th-text-primary)",
                    }}
                  >
                    <div className="max-h-40 overflow-hidden px-2.5 py-2">
                      <MessageContent content={item.requestContent} />
                    </div>
                    {item.requestContent.length > 300 && (
                      <div
                        className="flex items-center justify-between border-t px-2.5 py-1.5"
                        style={{
                          borderColor: "var(--th-border)",
                          background: "var(--th-card-bg)",
                        }}
                      >
                        <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                          {t({
                            ko: "내용이 잘렸습니다",
                            en: "Content truncated",
                            ja: "内容が省略されています",
                            zh: "Content truncated",
                            de: "Inhalt abgeschnitten",
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={() => setExpandedContent(item.requestContent)}
                          className="rounded px-2 py-0.5 text-[10px] font-medium transition hover:opacity-80"
                          style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
                        >
                          {t({
                            ko: "전체 보기",
                            en: "Read full report",
                            ja: "全文を読む",
                            zh: "Read full report",
                            de: "Vollständigen Bericht lesen",
                          })}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* File Browser */}
                  {(item.taskId || item.projectPath) && (
                    <TaskFileBrowser
                      taskId={item.taskId}
                      projectPath={item.projectPath}
                      uiLanguage={uiLanguage}
                      agentName={item.agentName}
                      onOpenDiff={onOpenDiff}
                      onOpenTerminal={onOpenTerminal}
                    />
                  )}

                  <div className="mt-2 space-y-1.5">
                    {item.kind === "review_round_pick" ? (
                      (() => {
                        if (item.options.length === 0) {
                          return (
                            <p
                              className="rounded-md border px-2.5 py-2 text-xs"
                              style={{
                                borderColor: "var(--th-border)",
                                background: "var(--th-bg-secondary)",
                                color: "var(--th-text-secondary)",
                              }}
                            >
                              {t({
                                ko: "기획팀장 의견 취합중...",
                                en: "Planning lead is consolidating opinions...",
                                ja: "企画リードが意見を集約中...",
                                zh: "Planning lead is consolidating opinions...",
                              })}
                            </p>
                          );
                        }
                        const pickOptions = getReviewPickOptions(item);
                        const skipOption = getReviewSkipOption(item);
                        const selected = reviewPickSelections[item.id] ?? [];
                        const selectedCount = selected.length;
                        const draft = reviewPickDrafts[item.id] ?? "";
                        const isItemBusy = Boolean(busyKey?.startsWith(`${item.id}:`));
                        return (
                          <div className="space-y-2">
                            {pickOptions.map((option) => {
                              const selectedFlag = selected.includes(option.number);
                              return (
                                <button
                                  key={`${item.id}:${option.number}`}
                                  type="button"
                                  onClick={() => toggleReviewPick(item.id, option.number)}
                                  disabled={isItemBusy}
                                  className={`decision-inbox-option w-full rounded-md px-2.5 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-60${selectedFlag ? " decision-inbox-option-active" : ""}`}
                                >
                                  {`${option.number}. ${option.label}`}
                                </button>
                              );
                            })}
                            <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                              {t({
                                ko: `선택 항목: ${selectedCount}건`,
                                en: `Selected: ${selectedCount} item(s)`,
                                ja: `選択項目: ${selectedCount}件`,
                                zh: `Selected: ${selectedCount} item(s)`,
                                de: `Ausgewählt: ${selectedCount} Element(e)`,
                              })}
                            </p>
                            <textarea
                              value={draft}
                              onChange={(event) => setReviewDraft(item.id, event.target.value)}
                              rows={2}
                              placeholder={t({
                                ko: "추가 의견이 있으면 입력해 주세요. (선택)",
                                en: "Enter extra notes if needed. (Optional)",
                                ja: "追加意見があれば入力してください。（任意）",
                                zh: "Enter extra notes if needed. (Optional)",
                                de: "Zusätzliche Anmerkungen bei Bedarf eingeben. (Optional)",
                              })}
                              className="w-full resize-y rounded-lg border px-3 py-2 text-xs placeholder:text-[var(--text-muted)] focus:border-indigo-400 focus:outline-none"
                              style={{
                                background: "var(--th-input-bg)",
                                borderColor: "var(--th-input-border)",
                                color: "var(--th-text-primary)",
                              }}
                            />
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {skipOption ? (
                                <button
                                  type="button"
                                  onClick={() => handleSkipReviewRound(item)}
                                  disabled={isItemBusy}
                                  className="decision-round-skip rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isItemBusy
                                    ? t({
                                        ko: "전송 중...",
                                        en: "Sending...",
                                        ja: "送信中...",
                                        zh: "Sending...",
                                        de: "Senden...",
                                      })
                                    : `${skipOption.number}. ${skipOption.label}`}
                                </button>
                              ) : null}
                              {reviewPickErrors[item.id] && (
                                <span className="text-xs text-red-400" role="alert">
                                  {reviewPickErrors[item.id]}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleSubmitReviewPick(item)}
                                disabled={isItemBusy}
                                className="decision-round-submit rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isItemBusy
                                  ? t({
                                      ko: "전송 중...",
                                      en: "Sending...",
                                      ja: "送信中...",
                                      zh: "Sending...",
                                      de: "Senden...",
                                    })
                                  : t({
                                      ko: "선택 항목 진행",
                                      en: "Run Selected",
                                      ja: "選択項目で進行",
                                      zh: "Run Selected",
                                      de: "Auswahl ausführen",
                                    })}
                              </button>
                            </div>
                          </div>
                        );
                      })()
                    ) : item.options.length > 0 ? (
                      item.options.map((option) => {
                        const key = `${item.id}:${option.number}`;
                        const isBusy = busyKey === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => handleOptionClick(item, option.number, option.action)}
                            disabled={isBusy}
                            className="decision-inbox-option w-full rounded-md px-2.5 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isBusy
                              ? t({
                                  ko: "전송 중...",
                                  en: "Sending...",
                                  ja: "送信中...",
                                  zh: "Sending...",
                                  de: "Senden...",
                                })
                              : `${option.number}. ${option.label}`}
                          </button>
                        );
                      })
                    ) : (
                      <p
                        className="rounded-md border px-2.5 py-2 text-xs"
                        style={{
                          borderColor: "var(--th-border)",
                          background: "var(--th-bg-secondary)",
                          color: "var(--th-text-secondary)",
                        }}
                      >
                        {item.kind === "project_review_ready"
                          ? t({
                              ko: "기획팀장 의견 취합중...",
                              en: "Planning lead is consolidating opinions...",
                              ja: "企画リードが意見を集約中...",
                              zh: "Planning lead is consolidating opinions...",
                              de: "Planungsleitung sammelt Meinungen...",
                            })
                          : t({
                              ko: "선택지 준비 중...",
                              en: "Options are being prepared...",
                              ja: "選択肢を準備中...",
                              zh: "Options are being prepared...",
                              de: "Optionen werden vorbereitet...",
                            })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {expandedContent !== null && (
          <div
            className="absolute inset-0 z-10 flex flex-col"
            style={{ background: "var(--th-bg-secondary)", borderRadius: "var(--radius-lg)" }}
          >
            <div
              className="flex shrink-0 items-center justify-between border-b px-6 py-4"
              style={{ borderColor: "var(--th-border)" }}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">📄</span>
                <h3 className="text-sm font-bold" style={{ color: "var(--th-text-heading)" }}>
                  {t({
                    ko: "전체 보고서",
                    en: "Full Report",
                    ja: "全文レポート",
                    zh: "Full Report",
                    de: "Vollständiger Bericht",
                  })}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setExpandedContent(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg transition"
                style={{ color: "var(--th-text-secondary)" }}
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm" style={{ color: "var(--th-text-primary)" }}>
              <MessageContent content={expandedContent} />
            </div>
          </div>
        )}
        {followupItem ? (
          <div
            className="border-t px-4 py-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          >
            <p className="mb-2 text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {t({
                ko: "추가요청사항 입력",
                en: "Additional Follow-up Request",
                ja: "追加要請内容の入力",
                zh: "Additional Follow-up Request",
                de: "Zusätzliche Folgeanfrage eingeben",
              })}
            </p>
            <textarea
              value={followupDraft}
              onChange={(event) => setFollowupDraft(event.target.value)}
              placeholder={t({
                ko: "요청사항을 입력해 주세요.",
                en: "Enter your request details.",
                ja: "要請内容を入力してください。",
                zh: "Enter your request details.",
                de: "Bitte Anforderungsdetails eingeben.",
              })}
              rows={3}
              className="w-full resize-y rounded-lg border px-3 py-2 text-xs placeholder:text-[var(--text-muted)] focus:border-indigo-400 focus:outline-none"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelFollowup}
                disabled={isFollowupSubmitting}
                className="rounded-md border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-60"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
              >
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                onClick={handleSubmitFollowup}
                disabled={!canSubmitFollowup}
                className="decision-followup-submit rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isFollowupSubmitting
                  ? t({ ko: "전송 중...", en: "Sending...", ja: "送信中...", zh: "Sending...", de: "Senden..." })
                  : t({
                      ko: "요청 등록",
                      en: "Submit Request",
                      ja: "要請登録",
                      zh: "Submit Request",
                      de: "Anfrage einreichen",
                    })}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
