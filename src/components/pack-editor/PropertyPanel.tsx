import { useCallback, useEffect, useState } from "react";
import type { PhaseDefinition, NodeConfigField } from "./types";
import { GuidanceEditor } from "./panels/GuidanceEditor";
import {
  fetchEditorCapabilities,
  fetchEditorDepartments,
  fetchNodeTypes,
  type CapabilityInfo,
  type DepartmentInfo,
  type NodeTypeInfoResponse as NodeTypeInfo,
} from "../../api/workflow-packs";

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const selectStyle = (readOnly: boolean) => ({
  background: readOnly ? "var(--bg-base)" : "var(--bg-surface-solid)",
  borderColor: "var(--border)",
  color: "var(--text-primary)",
});

interface PropertyPanelProps {
  packKey: string;
  phase: PhaseDefinition;
  readOnly: boolean;
  onUpdate: (phaseId: string, updates: Partial<PhaseDefinition>) => void;
  onClose: () => void;
}

export function PropertyPanel({ packKey, phase, readOnly, onUpdate, onClose }: PropertyPanelProps) {
  const update = useCallback((updates: Partial<PhaseDefinition>) => onUpdate(phase.id, updates), [phase.id, onUpdate]);

  // Fetch available options for dropdowns
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeInfo[]>([]);

  useEffect(() => {
    fetchEditorCapabilities().then(setCapabilities);
    fetchEditorDepartments().then(setDepartments);
    fetchNodeTypes().then(setNodeTypes);
  }, []);

  const activeNodeType = phase.node_type ? nodeTypes.find((nt) => nt.key === phase.node_type) : undefined;

  return (
    <div
      className="flex h-full w-[300px] flex-shrink-0 flex-col overflow-y-auto border-l"
      style={{ background: "var(--bg-surface-solid)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {humanize(phase.id)}
        </span>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {/* Phase ID */}
        <Field label="Phase ID">
          <input
            value={phase.id}
            disabled
            className="w-full rounded border px-2 py-1 font-mono text-xs"
            style={{ background: "var(--bg-base)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
          />
        </Field>

        {/* Department — Dropdown */}
        <Field label="Department">
          <select
            value={phase.department}
            disabled={readOnly}
            onChange={(e) => update({ department: e.target.value })}
            className="w-full rounded border px-2 py-1 text-xs"
            style={selectStyle(readOnly)}
          >
            {departments.length > 0 ? (
              <>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                {/* Keep current value visible if not in fetched list */}
                {phase.department && !departments.some((d) => d.id === phase.department) && (
                  <option value={phase.department}>{phase.department}</option>
                )}
              </>
            ) : (
              <option value={phase.department}>{phase.department}</option>
            )}
          </select>
        </Field>

        {/* Gate */}
        <Field label="Gate">
          <select
            value={phase.gate ?? "auto"}
            disabled={readOnly}
            onChange={(e) => update({ gate: e.target.value as "auto" | "user_approval" })}
            className="w-full rounded border px-2 py-1 text-xs"
            style={selectStyle(readOnly)}
          >
            <option value="auto">Auto</option>
            <option value="user_approval">User Approval</option>
          </select>
        </Field>

        {/* Node Type */}
        <Field label="Node Type">
          <select
            value={phase.node_type ?? ""}
            disabled={readOnly}
            onChange={(e) => {
              const key = e.target.value || undefined;
              const nt = key ? nodeTypes.find((n) => n.key === key) : undefined;
              const phaseId = phase.id;
              const updates: Partial<PhaseDefinition> = {
                node_type: key,
                node_config: nt
                  ? Object.fromEntries(
                      nt.configSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
                    )
                  : undefined,
              };
              if (nt) {
                updates.inputs = nt.inputs.map((inp) => ({ name: inp.name, from: "" }));
                updates.outputs = nt.outputs.map((out) => ({
                  name: out.name,
                  type: out.type,
                  path: `output/${phaseId}/${out.name}.${out.type === "json" ? "json" : "md"}`,
                }));
              }
              update(updates);
            }}
            className="w-full rounded border px-2 py-1 text-xs"
            style={selectStyle(readOnly)}
          >
            <option value="">None (agent-only)</option>
            {nodeTypes.map((nt) => (
              <option key={nt.key} value={nt.key}>
                {nt.meta.icon} {nt.meta.label}
              </option>
            ))}
            {phase.node_type && !nodeTypes.some((nt) => nt.key === phase.node_type) && (
              <option value={phase.node_type}>{phase.node_type}</option>
            )}
          </select>
        </Field>

        {/* Node Config — dynamic fields from configSchema */}
        {activeNodeType && activeNodeType.configSchema.length > 0 && (
          <Field label="Node Configuration">
            <div
              className="flex flex-col gap-2 rounded border p-2"
              style={{ borderColor: "var(--border)", background: "var(--bg-base)" }}
            >
              {activeNodeType.configSchema.map((field) => (
                <NodeConfigFieldEditor
                  key={field.key}
                  field={field}
                  value={phase.node_config?.[field.key]}
                  readOnly={readOnly}
                  onChange={(val) => {
                    update({ node_config: { ...phase.node_config, [field.key]: val } });
                  }}
                />
              ))}
            </div>
          </Field>
        )}

        {/* Capability — Dropdown */}
        <Field label="Capability">
          <select
            value={phase.capability ?? ""}
            disabled={readOnly}
            onChange={(e) => update({ capability: e.target.value || undefined })}
            className="w-full rounded border px-2 py-1 text-xs"
            style={selectStyle(readOnly)}
          >
            <option value="">None (agent-only)</option>
            {capabilities.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.connector})
              </option>
            ))}
            {/* Keep current value if not in list */}
            {phase.capability && !capabilities.some((c) => c.name === phase.capability) && (
              <option value={phase.capability}>{phase.capability}</option>
            )}
          </select>
        </Field>

        {/* Capability Mode */}
        {phase.capability && (
          <Field label="Capability Mode">
            <select
              value={phase.capability_mode ?? "hybrid"}
              disabled={readOnly}
              onChange={(e) => update({ capability_mode: e.target.value as "server" | "agent" | "hybrid" })}
              className="w-full rounded border px-2 py-1 text-xs"
              style={selectStyle(readOnly)}
            >
              <option value="hybrid">Hybrid</option>
              <option value="server">Server</option>
              <option value="agent">Agent</option>
            </select>
          </Field>
        )}

        {/* Skip When */}
        <Field label="Skip When">
          <input
            value={phase.skip_when ?? ""}
            disabled={readOnly}
            onChange={(e) => update({ skip_when: e.target.value || undefined })}
            placeholder="e.g. input.depth == 'quick'"
            className="w-full rounded border px-2 py-1 font-mono text-xs"
            style={selectStyle(readOnly)}
          />
        </Field>

        {/* Fan-out */}
        <Field label="Fan-out Count From">
          <input
            value={phase.fan_out?.count_from ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              update({ fan_out: e.target.value ? { ...phase.fan_out, count_from: e.target.value } : undefined })
            }
            placeholder="e.g. planning.strategy.items.length"
            className="w-full rounded border px-2 py-1 font-mono text-xs"
            style={selectStyle(readOnly)}
          />
        </Field>

        {/* On Review Fail */}
        {/* Note: flag_output is intentionally not exposed in the UI editor; it defaults to empty string. */}
        <Field label="On Review Fail">
          <div className="flex flex-col gap-1">
            <input
              value={phase.on_review_fail?.rerun ?? ""}
              disabled={readOnly}
              onChange={(e) =>
                update({
                  on_review_fail: e.target.value
                    ? {
                        rerun: e.target.value,
                        max_passes: phase.on_review_fail?.max_passes ?? 2,
                        flag_output: phase.on_review_fail?.flag_output ?? "",
                      }
                    : undefined,
                })
              }
              placeholder="Rerun phase ID"
              className="w-full rounded border px-2 py-1 font-mono text-xs"
              style={selectStyle(readOnly)}
            />
            {phase.on_review_fail && (
              <div className="flex gap-1">
                <input
                  type="number"
                  value={phase.on_review_fail.max_passes}
                  disabled={readOnly}
                  onChange={(e) =>
                    update({
                      on_review_fail: { ...phase.on_review_fail!, max_passes: parseInt(e.target.value, 10) || 2 },
                    })
                  }
                  className="w-16 rounded border px-2 py-1 text-xs"
                  style={selectStyle(readOnly)}
                />
                <span className="self-center text-[9px]" style={{ color: "var(--text-muted)" }}>
                  max passes
                </span>
              </div>
            )}
          </div>
        </Field>

        {/* Guidance path */}
        <Field label="Guidance Path">
          <input
            value={phase.guidance}
            disabled={readOnly}
            onChange={(e) => update({ guidance: e.target.value })}
            className="w-full rounded border px-2 py-1 font-mono text-xs"
            style={{ ...selectStyle(readOnly), color: "var(--text-secondary)" }}
          />
        </Field>

        {/* Inputs */}
        <Field label={`Inputs (${phase.inputs.length})`}>
          <div className="flex flex-col gap-1">
            {phase.inputs.map((input, i) => (
              <div
                key={i}
                className="flex items-center gap-1 rounded px-2 py-1"
                style={{ background: "var(--bg-surface-hover)" }}
              >
                {readOnly ? (
                  <>
                    <span className="font-mono text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      {input.name}
                    </span>
                    <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                      ← {input.from}
                    </span>
                  </>
                ) : (
                  <>
                    <input
                      value={input.name}
                      onChange={(e) => {
                        const updated = [...phase.inputs];
                        updated[i] = { ...input, name: e.target.value.replace(/\s+/g, "_") };
                        update({ inputs: updated });
                      }}
                      className="min-w-0 flex-1 rounded border px-1 py-0.5 font-mono text-[10px]"
                      style={selectStyle(false)}
                      placeholder="name"
                    />
                    <input
                      value={input.from}
                      onChange={(e) => {
                        const updated = [...phase.inputs];
                        updated[i] = { ...input, from: e.target.value };
                        update({ inputs: updated });
                      }}
                      className="min-w-0 flex-1 rounded border px-1 py-0.5 font-mono text-[10px]"
                      style={selectStyle(false)}
                      placeholder="phase.output"
                    />
                    <button
                      onClick={() => update({ inputs: phase.inputs.filter((_, idx) => idx !== i) })}
                      className="rounded px-1 text-[10px] hover:opacity-80"
                      style={{ color: "var(--text-muted)" }}
                    >
                      x
                    </button>
                  </>
                )}
              </div>
            ))}
            {!readOnly && (
              <button
                onClick={() => update({ inputs: [...phase.inputs, { name: "new_input", from: "" }] })}
                className="w-full rounded border border-dashed py-1 text-[10px] hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              >
                + Add Input
              </button>
            )}
          </div>
        </Field>

        {/* Outputs */}
        <Field label={`Outputs (${phase.outputs.length})`}>
          <div className="flex flex-col gap-1">
            {phase.outputs.map((output, i) => (
              <div
                key={i}
                className="flex items-center gap-1 rounded px-2 py-1"
                style={{ background: "var(--bg-surface-hover)" }}
              >
                {readOnly ? (
                  <>
                    <span className="font-mono text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      {output.name}
                    </span>
                    <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {output.type}
                    </span>
                  </>
                ) : (
                  <>
                    <input
                      value={output.name}
                      onChange={(e) => {
                        const updated = [...phase.outputs];
                        updated[i] = { ...output, name: e.target.value.replace(/\s+/g, "_") };
                        update({ outputs: updated });
                      }}
                      className="min-w-0 flex-1 rounded border px-1 py-0.5 font-mono text-[10px]"
                      style={selectStyle(false)}
                      placeholder="name"
                    />
                    <select
                      value={output.type}
                      onChange={(e) => {
                        const updated = [...phase.outputs];
                        updated[i] = { ...output, type: e.target.value };
                        update({ outputs: updated });
                      }}
                      className="rounded border px-1 py-0.5 text-[9px]"
                      style={selectStyle(false)}
                    >
                      {["markdown", "json", "image", "video", "audio", "document"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => update({ outputs: phase.outputs.filter((_, idx) => idx !== i) })}
                      className="rounded px-1 text-[10px] hover:opacity-80"
                      style={{ color: "var(--text-muted)" }}
                    >
                      x
                    </button>
                  </>
                )}
              </div>
            ))}
            {!readOnly && (
              <button
                onClick={() =>
                  update({
                    outputs: [
                      ...phase.outputs,
                      { name: "new_output", type: "markdown", path: `output/${phase.id}/new_output.md` },
                    ],
                  })
                }
                className="w-full rounded border border-dashed py-1 text-[10px] hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              >
                + Add Output
              </button>
            )}
          </div>
        </Field>

        {/* Guidance Editor */}
        <Field label="Guidance Prompt">
          <GuidanceEditor packKey={packKey} phaseId={phase.id} readOnly={readOnly} />
        </Field>

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
    <div>
      <label
        className="mb-1 block text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function NodeConfigFieldEditor({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: NodeConfigField;
  value: unknown;
  readOnly: boolean;
  onChange: (val: unknown) => void;
}) {
  const inputStyle = {
    background: readOnly ? "var(--bg-base)" : "var(--bg-surface-solid)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  return (
    <div>
      <label className="mb-0.5 block text-[9px] font-medium" style={{ color: "var(--text-secondary)" }}>
        {field.label}
        {field.required && <span style={{ color: "#ef4444" }}> *</span>}
      </label>
      {field.type === "select" && field.options ? (
        <select
          value={String(value ?? field.default ?? "")}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border px-2 py-1 text-xs"
          style={inputStyle}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : field.type === "boolean" ? (
        <select
          value={String(value ?? field.default ?? false)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === "true")}
          className="w-full rounded border px-2 py-1 text-xs"
          style={inputStyle}
        >
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      ) : field.type === "number" ? (
        <input
          type="number"
          value={value !== undefined ? Number(value) : ((field.default as number) ?? "")}
          disabled={readOnly}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          className="w-full rounded border px-2 py-1 font-mono text-xs"
          style={inputStyle}
        />
      ) : (
        <input
          type="text"
          value={String(value ?? field.default ?? "")}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border px-2 py-1 font-mono text-xs"
          style={inputStyle}
        />
      )}
      <p className="mt-0.5 text-[8px]" style={{ color: "var(--text-muted)" }}>
        {field.description}
      </p>
    </div>
  );
}
