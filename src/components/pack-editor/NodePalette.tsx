import { useCallback, useEffect, useState } from "react";
import type { PhaseDefinition } from "./types";
import { fetchNodeTypes, type NodeTypeInfoResponse as NodeTypeInfo } from "../../api/workflow-packs";

interface Template {
  label: string;
  icon: string;
  description: string;
  phase: Omit<PhaseDefinition, "id">;
}

const TEMPLATES: Template[] = [
  {
    label: "Agent Phase",
    icon: "\u{1F916}",
    description: "Standard dev agent phase",
    phase: {
      department: "dev",
      guidance: "",
      inputs: [],
      outputs: [{ name: "result", type: "markdown", path: "" }],
    },
  },
  {
    label: "Planning Phase",
    icon: "\u{1F4CB}",
    description: "Planning department, JSON output",
    phase: {
      department: "planning",
      guidance: "",
      inputs: [],
      outputs: [{ name: "plan", type: "json", path: "" }],
    },
  },
  {
    label: "QA Gate",
    icon: "\u2705",
    description: "User approval gate",
    phase: {
      department: "qa",
      guidance: "",
      gate: "user_approval",
      inputs: [{ name: "artifact", from: "" }],
      outputs: [{ name: "review", type: "json", path: "" }],
    },
  },
  {
    label: "Fan-out Crawler",
    icon: "\u{1F578}",
    description: "Parallel fan-out execution",
    phase: {
      department: "dev",
      guidance: "",
      fan_out: { count_from: "" },
      inputs: [{ name: "targets", from: "" }],
      outputs: [{ name: "result", type: "markdown", path: "" }],
    },
  },
  {
    label: "Blank Phase",
    icon: "\u25CB",
    description: "Empty phase, configure manually",
    phase: {
      department: "dev",
      guidance: "",
      inputs: [],
      outputs: [],
    },
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  collaboration: "Collaboration",
  connector: "Connectors",
  control: "Control",
  custom: "Custom",
};

const CATEGORY_ORDER = ["collaboration", "connector", "control", "custom"];

function generateId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${base}_${Date.now().toString(36).slice(-4)}`;
}

interface NodePaletteProps {
  onAddPhase: (phase: PhaseDefinition) => void;
}

export function NodePalette({ onAddPhase }: NodePaletteProps) {
  const [nodeTypes, setNodeTypes] = useState<NodeTypeInfo[]>([]);

  useEffect(() => {
    fetchNodeTypes().then(setNodeTypes);
  }, []);

  const handleAddTemplate = useCallback(
    (template: Template) => {
      const id = generateId(template.label);
      const phase: PhaseDefinition = {
        ...template.phase,
        id,
        guidance: template.phase.guidance || `guidance/${id}.{lang}.md`,
        outputs: template.phase.outputs.map((o) => ({
          ...o,
          path: o.path || `output/${id}/${o.name}.${o.type === "json" ? "json" : "md"}`,
        })),
      };
      onAddPhase(phase);
    },
    [onAddPhase],
  );

  const handleAddNodeType = useCallback(
    (nt: NodeTypeInfo) => {
      const id = generateId(nt.meta.label);
      const phase: PhaseDefinition = {
        id,
        department: nt.meta.category === "collaboration" ? "planning" : "dev",
        guidance: `guidance/${id}.{lang}.md`,
        node_type: nt.key,
        node_config: Object.fromEntries(
          nt.configSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
        ),
        inputs: nt.inputs.map((inp) => ({ name: inp.name, from: "" })),
        outputs: nt.outputs.map((out) => ({
          name: out.name,
          type: out.type,
          path: `output/${id}/${out.name}.${out.type === "json" ? "json" : "md"}`,
        })),
      };
      onAddPhase(phase);
    },
    [onAddPhase],
  );

  // Group node types by category
  const grouped = new Map<string, NodeTypeInfo[]>();
  for (const nt of nodeTypes) {
    const cat = nt.meta.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(nt);
  }

  return (
    <div
      className="flex w-[200px] flex-col gap-1 rounded-lg border p-2"
      style={{
        background: "var(--bg-surface-solid)",
        borderColor: "var(--border-strong)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        maxHeight: "70vh",
        overflowY: "auto",
      }}
    >
      {/* Standard templates */}
      <span className="mb-0.5 text-[9px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        Templates
      </span>
      {TEMPLATES.map((t) => (
        <PaletteButton
          key={t.label}
          icon={t.icon}
          label={t.label}
          description={t.description}
          onClick={() => handleAddTemplate(t)}
        />
      ))}

      {/* Node types grouped by category */}
      {nodeTypes.length > 0 &&
        CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
          <div key={cat}>
            <span
              className="mb-0.5 mt-2 block text-[9px] font-medium uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {CATEGORY_LABELS[cat] ?? cat}
            </span>
            {grouped.get(cat)!.map((nt) => (
              <PaletteButton
                key={nt.key}
                icon={nt.meta.icon}
                label={nt.meta.label}
                description={nt.meta.description}
                color={nt.meta.color}
                onClick={() => handleAddNodeType(nt)}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function PaletteButton({
  icon,
  label,
  description,
  color,
  onClick,
}: {
  icon: string;
  label: string;
  description: string;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
      style={{ background: "transparent" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-surface-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span className="shrink-0 text-sm leading-none">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium" style={{ color: "var(--text-primary)" }}>
            {label}
          </span>
          {color && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
        </div>
        <div className="truncate text-[8px]" style={{ color: "var(--text-muted)" }}>
          {description}
        </div>
      </div>
    </button>
  );
}
