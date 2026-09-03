import { useEffect, useState } from "react";
import { fetchPackRegistry } from "../../api/workflow-packs";
import type { PackRegistryEntry } from "../../types";

interface WorkflowPackSelectorProps {
  activePackKey: string | null;
  onSelect: (key: string) => void;
}

export function WorkflowPackSelector({ activePackKey, onSelect }: WorkflowPackSelectorProps) {
  const [packs, setPacks] = useState<PackRegistryEntry[]>([]);

  useEffect(() => {
    fetchPackRegistry()
      .then(setPacks)
      .catch(() => {});
  }, []);

  return (
    <select
      value={activePackKey ?? ""}
      onChange={(e) => onSelect(e.target.value)}
      className="rounded-lg border px-3 py-1.5 text-xs font-medium"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--bg-surface-solid)",
        color: "var(--text-primary)",
      }}
    >
      <option value="" disabled>
        Select Workflow Pack...
      </option>
      {packs.map((p) => (
        <option key={p.key} value={p.key}>
          {p.name?.en ?? p.ui?.label?.en ?? p.key} ({p.source})
        </option>
      ))}
    </select>
  );
}
