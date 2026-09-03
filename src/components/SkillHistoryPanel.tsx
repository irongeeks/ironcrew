import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAvailableLearnedSkills,
  getSkillLearningHistory,
  unlearnSkill,
  type LearnedSkillEntry,
  type SkillHistoryProvider,
  type SkillLearningHistoryEntry,
} from "../api";
import { type Agent } from "../types";
import AgentAvatar from "./AgentAvatar";
import {
  HISTORY_PREVIEW_COUNT,
  PROVIDER_ORDER,
  learningRowKey,
  normalizeSkillLabel,
  pickRepresentativeForProvider,
  providerLabel,
  relativeTime,
  statusClass,
  statusLabel,
} from "./skill-history/utils";

type UnlearnEffect = "pot" | "hammer";

interface SkillHistoryPanelProps {
  agents: Agent[];
  refreshToken?: number;
  className?: string;
  onLearningDataChanged?: () => void;
}

export default function SkillHistoryPanel({
  agents,
  refreshToken = 0,
  className = "",
  onLearningDataChanged,
}: SkillHistoryPanelProps) {
  const [tab, setTab] = useState<"history" | "available">("history");
  const [providerFilter, setProviderFilter] = useState<"all" | SkillHistoryProvider>("all");
  const [historyRows, setHistoryRows] = useState<SkillLearningHistoryEntry[]>([]);
  const [availableRows, setAvailableRows] = useState<LearnedSkillEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState<number>(180);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlearnError, setUnlearnError] = useState<string | null>(null);
  const [unlearningKeys, setUnlearningKeys] = useState<string[]>([]);
  const [unlearnEffects, setUnlearnEffects] = useState<Partial<Record<string, UnlearnEffect>>>({});
  const [centerBonk, setCenterBonk] = useState<{
    provider: SkillHistoryProvider;
    agent: Agent | null;
  } | null>(null);
  const unlearnEffectTimersRef = useRef<Partial<Record<string, number>>>({});
  const centerBonkTimerRef = useRef<number | null>(null);

  const representatives = useMemo(() => {
    const out = new Map<SkillHistoryProvider, Agent | null>();
    for (const provider of PROVIDER_ORDER) {
      out.set(provider, pickRepresentativeForProvider(agents, provider));
    }
    return out;
  }, [agents]);

  const activeProviders = useMemo(() => {
    const fromRows = new Set<SkillHistoryProvider>();
    for (const row of historyRows) fromRows.add(row.provider);
    for (const row of availableRows) fromRows.add(row.provider);
    for (const provider of PROVIDER_ORDER) {
      if (representatives.get(provider)) {
        fromRows.add(provider);
      }
    }
    return PROVIDER_ORDER.filter((provider) => fromRows.has(provider));
  }, [availableRows, historyRows, representatives]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const provider = providerFilter === "all" ? undefined : providerFilter;
      const [historyData, availableData] = await Promise.all([
        getSkillLearningHistory({ provider, limit: 80 }),
        getAvailableLearnedSkills({ provider, limit: 30 }),
      ]);
      setHistoryRows(historyData.history);
      setAvailableRows(availableData);
      if (historyData.retentionDays > 0) {
        setRetentionDays(historyData.retentionDays);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [providerFilter]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void load();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setHistoryExpanded(false);
  }, [providerFilter, tab]);

  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const timerId of Object.values(unlearnEffectTimersRef.current)) {
        if (typeof timerId === "number") {
          window.clearTimeout(timerId);
        }
      }
      if (typeof centerBonkTimerRef.current === "number") {
        window.clearTimeout(centerBonkTimerRef.current);
      }
    };
  }, []);

  function triggerUnlearnEffect(rowKey: string, provider: SkillHistoryProvider) {
    const effect: UnlearnEffect = Math.random() < 0.5 ? "pot" : "hammer";
    setUnlearnEffects((prev) => ({ ...prev, [rowKey]: effect }));
    setCenterBonk({
      provider,
      agent: representatives.get(provider) ?? null,
    });
    if (typeof centerBonkTimerRef.current === "number") {
      window.clearTimeout(centerBonkTimerRef.current);
    }
    centerBonkTimerRef.current = window.setTimeout(() => {
      setCenterBonk(null);
      centerBonkTimerRef.current = null;
    }, 950);
    const existingTimer = unlearnEffectTimersRef.current[rowKey];
    if (typeof existingTimer === "number") {
      window.clearTimeout(existingTimer);
    }
    unlearnEffectTimersRef.current[rowKey] = window.setTimeout(() => {
      setUnlearnEffects((prev) => {
        const next = { ...prev };
        delete next[rowKey];
        return next;
      });
      delete unlearnEffectTimersRef.current[rowKey];
    }, 1100);
  }

  async function handleUnlearn(row: { provider: SkillHistoryProvider; repo: string; skill_id: string }) {
    const rowKey = learningRowKey(row);
    if (unlearningKeys.includes(rowKey)) return;
    setUnlearnError(null);
    setUnlearningKeys((prev) => [...prev, rowKey]);
    try {
      const result = await unlearnSkill({
        provider: row.provider,
        repo: row.repo,
        skillId: row.skill_id,
      });
      if (result.removed > 0) {
        setAvailableRows((prev) => prev.filter((item) => learningRowKey(item) !== rowKey));
        setHistoryRows((prev) =>
          prev.filter(
            (item) =>
              !(
                item.provider === row.provider &&
                item.repo === row.repo &&
                item.skill_id === row.skill_id &&
                item.status === "succeeded"
              ),
          ),
        );
        triggerUnlearnEffect(rowKey, row.provider);
      }
      onLearningDataChanged?.();
      void load();
    } catch (e) {
      setUnlearnError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlearningKeys((prev) => prev.filter((key) => key !== rowKey));
    }
  }

  const visibleHistoryRows = useMemo(() => {
    if (historyExpanded) return historyRows;
    return historyRows.slice(0, HISTORY_PREVIEW_COUNT);
  }, [historyExpanded, historyRows]);

  const hiddenHistoryCount = Math.max(0, historyRows.length - HISTORY_PREVIEW_COUNT);

  return (
    <div
      className={`skill-history-panel flex h-full min-h-[360px] flex-col rounded-xl border ${className}`}
      style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-2.5"
        style={{ borderColor: "var(--th-border)" }}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("history")}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-all ${
              tab === "history" ? "" : "hover:text-slate-200"
            }`}
            style={
              tab === "history"
                ? { background: "var(--th-bg-surface-hover)", color: "var(--th-text-heading)" }
                : { color: "var(--th-text-secondary)" }
            }
          >
            Learning History
          </button>
          <button
            type="button"
            onClick={() => setTab("available")}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-all ${
              tab === "available" ? "" : "hover:text-slate-200"
            }`}
            style={
              tab === "available"
                ? { background: "var(--th-bg-surface-hover)", color: "var(--th-text-heading)" }
                : { color: "var(--th-text-secondary)" }
            }
          >
            Available Skills
          </button>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border px-2 py-1 text-[11px] transition-all"
          style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
        >
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto px-3 py-2">
        <button
          type="button"
          onClick={() => setProviderFilter("all")}
          className={`rounded-md border px-2 py-1 text-[10px] transition-all ${
            providerFilter === "all" ? "border-blue-500/50 bg-blue-600/20 text-blue-300" : "hover:text-slate-200"
          }`}
          style={
            providerFilter === "all"
              ? undefined
              : { borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }
          }
        >
          All
        </button>
        {activeProviders.map((provider) => (
          <button
            key={provider}
            type="button"
            onClick={() => setProviderFilter(provider)}
            className={`rounded-md border px-2 py-1 text-[10px] transition-all ${
              providerFilter === provider ? "border-blue-500/50 bg-blue-600/20 text-blue-300" : "hover:text-slate-200"
            }`}
            style={
              providerFilter === provider
                ? undefined
                : { borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }
            }
          >
            {providerLabel(provider)}
          </button>
        ))}
      </div>

      <div className="px-3 pb-2 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
        Retention: {retentionDays} days
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {loading && historyRows.length === 0 && availableRows.length === 0 && (
          <div
            className="rounded-lg border px-3 py-6 text-center text-xs"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-card-bg)",
              color: "var(--th-text-secondary)",
            }}
          >
            Loading memory records...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
            {error}
          </div>
        )}
        {unlearnError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
            {unlearnError}
          </div>
        )}

        {tab === "history" && historyRows.length === 0 && !loading && !error && (
          <div
            className="rounded-lg border px-3 py-6 text-center text-xs"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-card-bg)",
              color: "var(--th-text-secondary)",
            }}
          >
            No learning history yet.
          </div>
        )}

        {tab === "history" &&
          visibleHistoryRows.map((row) => {
            const agent = representatives.get(row.provider) ?? null;
            const label = normalizeSkillLabel(row);
            const eventAt = row.run_completed_at ?? row.updated_at ?? row.created_at;
            const rowKey = learningRowKey(row);
            const isUnlearning = unlearningKeys.includes(rowKey);
            const unlearnEffect = unlearnEffects[rowKey];
            const canUnlearn = row.status === "succeeded";
            return (
              <div
                key={row.id}
                className="skill-history-card rounded-lg border p-2.5"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-slate-100">{label}</div>
                    <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                      {row.repo}
                    </div>
                  </div>
                  <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${statusClass(row.status)}`}>
                    {statusLabel(row.status)}
                  </span>
                </div>
                <div
                  className="skill-history-meta mt-2 flex items-center justify-between gap-2 text-[10px]"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className={`relative h-5 w-5 overflow-hidden rounded-md ${unlearnEffect ? "unlearn-avatar-hit" : ""}`}
                      style={{ background: "var(--th-card-bg)" }}
                    >
                      <AgentAvatar agent={agent ?? undefined} agents={agents} size={20} rounded="xl" />
                      {unlearnEffect === "pot" && <span className="unlearn-pot-drop-sm">🪴</span>}
                      {unlearnEffect === "hammer" && <span className="unlearn-hammer-swing-sm">🔨</span>}
                      {unlearnEffect && <span className="unlearn-hit-text-sm">Bonk!</span>}
                    </div>
                    <span className="truncate">
                      {providerLabel(row.provider)}
                      {agent ? ` · ${agent.name}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canUnlearn && (
                      <button
                        type="button"
                        onClick={() => void handleUnlearn(row)}
                        disabled={isUnlearning}
                        className={`skill-unlearn-btn rounded-md border px-1.5 py-0.5 text-[10px] transition-all ${
                          isUnlearning
                            ? "cursor-not-allowed text-slate-600"
                            : "border-rose-500/35 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                        }`}
                      >
                        {isUnlearning ? "Unlearning..." : "Unlearn"}
                      </button>
                    )}
                    <span className="skill-history-time" style={{ color: "var(--th-text-muted)" }}>
                      {relativeTime(eventAt)}
                    </span>
                  </div>
                </div>
                {row.error && <div className="mt-1 break-words text-[10px] text-rose-300">{row.error}</div>}
              </div>
            );
          })}

        {tab === "history" && hiddenHistoryCount > 0 && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={() => setHistoryExpanded((prev) => !prev)}
              className="rounded-md border px-2.5 py-1 text-[11px] transition-all hover:text-white"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
            >
              {historyExpanded ? "Show less" : `Show ${hiddenHistoryCount} more`}
            </button>
          </div>
        )}

        {tab === "available" && availableRows.length === 0 && !loading && !error && (
          <div
            className="rounded-lg border px-3 py-6 text-center text-xs"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-card-bg)",
              color: "var(--th-text-secondary)",
            }}
          >
            No available skills.
          </div>
        )}

        {tab === "available" &&
          availableRows.map((row) => {
            const agent = representatives.get(row.provider) ?? null;
            const label = normalizeSkillLabel(row);
            const rowKey = learningRowKey(row);
            const isUnlearning = unlearningKeys.includes(rowKey);
            const unlearnEffect = unlearnEffects[rowKey];
            return (
              <div
                key={`${row.provider}-${row.repo}-${row.skill_id}`}
                className="skill-history-card rounded-lg border p-2.5"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                <div className="truncate text-xs font-semibold text-slate-100">{label}</div>
                <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                  {row.repo}
                </div>
                <div
                  className="skill-history-meta mt-2 flex items-center justify-between gap-2 text-[10px]"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className={`relative h-5 w-5 overflow-hidden rounded-md ${unlearnEffect ? "unlearn-avatar-hit" : ""}`}
                      style={{ background: "var(--th-card-bg)" }}
                    >
                      <AgentAvatar agent={agent ?? undefined} agents={agents} size={20} rounded="xl" />
                      {unlearnEffect === "pot" && <span className="unlearn-pot-drop-sm">🪴</span>}
                      {unlearnEffect === "hammer" && <span className="unlearn-hammer-swing-sm">🔨</span>}
                      {unlearnEffect && <span className="unlearn-hit-text-sm">Bonk!</span>}
                    </div>
                    <span className="truncate">
                      {providerLabel(row.provider)}
                      {agent ? ` · ${agent.name}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUnlearn(row)}
                      disabled={isUnlearning}
                      className={`skill-unlearn-btn rounded-md border px-1.5 py-0.5 text-[10px] transition-all ${
                        isUnlearning
                          ? "cursor-not-allowed text-slate-600"
                          : "border-rose-500/35 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                      }`}
                    >
                      {isUnlearning ? "Unlearning..." : "Unlearn"}
                    </button>
                    <span className="skill-history-time" style={{ color: "var(--th-text-muted)" }}>
                      {relativeTime(row.learned_at)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
      {centerBonk && (
        <div className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center">
          <div
            className="skill-history-center-card unlearn-center-card rounded-2xl border border-rose-400/30 px-6 py-4 shadow-2xl shadow-black/50 backdrop-blur-sm"
            style={{ background: "var(--th-bg-secondary)" }}
          >
            <div className="relative mx-auto h-20 w-20 overflow-visible">
              <div className="unlearn-avatar-hit">
                <AgentAvatar agent={centerBonk.agent ?? undefined} agents={agents} size={80} rounded="xl" />
              </div>
              <span className="unlearn-hammer-swing-center">🔨</span>
              <span className="unlearn-hit-text-center">Bonk!</span>
            </div>
            <div className="skill-history-center-label mt-2 text-center text-xs font-medium text-rose-100">
              {providerLabel(centerBonk.provider)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
