import { useState, useEffect, useCallback, useRef } from "react";
import { listGuidanceLanguages, fetchGuidance, saveGuidance } from "../../../api/workflow-packs";

interface GuidanceEditorProps {
  packKey: string;
  phaseId: string;
  readOnly: boolean;
}

const SAVE_DEBOUNCE_MS = 1000;

export function GuidanceEditor({ packKey, phaseId, readOnly }: GuidanceEditorProps) {
  const [languages, setLanguages] = useState<string[]>([]);
  const [activeLang, setActiveLang] = useState("en");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load available languages
  useEffect(() => {
    listGuidanceLanguages(packKey, phaseId)
      .then((langs) => {
        setLanguages(langs.length > 0 ? langs : ["en"]);
      })
      .catch(() => setLanguages(["en"]));
  }, [packKey, phaseId]);

  // Load guidance content for active language
  useEffect(() => {
    setLoading(true);
    fetchGuidance(packKey, phaseId, activeLang)
      .then((c) => {
        setContent(c ?? "");
        setDirty(false);
      })
      .catch(() => setContent(""))
      .finally(() => setLoading(false));
  }, [packKey, phaseId, activeLang]);

  // Auto-save with debounce
  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      setDirty(true);
      if (readOnly) return;

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        setSaving(true);
        saveGuidance(packKey, phaseId, activeLang, value).finally(() => {
          setSaving(false);
          setDirty(false);
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [packKey, phaseId, activeLang, readOnly],
  );

  // Cleanup timer on unmount
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const addLanguage = useCallback(() => {
    const lang = prompt("Language code (e.g. ko, ja, zh, de):");
    if (!lang || languages.includes(lang)) return;
    setLanguages((prev) => [...prev, lang].sort());
    setActiveLang(lang);
  }, [languages]);

  return (
    <div className="flex flex-col gap-1">
      {/* Language tabs */}
      <div className="flex items-center gap-1">
        {languages.map((lang) => (
          <button
            key={lang}
            onClick={() => setActiveLang(lang)}
            className="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase"
            style={{
              background: activeLang === lang ? "var(--accent-dim)" : "var(--bg-surface-hover)",
              color: activeLang === lang ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {lang}
            {activeLang === lang && dirty && (
              <span className="ml-0.5" style={{ color: "var(--accent)" }}>
                •
              </span>
            )}
          </button>
        ))}
        {!readOnly && (
          <button
            onClick={addLanguage}
            className="rounded px-1.5 py-0.5 text-[9px]"
            style={{ color: "var(--text-muted)" }}
          >
            +
          </button>
        )}
        {saving && (
          <span className="ml-auto text-[8px]" style={{ color: "var(--text-muted)" }}>
            Saving...
          </span>
        )}
      </div>

      {/* Editor */}
      {loading ? (
        <div className="py-4 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>
          Loading...
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          readOnly={readOnly}
          className="min-h-[120px] w-full resize-y rounded border p-2 font-mono text-[10px] leading-relaxed"
          style={{
            background: readOnly ? "var(--bg-base)" : "var(--bg-surface-solid)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
          placeholder={`# ${phaseId} guidance\n\nWrite the agent prompt for this phase...`}
        />
      )}
    </div>
  );
}
