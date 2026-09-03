import { useCallback, useEffect, useState } from "react";
import CronPicker from "./CronPicker";
import type { PackRegistryEntry } from "../../types";
import type { ScheduledTask, ScheduledTaskInput } from "../../api/scheduled-tasks";

interface ScheduleModalProps {
  schedule: ScheduledTask | null; // null = create mode
  packs: PackRegistryEntry[];
  departments: { id: string; name: string }[];
  onSave: (input: ScheduledTaskInput) => Promise<void>;
  onClose: () => void;
}

const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function ScheduleModal({ schedule, packs, departments, onSave, onClose }: ScheduleModalProps) {
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [cron, setCron] = useState(schedule?.cron_expression ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? defaultTz);
  const [packKey, setPackKey] = useState<string>(schedule?.workflow_pack_key ?? "");
  const [projectPath, setProjectPath] = useState(schedule?.project_path ?? "");
  const [deptId, setDeptId] = useState<string>(schedule?.department_id ?? "");
  const [priority, setPriority] = useState(schedule?.priority ?? 5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        cron_expression: cron,
        timezone,
        workflow_pack_key: packKey || null,
        project_path: projectPath.trim() || null,
        department_id: deptId || null,
        priority,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [title, description, cron, timezone, packKey, projectPath, deptId, priority, onSave, onClose]);

  const labelStyle: React.CSSProperties = {
    color: "var(--th-text-secondary)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    marginBottom: 4,
    display: "block",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--th-input-bg)",
    border: "1px solid var(--th-input-border)",
    color: "var(--th-text-primary)",
    borderRadius: 6,
    padding: "6px 10px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    outline: "none",
  };

  return (
    // Backdrop
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
      }}
    >
      {/* Modal card */}
      <div
        style={{
          background: "var(--th-card-bg)",
          border: "1px solid var(--th-card-border)",
          borderRadius: 12,
          width: "100%",
          maxWidth: 520,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 24,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        {/* Header */}
        <h2
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 13,
            color: "var(--th-text-primary)",
            marginBottom: 20,
          }}
        >
          {schedule ? "EDIT SCHEDULE" : "NEW SCHEDULE"}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Title */}
          <div>
            <label style={labelStyle}>Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Daily build & deploy"
              style={inputStyle}
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          {/* Cron Picker */}
          <div>
            <label style={labelStyle}>Schedule</label>
            <CronPicker value={cron} onChange={setCron} timezone={timezone} />
          </div>

          {/* Timezone */}
          <div>
            <label style={labelStyle}>Timezone</label>
            <input type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} style={inputStyle} />
          </div>

          {/* Workflow Pack */}
          <div>
            <label style={labelStyle}>Workflow Pack</label>
            <select
              value={packKey}
              onChange={(e) => setPackKey(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="">-- None --</option>
              {packs.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name.en ?? p.key}
                </option>
              ))}
            </select>
          </div>

          {/* Project Path */}
          <div>
            <label style={labelStyle}>Project Path</label>
            <input
              type="text"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="/path/to/project"
              style={inputStyle}
            />
          </div>

          {/* Department */}
          <div>
            <label style={labelStyle}>Department</label>
            <select
              value={deptId}
              onChange={(e) => setDeptId(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="">-- None --</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          {/* Priority */}
          <div>
            <label style={labelStyle}>Priority (1-10)</label>
            <input
              type="number"
              min={1}
              max={10}
              value={priority}
              onChange={(e) => setPriority(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 5)))}
              style={{ ...inputStyle, width: 80 }}
            />
          </div>

          {/* Error */}
          {error && (
            <div
              style={{
                color: "#ef4444",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                padding: "6px 10px",
                background: "rgba(239,68,68,0.1)",
                borderRadius: 6,
              }}
            >
              {error}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 16px",
                borderRadius: 6,
                border: "1px solid var(--th-card-border)",
                background: "transparent",
                color: "var(--th-text-secondary)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-500"
              style={{
                padding: "6px 16px",
                borderRadius: 6,
                border: "none",
                color: "#fff",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 600,
                cursor: saving ? "wait" : "pointer",
                opacity: saving ? 0.7 : 1,
                transition: "background 120ms, opacity 120ms",
              }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
