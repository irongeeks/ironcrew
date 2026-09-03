import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "./types";
import { fetchLoadedPacks, reloadPacks, type LoadedPackEntry } from "../../api/workflow-packs";

interface WorkflowPackSettingsTabProps {
  t: TFunction;
}

/**
 * Render a simple text-based DAG for pipeline phases.
 * For multi-phase packs, shows: phase1 → phase2 → …
 * For single-phase packs, returns null.
 */
function PhaseGraph({ phases }: { phases: LoadedPackEntry["phases"] }) {
  if (phases.length === 0) return null;

  const chain = phases.map((p) => (p.fanOut ? `${p.id} (parallel, fan-out)` : p.id)).join(" → ");
  const deptHints = phases.map((p) => `[${p.id}:${p.department}${p.fanOut ? "×N" : ""}]`).join(" ");

  return (
    <div
      className="mt-2 overflow-x-auto rounded px-3 py-2 font-mono text-[10px]"
      style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
    >
      <div>{chain}</div>
      <div className="mt-0.5 text-[9px]" style={{ color: "var(--th-text-muted)" }}>
        {deptHints}
      </div>
    </div>
  );
}

function PackCard({ pack, t }: { pack: LoadedPackEntry; t: TFunction }) {
  const [expanded, setExpanded] = useState(false);
  const isMultiPhase = pack.phases.length > 0;

  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-200">{pack.name}</span>
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px]"
              style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-muted)" }}
            >
              v{pack.version}
            </span>
            {!pack.enabled && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] text-amber-400"
                style={{ background: "rgba(251,191,36,0.1)" }}
              >
                {t({ ko: "비활성화", en: "disabled", ja: "無効", zh: "disabled", de: "deaktiviert" })}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px]"
              style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
            >
              {pack.key}
            </span>
            <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              {isMultiPhase
                ? t({
                    ko: `${pack.phaseCount}단계 파이프라인`,
                    en: `${pack.phaseCount}-phase pipeline`,
                    ja: `${pack.phaseCount}フェーズ パイプライン`,
                    zh: `${pack.phaseCount}-phase pipeline`,
                    de: `${pack.phaseCount}-Phasen-Pipeline`,
                  })
                : t({
                    ko: "단일 실행",
                    en: "single-phase",
                    ja: "シングルフェーズ",
                    zh: "single-phase",
                    de: "Einzelphase",
                  })}
            </span>
          </div>
        </div>
        {isMultiPhase && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded border px-2 py-1 text-[10px] transition-opacity hover:opacity-80"
            style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
          >
            {expanded
              ? t({
                  ko: "그래프 숨기기",
                  en: "Hide Graph",
                  ja: "グラフを隠す",
                  zh: "Hide Graph",
                  de: "Graph ausblenden",
                })
              : t({ ko: "그래프 보기", en: "View Graph", ja: "グラフを表示", zh: "View Graph", de: "Graph anzeigen" })}
          </button>
        )}
      </div>
      {expanded && <PhaseGraph phases={pack.phases} />}
    </div>
  );
}

export default function WorkflowPackSettingsTab({ t }: WorkflowPackSettingsTabProps) {
  const [packs, setPacks] = useState<LoadedPackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [reloadMsg, setReloadMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPacks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLoadedPacks();
      setPacks(res.packs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPacks();
  }, [loadPacks]);

  const handleReload = async () => {
    setReloading(true);
    setReloadMsg(null);
    setError(null);
    try {
      const res = await reloadPacks();
      setReloadMsg(
        t({
          ko: `${res.packs.length}개 팩 리로드됨`,
          en: `${res.packs.length} pack(s) reloaded`,
          ja: `${res.packs.length} パック リロード完了`,
          zh: `${res.packs.length} pack(s) reloaded`,
          de: `${res.packs.length} Pack(s) neu geladen`,
        }),
      );
      await loadPacks();
      setTimeout(() => setReloadMsg(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  };

  const builtinPacks = packs.filter((p) => p.source === "builtin");
  const communityPacks = packs.filter((p) => p.source === "community");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({
            ko: "워크플로우 팩 설정",
            en: "Workflow Pack Settings",
            ja: "ワークフロー パック設定",
            zh: "Workflow Pack Settings",
            de: "Workflow-Pack-Einstellungen",
          })}
        </h3>
        <button
          onClick={() => void handleReload()}
          disabled={reloading || loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {reloading
            ? "..."
            : reloadMsg
              ? reloadMsg
              : t({
                  ko: "팩 리로드",
                  en: "Reload Packs",
                  ja: "パックを再読み込み",
                  zh: "Reload Packs",
                  de: "Packs neu laden",
                })}
        </button>
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
          {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
        </p>
      ) : (
        <>
          {/* ── Built-in Packs ── */}
          <section>
            <h4 className="mb-3 text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "내장 팩",
                en: "Built-in Packs",
                ja: "組み込みパック",
                zh: "Built-in Packs",
                de: "Integrierte Packs",
              })}
            </h4>
            {builtinPacks.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "내장 팩 없음",
                  en: "No built-in packs",
                  ja: "組み込みパックなし",
                  zh: "No built-in packs",
                  de: "Keine integrierten Packs",
                })}
              </p>
            ) : (
              <div className="space-y-2">
                {builtinPacks.map((pack) => (
                  <PackCard key={pack.key} pack={pack} t={t} />
                ))}
              </div>
            )}
          </section>

          {/* ── Community Packs ── */}
          <section>
            <h4 className="mb-3 text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "커뮤니티 팩",
                en: "Community Packs",
                ja: "コミュニティ パック",
                zh: "Community Packs",
                de: "Community-Packs",
              })}
            </h4>
            {communityPacks.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "(설치된 커뮤니티 팩 없음)",
                  en: "(none installed)",
                  ja: "(インストール済みなし)",
                  zh: "(none installed)",
                  de: "(keine installiert)",
                })}
              </p>
            ) : (
              <div className="space-y-2">
                {communityPacks.map((pack) => (
                  <PackCard key={pack.key} pack={pack} t={t} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
