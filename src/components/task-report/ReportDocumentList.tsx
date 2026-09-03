import type { TaskReportDocument } from "../../api";
import type { UiLanguage } from "../../i18n";
import { pickLang } from "../../i18n";

const DOCUMENTS_PER_PAGE = 3;

interface ReportDocumentListProps {
  documents: TaskReportDocument[];
  scopeKey: string;
  uiLanguage: UiLanguage;
  expandedDocs: Record<string, boolean>;
  documentPages: Record<string, number>;
  onToggleDoc: (docId: string) => void;
  onSetPage: (scopeKey: string, page: number) => void;
}

export default function ReportDocumentList({
  documents,
  scopeKey,
  uiLanguage,
  expandedDocs,
  documentPages,
  onToggleDoc,
  onSetPage,
}: ReportDocumentListProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);

  if (!documents.length) {
    return (
      <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
        {t({
          ko: "문서가 없습니다",
          en: "No documents",
          ja: "ドキュメントなし",
          zh: "No documents",
          de: "Keine Dokumente",
        })}
      </p>
    );
  }

  const totalPages = Math.max(1, Math.ceil(documents.length / DOCUMENTS_PER_PAGE));
  const rawPage = documentPages[scopeKey] ?? 1;
  const currentPage = Math.min(Math.max(rawPage, 1), totalPages);
  const start = (currentPage - 1) * DOCUMENTS_PER_PAGE;
  const visibleDocs = documents.slice(start, start + DOCUMENTS_PER_PAGE);

  return (
    <div className="space-y-2">
      {visibleDocs.map((doc) => {
        const isExpanded = expandedDocs[doc.id] !== false;
        return (
          <div
            key={doc.id}
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {doc.title}
                </p>
                <p className="truncate text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {doc.source}
                  {doc.path ? ` · ${doc.path}` : ""}
                </p>
              </div>
              <button
                onClick={() => onToggleDoc(doc.id)}
                className="rounded-md border px-2 py-1 text-[11px]"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
              >
                {isExpanded
                  ? t({ ko: "접기", en: "Collapse", ja: "折りたたむ", zh: "Collapse", de: "Einklappen" })
                  : t({ ko: "확장", en: "Expand", ja: "展開", zh: "Expand", de: "Ausklappen" })}
              </button>
            </div>
            <pre
              className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[11px] leading-relaxed"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {isExpanded ? doc.content : doc.text_preview}
            </pre>
          </div>
        );
      })}
      {totalPages > 1 && (
        <div
          className="mt-1 flex items-center justify-between rounded-lg border px-3 py-2"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <button
            type="button"
            onClick={() => onSetPage(scopeKey, Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className={`rounded-md px-2 py-1 text-[11px] ${
              currentPage <= 1 ? "cursor-not-allowed opacity-40" : "hover:opacity-80"
            }`}
          >
            {t({ ko: "이전", en: "Prev", ja: "前へ", zh: "Prev", de: "Zurück" })}
          </button>
          <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: `페이지 ${currentPage}/${totalPages}`,
              en: `Page ${currentPage}/${totalPages}`,
              ja: `ページ ${currentPage}/${totalPages}`,
              zh: `Page ${currentPage}/${totalPages}`,
              de: `Seite ${currentPage}/${totalPages}`,
            })}
          </span>
          <button
            type="button"
            onClick={() => onSetPage(scopeKey, Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            className={`rounded-md px-2 py-1 text-[11px] ${
              currentPage >= totalPages ? "cursor-not-allowed opacity-40" : "hover:opacity-80"
            }`}
          >
            {t({ ko: "다음", en: "Next", ja: "次へ", zh: "Next", de: "Weiter" })}
          </button>
        </div>
      )}
    </div>
  );
}
