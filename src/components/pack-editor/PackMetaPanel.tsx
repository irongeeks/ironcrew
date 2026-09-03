import { useState } from "react";
import type { PackEditorState } from "./hooks/usePackEditorState";
import type { PackInputField } from "./types";

interface CostProfile {
  max_rounds?: number;
  default_reasoning?: "low" | "medium" | "high";
}

interface QaRules {
  require_test_evidence?: boolean;
  max_auto_fix_passes?: number;
  review_chain?: string[];
}

interface StaffEntry {
  name: string;
  role?: string;
  department?: string;
}

interface StaffConfig {
  name_pool?: StaffEntry[];
  departments?: Array<{ name: string; role?: string }>;
  room_themes?: Array<{ name: string; theme?: string }>;
}

interface PackMetaPanelProps {
  state: PackEditorState;
  readOnly: boolean;
  onUpdate: (updates: Partial<Pick<PackEditorState, "packMeta" | "costProfile" | "qaRules" | "input">>) => void;
  onClose: () => void;
}

type Tab = "general" | "inputs" | "cost" | "staff";

const inputStyle = (readOnly: boolean): React.CSSProperties => ({
  background: readOnly ? "var(--bg-base)" : "var(--bg-surface-solid)",
  borderColor: "var(--border)",
  color: "var(--text-primary)",
});

interface InputFieldRowProps {
  field: PackInputField;
  onChange: (updated: PackInputField) => void;
  onRemove: () => void;
  inputStyle: React.CSSProperties;
}

function InputFieldRow({ field, onChange, onRemove, inputStyle: style }: InputFieldRowProps) {
  return (
    <div className="flex flex-col gap-1 rounded border p-2" style={{ borderColor: "var(--border)" }}>
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-[10px]"
          style={style}
          placeholder="key"
          value={field.key}
          onChange={(e) => onChange({ ...field, key: e.target.value.replace(/\s+/g, "_") })}
        />
        <select
          className="rounded border px-1 py-0.5 text-[10px]"
          style={style}
          value={field.type}
          onChange={(e) => onChange({ ...field, type: e.target.value as PackInputField["type"] })}
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
        </select>
        <button
          onClick={onRemove}
          className="rounded px-1.5 text-[10px] hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
        >
          ✕
        </button>
      </div>
      <input
        className="w-full rounded border px-1.5 py-0.5 text-[10px]"
        style={style}
        placeholder="label (EN)"
        value={field.label?.en ?? ""}
        onChange={(e) => onChange({ ...field, label: { ...field.label, en: e.target.value } })}
      />
      <input
        className="w-full rounded border px-1.5 py-0.5 text-[10px]"
        style={style}
        placeholder="default value"
        value={field.default !== undefined ? String(field.default) : ""}
        onChange={(e) => {
          const val = e.target.value;
          onChange({ ...field, default: val === "" ? undefined : val });
        }}
      />
      {field.type === "string" && (
        <input
          className="w-full rounded border px-1.5 py-0.5 text-[10px]"
          style={style}
          placeholder="enum values (comma-separated)"
          value={field.enum?.join(", ") ?? ""}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const enums = raw
              ? raw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined;
            onChange({ ...field, enum: enums });
          }}
        />
      )}
    </div>
  );
}

export function PackMetaPanel({ state, readOnly, onUpdate, onClose }: PackMetaPanelProps) {
  const [tab, setTab] = useState<Tab>("general");

  const style = inputStyle(readOnly);

  return (
    <div
      className="flex h-full w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l"
      style={{ background: "var(--bg-surface-solid)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Pack Settings
        </span>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b" style={{ borderColor: "var(--border)" }}>
        {(["general", "inputs", "cost", "staff"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 px-2 py-1.5 text-[10px] font-medium capitalize"
            style={{
              background: tab === t ? "var(--accent-dim)" : "transparent",
              color: tab === t ? "var(--accent)" : "var(--text-muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 p-3">
        {tab === "general" && (
          <>
            <Field label="Pack Key">
              <input
                value={state.packMeta.key}
                disabled
                className="w-full rounded border px-2 py-1 font-mono text-xs"
                style={{ background: "var(--bg-base)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
              />
            </Field>
            <Field label="Name (EN)">
              <input
                value={state.packMeta.name.en ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  onUpdate({ packMeta: { ...state.packMeta, name: { ...state.packMeta.name, en: e.target.value } } })
                }
                className="w-full rounded border px-2 py-1 text-xs"
                style={style}
              />
            </Field>
            <Field label="Version">
              <input
                value={state.packMeta.version}
                disabled={readOnly}
                onChange={(e) => onUpdate({ packMeta: { ...state.packMeta, version: e.target.value } })}
                className="w-full rounded border px-2 py-1 text-xs"
                style={style}
              />
            </Field>
            <Field label="Description (EN)">
              <textarea
                value={state.packMeta.description.en ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  onUpdate({
                    packMeta: {
                      ...state.packMeta,
                      description: { ...state.packMeta.description, en: e.target.value },
                    },
                  })
                }
                className="w-full resize-y rounded border px-2 py-1 text-xs"
                style={style}
                rows={3}
              />
            </Field>
            <Field label="Icon">
              <input
                value={state.packMeta.icon ?? ""}
                disabled={readOnly}
                onChange={(e) => onUpdate({ packMeta: { ...state.packMeta, icon: e.target.value || undefined } })}
                placeholder="e.g. 🔬"
                className="w-full rounded border px-2 py-1 text-xs"
                style={style}
              />
            </Field>
          </>
        )}

        {tab === "inputs" && (
          <>
            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              Required and optional input fields for this pack. These define what users provide when creating a task.
            </div>

            {/* Required inputs */}
            <div
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-secondary)" }}
            >
              Required ({state.input.required.length})
            </div>
            {state.input.required.map((f, i) =>
              readOnly ? (
                <div
                  key={f.key || `req-${i}`}
                  className="mb-1 rounded px-2 py-1 font-mono text-[10px]"
                  style={{ background: "var(--bg-surface-hover)", color: "var(--text-secondary)" }}
                >
                  {f.key} ({f.type}) — {f.label?.en ?? ""}
                </div>
              ) : (
                <InputFieldRow
                  key={f.key || `req-${i}`}
                  field={f}
                  onChange={(updated) => {
                    const next = state.input.required.map((x, idx) => (idx === i ? updated : x));
                    onUpdate({ input: { ...state.input, required: next } });
                  }}
                  onRemove={() => {
                    onUpdate({
                      input: { ...state.input, required: state.input.required.filter((_, idx) => idx !== i) },
                    });
                  }}
                  inputStyle={style}
                />
              ),
            )}
            {!readOnly && (
              <button
                onClick={() =>
                  onUpdate({
                    input: {
                      ...state.input,
                      required: [...state.input.required, { key: "", type: "string", label: { en: "" } }],
                    },
                  })
                }
                className="w-full rounded border border-dashed py-1 text-[10px] hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              >
                + Add Required
              </button>
            )}
            {state.input.required.length === 0 && readOnly && (
              <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                No required inputs
              </div>
            )}

            {/* Optional inputs */}
            <div
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-secondary)" }}
            >
              Optional ({state.input.optional.length})
            </div>
            {state.input.optional.map((f, i) =>
              readOnly ? (
                <div
                  key={f.key || `opt-${i}`}
                  className="mb-1 rounded px-2 py-1 font-mono text-[10px]"
                  style={{ background: "var(--bg-surface-hover)", color: "var(--text-secondary)" }}
                >
                  {f.key} ({f.type}){f.default !== undefined ? ` = ${String(f.default)}` : ""}
                  {f.enum ? ` [${f.enum.join(", ")}]` : ""} — {f.label?.en ?? ""}
                </div>
              ) : (
                <InputFieldRow
                  key={f.key || `opt-${i}`}
                  field={f}
                  onChange={(updated) => {
                    const next = state.input.optional.map((x, idx) => (idx === i ? updated : x));
                    onUpdate({ input: { ...state.input, optional: next } });
                  }}
                  onRemove={() => {
                    onUpdate({
                      input: { ...state.input, optional: state.input.optional.filter((_, idx) => idx !== i) },
                    });
                  }}
                  inputStyle={style}
                />
              ),
            )}
            {!readOnly && (
              <button
                onClick={() =>
                  onUpdate({
                    input: {
                      ...state.input,
                      optional: [...state.input.optional, { key: "", type: "string", label: { en: "" } }],
                    },
                  })
                }
                className="w-full rounded border border-dashed py-1 text-[10px] hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              >
                + Add Optional
              </button>
            )}
            {state.input.optional.length === 0 && readOnly && (
              <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                No optional inputs
              </div>
            )}
          </>
        )}

        {tab === "cost" &&
          (() => {
            const cost = (state.costProfile ?? {}) as CostProfile;
            const qa = (state.qaRules ?? {}) as QaRules;
            return (
              <>
                <Field label="Max Rounds">
                  <input
                    type="number"
                    min={1}
                    value={cost.max_rounds ?? 5}
                    disabled={readOnly}
                    onChange={(e) =>
                      onUpdate({
                        costProfile: {
                          ...cost,
                          max_rounds: parseInt(e.target.value) || 5,
                        },
                      })
                    }
                    className="w-full rounded border px-2 py-1 text-xs"
                    style={style}
                  />
                </Field>
                <Field label="Default Reasoning">
                  <select
                    value={cost.default_reasoning ?? "medium"}
                    disabled={readOnly}
                    onChange={(e) =>
                      onUpdate({
                        costProfile: {
                          ...cost,
                          default_reasoning: e.target.value as CostProfile["default_reasoning"],
                        },
                      })
                    }
                    className="w-full rounded border px-2 py-1 text-xs"
                    style={style}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
                <Field label="Require Test Evidence">
                  <select
                    value={String(qa.require_test_evidence ?? false)}
                    disabled={readOnly}
                    onChange={(e) =>
                      onUpdate({
                        qaRules: {
                          ...qa,
                          require_test_evidence: e.target.value === "true",
                        },
                      })
                    }
                    className="w-full rounded border px-2 py-1 text-xs"
                    style={style}
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </Field>
                <Field label="Max Auto-Fix Passes">
                  <input
                    type="number"
                    min={1}
                    value={qa.max_auto_fix_passes ?? 2}
                    disabled={readOnly}
                    onChange={(e) =>
                      onUpdate({
                        qaRules: {
                          ...qa,
                          max_auto_fix_passes: parseInt(e.target.value) || 2,
                        },
                      })
                    }
                    className="w-full rounded border px-2 py-1 text-xs"
                    style={style}
                  />
                </Field>
              </>
            );
          })()}

        {tab === "staff" &&
          (() => {
            const staff = state.staff as StaffConfig | undefined;
            const namePool = staff && Array.isArray(staff.name_pool) ? staff.name_pool : [];
            return (
              <>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  Agent name pool and room theme. These define the agents and visual appearance for this pack.
                </div>
                {staff ? (
                  <Field label="Name Pool">
                    {namePool.map((s, i) => (
                      <div
                        key={i}
                        className="mb-1 rounded px-2 py-1 text-[10px]"
                        style={{ background: "var(--bg-surface-hover)", color: "var(--text-secondary)" }}
                      >
                        <span className="font-medium">{s.name}</span>
                        <span style={{ color: "var(--text-muted)" }}>
                          {" "}
                          — {s.role ?? ""} / {s.department ?? ""}
                        </span>
                      </div>
                    ))}
                    {namePool.length === 0 && (
                      <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                        No agents in name pool
                      </div>
                    )}
                  </Field>
                ) : (
                  <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                    No staff configuration
                  </div>
                )}
              </>
            );
          })()}

        {readOnly && (
          <div
            className="mt-2 rounded px-3 py-2 text-center text-[10px]"
            style={{ background: "var(--bg-surface-hover)", color: "var(--text-muted)" }}
          >
            Read-only mode
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span
        className="mb-1 block text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
