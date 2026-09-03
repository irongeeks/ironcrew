import { useState, useCallback } from "react";
import { createPack } from "../../api/workflow-packs";

interface CreatePackDialogProps {
  onCreated: (key: string) => void;
  onClose: () => void;
}

export function CreatePackDialog({ onCreated, onClose }: CreatePackDialogProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const keyError =
    key && !/^[a-z][a-z0-9_]{0,63}$/.test(key) ? "Only lowercase letters, digits, underscores (max 64 chars)" : null;

  const handleCreate = useCallback(async () => {
    if (!key || !name || keyError) return;
    setCreating(true);
    setError(null);
    try {
      const definition = {
        pack: {
          key,
          schema_version: 1,
          name: { en: name },
          version: "1.0.0",
          description: { en: description || name },
        },
        input: { required: [], optional: [] },
        phases: [
          {
            id: "main",
            department: "dev",
            guidance: "guidance/main.{lang}.md",
            inputs: [],
            outputs: [{ name: "result", type: "markdown", path: `${key}_output/result.md` }],
          },
        ],
      };
      await createPack(definition);
      onCreated(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [key, name, description, keyError, onCreated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Create New Pack"
      onKeyDown={handleKeyDown}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border p-6"
        style={{ background: "var(--bg-surface-solid)", borderColor: "var(--border-strong)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Create New Pack
        </h3>

        <div className="flex flex-col gap-3">
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              Pack Key
            </label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="e.g. my_workflow"
              maxLength={64}
              className="w-full rounded border px-3 py-2 font-mono text-sm"
              style={{
                background: "var(--bg-base)",
                borderColor: keyError ? "#ef4444" : "var(--border)",
                color: "var(--text-primary)",
              }}
              autoFocus
            />
            {keyError && <div className="mt-1 text-[10px] text-red-400">{keyError}</div>}
          </div>

          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Custom Workflow"
              className="w-full rounded border px-3 py-2 text-sm"
              style={{ background: "var(--bg-base)", borderColor: "var(--border)", color: "var(--text-primary)" }}
            />
          </div>

          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this workflow do?"
              rows={2}
              className="w-full resize-y rounded border px-3 py-2 text-sm"
              style={{ background: "var(--bg-base)", borderColor: "var(--border)", color: "var(--text-primary)" }}
            />
          </div>

          {error && (
            <div className="rounded px-3 py-2 text-xs" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
              {error}
            </div>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border px-4 py-2 text-sm"
              style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !key || !name || !!keyError}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {creating ? "Creating..." : "Create Pack"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
