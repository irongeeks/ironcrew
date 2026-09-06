import { useCallback, useEffect, useMemo, useState } from "react";
import { getProjectContext, initProjectContext, updateProjectContext } from "../../api/organization-projects";
import { useI18n } from "../../i18n";
import type { ProjectContextSections } from "../../types";

interface Props {
  projectId: string;
  projectName: string;
  projectPath: string;
}

type SectionKey = keyof ProjectContextSections;

const SECTION_KEYS: SectionKey[] = ["overview", "architecture", "conventions", "decisions", "status"];

export default function ProjectContextEditor({ projectId, projectName, projectPath }: Props) {
  const { t } = useI18n();

  const [sections, setSections] = useState<ProjectContextSections>({
    overview: "",
    architecture: "",
    conventions: "",
    decisions: "",
    status: "",
  });
  const [originalSections, setOriginalSections] = useState<ProjectContextSections>({
    overview: "",
    architecture: "",
    conventions: "",
    decisions: "",
    status: "",
  });
  const [charLimits, setCharLimits] = useState<Record<string, number>>({});
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [activeTab, setActiveTab] = useState<SectionKey>("overview");

  const tabLabels: Record<SectionKey, () => string> = useMemo(
    () => ({
      overview: () => t({ en: "Overview", de: "Übersicht" }),
      architecture: () => t({ en: "Architecture", de: "Architektur" }),
      conventions: () => t({ en: "Conventions", de: "Konventionen" }),
      decisions: () => t({ en: "Decisions", de: "Entscheidungen" }),
      status: () => t({ en: "Status", de: "Status" }),
    }),
    [t],
  );

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getProjectContext(projectId);
      setSections(res.sections);
      setOriginalSections(res.sections);
      setCharLimits(res.charLimits);
      setExists(res.exists);
    } catch {
      // context not available
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const hasChanges = useMemo(() => {
    return SECTION_KEYS.some((key) => sections[key] !== originalSections[key]);
  }, [sections, originalSections]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProjectContext(projectId, projectName, sections);
      setOriginalSections({ ...sections });
    } catch {
      // save failed
    } finally {
      setSaving(false);
    }
  };

  const handleInit = async () => {
    // Data-loss guard first: re-analyzing overwrites the entire CLAUDE.md and
    // discards any unsaved edits in the editor. Confirm before proceeding.
    if (exists || hasChanges) {
      const ok = window.confirm(
        t({
          en: "Re-analyze project context? This overwrites the current CLAUDE.md and any unsaved edits in the editor.",
          de: "Projektkontext neu analysieren? Das überschreibt die aktuelle CLAUDE.md und alle nicht gespeicherten Änderungen.",
        }),
      );
      if (!ok) return;
    }
    // Then explicit opt-in for LLM analysis. Default (Cancel) is local static
    // analysis so a stray click cannot leak private repo content to the provider.
    const useLlm = window.confirm(
      t({
        en: "Use AI analysis? Your file tree and selected config files will be sent to the configured API provider. Cancel to use local static analysis only.",
        de: "KI-Analyse verwenden? Dateibaum und ausgewählte Konfigurationsdateien werden an den konfigurierten API-Provider gesendet. Abbrechen nutzt nur lokale statische Analyse.",
      }),
    );
    setInitializing(true);
    try {
      const res = await initProjectContext(projectId, { useLlm });
      setSections(res.sections);
      setOriginalSections(res.sections);
      setExists(true);
    } catch {
      // init failed
    } finally {
      setInitializing(false);
    }
  };

  const handleSectionChange = (key: SectionKey, value: string) => {
    setSections((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div
        className="min-w-0 rounded-xl border p-4"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({ en: "Loading...", de: "Laden..." })}
        </p>
      </div>
    );
  }

  return (
    <div
      className="min-w-0 space-y-3 rounded-xl border p-4"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({ en: "Project Context (CLAUDE.md)", de: "Projektkontext (CLAUDE.md)" })}
        </h4>
        <button
          type="button"
          disabled={initializing}
          onClick={() => void handleInit()}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium transition hover:bg-[var(--th-bg-hover)]"
          style={{ borderColor: "var(--th-accent)", color: "var(--th-accent)" }}
        >
          {initializing
            ? t({ en: "Analyzing...", de: "Analyse läuft..." })
            : exists
              ? t({ en: "Re-analyze", de: "Neu analysieren" })
              : t({ en: "Init from Repo", de: "Aus Repo initialisieren" })}
        </button>
      </div>

      <p className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        {projectPath}
      </p>

      {/* Tabs */}
      <div
        className="flex gap-0.5 overflow-x-auto rounded-lg border p-0.5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
      >
        {SECTION_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition"
            style={
              activeTab === key
                ? { background: "var(--th-card-bg)", color: "var(--th-text-primary)" }
                : { color: "var(--th-text-muted)" }
            }
          >
            {tabLabels[key]()}
          </button>
        ))}
      </div>

      {/* Active section textarea */}
      <div className="space-y-1.5">
        <textarea
          rows={12}
          value={sections[activeTab]}
          onChange={(e) => handleSectionChange(activeTab, e.target.value)}
          className="w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-border)",
            color: "var(--th-text-primary)",
          }}
          placeholder={t({ en: "Enter content for this section...", de: "Inhalt für diesen Abschnitt eingeben..." })}
        />
        <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--th-text-muted)" }}>
          <span>
            {sections[activeTab].length.toLocaleString()}
            {charLimits[activeTab] != null && ` / ${charLimits[activeTab].toLocaleString()}`}
            {" chars"}
          </span>
          {charLimits[activeTab] != null && sections[activeTab].length > charLimits[activeTab] && (
            <span className="text-rose-400">{t({ en: "Over limit", de: "Limit überschritten" })}</span>
          )}
        </div>
      </div>

      {/* Save button */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={!hasChanges || saving}
          onClick={() => void handleSave()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {saving ? t({ en: "Saving...", de: "Speichern..." }) : t({ en: "Save", de: "Speichern" })}
        </button>
      </div>
    </div>
  );
}
