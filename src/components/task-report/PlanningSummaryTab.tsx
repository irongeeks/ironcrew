import type { TaskReportDocument } from "../../api";
import type { UiLanguage } from "../../i18n";
import { pickLang } from "../../i18n";
import ReportDocumentList from "./ReportDocumentList";
import { fmtTime } from "./utils";

interface PlanningSummaryTabProps {
  content: string | null | undefined;
  generatedAt: number | null | undefined;
  documents: TaskReportDocument[];
  uiLanguage: UiLanguage;
  refreshingArchive: boolean;
  onRefreshArchive: () => void;
  expandedDocs: Record<string, boolean>;
  documentPages: Record<string, number>;
  onToggleDoc: (docId: string) => void;
  onSetPage: (scopeKey: string, page: number) => void;
}

export default function PlanningSummaryTab({
  content,
  generatedAt,
  documents,
  uiLanguage,
  refreshingArchive,
  onRefreshArchive,
  expandedDocs,
  documentPages,
  onToggleDoc,
  onSetPage,
}: PlanningSummaryTabProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-emerald-300">
            {t({
              ko: "기획팀장 최종 취합본",
              en: "Planning Lead Consolidated Summary",
              ja: "企画リード統合サマリー",
              zh: "Planning Lead Consolidated Summary",
              de: "Konsolidierte Zusammenfassung (Planungsleitung)",
            })}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefreshArchive}
              disabled={refreshingArchive}
              className={`rounded-md border px-2 py-1 text-[11px] ${
                refreshingArchive
                  ? "cursor-not-allowed border-emerald-500/20 bg-emerald-500/10 text-emerald-300/70"
                  : "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
              }`}
            >
              {refreshingArchive
                ? t({
                    ko: "갱신 중...",
                    en: "Refreshing...",
                    ja: "更新中...",
                    zh: "Refreshing...",
                    de: "Aktualisieren...",
                  })
                : t({
                    ko: "취합 갱신",
                    en: "Refresh Consolidation",
                    ja: "統合更新",
                    zh: "Refresh Consolidation",
                    de: "Konsolidierung aktualisieren",
                  })}
            </button>
            <span className="text-[11px] text-emerald-400">{fmtTime(generatedAt)}</span>
          </div>
        </div>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-emerald-100">
          {content ||
            t({
              ko: "요약 내용이 없습니다",
              en: "No summary text",
              ja: "サマリーなし",
              zh: "No summary text",
              de: "Kein Zusammenfassungstext",
            })}
        </pre>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>
          {t({ ko: "문서 원문", en: "Source Documents", ja: "原本文書", zh: "Source Documents", de: "Quelldokumente" })}
        </p>
        <ReportDocumentList
          documents={documents}
          scopeKey="planning"
          uiLanguage={uiLanguage}
          expandedDocs={expandedDocs}
          documentPages={documentPages}
          onToggleDoc={onToggleDoc}
          onSetPage={onSetPage}
        />
      </div>
    </div>
  );
}
