import { useEffect, useRef, useState } from "react";
import { fetchPackDefinition } from "../../../api/workflow-packs";
import type { PackInputField, PackDefinitionResponse } from "../../pack-editor/types";

interface PackInputsSectionProps {
  packKey: string;
  locale: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onRequiredKeysChange?: (keys: string[]) => void;
}

const inputCls =
  "w-full rounded-lg border px-3 py-2 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};

function fieldLabel(field: PackInputField, locale: string): string {
  return field.label[locale] ?? field.label["en"] ?? field.key;
}

export default function PackInputsSection({
  packKey,
  locale,
  values,
  onChange,
  onRequiredKeysChange,
}: PackInputsSectionProps) {
  const [fields, setFields] = useState<(PackInputField & { _required?: boolean })[]>([]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  });

  const onRequiredKeysChangeRef = useRef(onRequiredKeysChange);
  useEffect(() => {
    onRequiredKeysChangeRef.current = onRequiredKeysChange;
  });

  useEffect(() => {
    if (!packKey) {
      setFields([]);
      onRequiredKeysChangeRef.current?.([]);
      return;
    }
    let stale = false;
    fetchPackDefinition(packKey)
      .then((def) => {
        if (stale) return;
        const data = def as unknown as PackDefinitionResponse;
        const requiredRaw = data.definition?.input?.required ?? [];
        const required = requiredRaw.map((f: PackInputField) => ({ ...f, _required: true }));
        const optional = data.definition?.input?.optional ?? [];
        const all = [...required, ...optional];
        setFields(all);
        onRequiredKeysChangeRef.current?.(requiredRaw.map((f: PackInputField) => f.key));
        // Pre-fill defaults for any field not yet in values
        for (const f of all) {
          if (f.default !== undefined && valuesRef.current[f.key] === undefined) {
            onChangeRef.current(f.key, String(f.default));
          }
        }
      })
      .catch(() => {
        if (!stale) {
          setFields([]);
          onRequiredKeysChangeRef.current?.([]);
        }
      });
    return () => {
      stale = true;
    };
  }, [packKey]);

  if (fields.length === 0) return null;

  const sectionLabel =
    locale === "ko"
      ? "팩 설정"
      : locale === "ja"
        ? "パック設定"
        : locale === "zh"
          ? "包设置"
          : locale === "de"
            ? "Pack-Einstellungen"
            : "Pack Settings";

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
        {sectionLabel}
      </label>
      {fields.map((field) => (
        <div key={field.key}>
          <label className="mb-1 block text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
            {fieldLabel(field, locale)}
            {(field as PackInputField & { _required?: boolean })._required ? " *" : ""}
          </label>
          {field.enum ? (
            <select
              value={values[field.key] ?? String(field.default ?? "")}
              onChange={(e) => onChange(field.key, e.target.value)}
              required={!!field._required}
              className={inputCls}
              style={inputStyle}
            >
              {field.enum.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[field.key] ?? String(field.default ?? "")}
              onChange={(e) => onChange(field.key, e.target.value)}
              required={!!field._required}
              className={inputCls}
              style={inputStyle}
            />
          )}
        </div>
      ))}
    </div>
  );
}
