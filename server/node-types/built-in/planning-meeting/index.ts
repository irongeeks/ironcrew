import type { NodeTypeDefinition } from "../../node-type-interface.ts";

/**
 * Planning Meeting node — takes a task brief / description and the notes
 * from a planning discussion, then produces a structured execution plan
 * with action items and department assignments.
 *
 * This node replaces the hardcoded planning-meeting logic with a
 * declarative, reusable workflow step that any pack can include.
 *
 * The node reads agent and department data from the database to produce
 * realistic assignments. When no planning notes are provided, it creates
 * a single "finalize plan" action item from the task description.
 */
const PlanningMeetingNode: NodeTypeDefinition = {
  key: "planning_meeting",

  meta: {
    label: "Planning Meeting",
    description:
      "Analyze a task brief and produce a structured execution plan with action items and department assignments.",
    icon: "🗣️",
    color: "#a78bfa",
    category: "collaboration",
  },

  configSchema: [
    {
      key: "max_items",
      type: "number",
      label: "Max Action Items",
      description: "Maximum number of action items to extract from planning notes (default: 8)",
      default: 8,
      min: 1,
      max: 20,
    },
    {
      key: "require_approval",
      type: "boolean",
      label: "Require Approval",
      description: "When true, the node returns awaiting_approval so the user can review the plan before proceeding",
      default: false,
    },
  ],

  inputs: [
    {
      name: "task_brief",
      type: "string",
      label: "Task Brief",
      required: true,
      description: "The task title and/or description to plan around.",
    },
    {
      name: "planning_notes",
      type: "json",
      label: "Planning Notes",
      required: false,
      description: "Array of planning discussion notes (strings). If empty, a default plan is created from the brief.",
    },
    {
      name: "department_scope",
      type: "string",
      label: "Department Scope",
      required: false,
      description: "Department ID to scope the plan to. If omitted, cross-department items are detected automatically.",
    },
  ],

  outputs: [
    {
      name: "plan",
      type: "json",
      label: "Execution Plan",
      required: true,
      description:
        "Structured plan: { items: Array<{ title, description, department_id, assigned_agent_id, is_cross_dept }> }",
    },
    {
      name: "summary",
      type: "markdown",
      label: "Plan Summary",
      required: true,
      description: "Human-readable markdown summary of the plan.",
    },
    {
      name: "department_ids",
      type: "json",
      label: "Involved Departments",
      required: true,
      description: "Array of unique department IDs involved in the plan.",
    },
  ],

  async execute(ctx) {
    const taskBrief = (ctx.inputs.task_brief as string) || "";
    const rawNotes = ctx.inputs.planning_notes;
    const notes: string[] = Array.isArray(rawNotes) ? rawNotes.map(String) : [];
    const scopeDeptId = (ctx.inputs.department_scope as string) || null;
    const maxItems = (ctx.config.max_items as number) || 8;
    const requireApproval = ctx.config.require_approval as boolean;

    // Load departments from DB for cross-department detection
    const departments = ctx.db.all("SELECT id, name FROM departments") as Array<{
      id: string;
      name: string;
    }>;
    const deptMap = new Map(departments.map((d) => [d.id, d.name]));
    const deptKeywords = buildDeptKeywords(departments);

    // Deduplicate and cap notes
    const uniqueNotes: string[] = [];
    const seen = new Set<string>();
    for (const note of notes) {
      const normalized = note.replace(/\s+/g, " ").trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueNotes.push(normalized);
      if (uniqueNotes.length >= maxItems) break;
    }

    // Build action items
    const items: PlanItem[] = [];
    const involvedDepts = new Set<string>();

    if (uniqueNotes.length === 0) {
      // No planning notes — create a single item from the brief
      items.push({
        title: `Finalize execution plan for: ${taskBrief.slice(0, 60)}`,
        description: `Create a detailed execution plan based on: ${taskBrief}`,
        department_id: scopeDeptId,
        assigned_agent_id: null,
        is_cross_dept: false,
      });
      if (scopeDeptId) involvedDepts.add(scopeDeptId);
    } else {
      for (const note of uniqueNotes) {
        const detail = note.replace(/^[\s\-*0-9.)]+/, "").trim();
        if (!detail) continue;

        const detectedDeptId = detectDepartment(detail, deptKeywords, scopeDeptId);
        const isCrossDept = detectedDeptId !== null && detectedDeptId !== scopeDeptId;

        // Find a team leader for the target department
        let assignedAgentId: string | null = null;
        if (detectedDeptId) {
          const leader = ctx.db.get(
            "SELECT id FROM agents WHERE department_id = ? AND role = 'team_leader' LIMIT 1",
            detectedDeptId,
          ) as { id: string } | undefined;
          assignedAgentId = leader?.id ?? null;
          involvedDepts.add(detectedDeptId);
        }
        if (scopeDeptId) involvedDepts.add(scopeDeptId);

        const titleCore = detail.slice(0, 56).trim();
        items.push({
          title: titleCore.length > 54 ? `${titleCore.slice(0, 53).trimEnd()}…` : titleCore,
          description: detail,
          department_id: detectedDeptId ?? scopeDeptId,
          assigned_agent_id: assignedAgentId,
          is_cross_dept: isCrossDept,
        });
      }
    }

    const deptIds = [...involvedDepts];
    const crossDeptCount = items.filter((i) => i.is_cross_dept).length;

    // Build markdown summary
    const summaryLines = [
      `# Planning Meeting Output`,
      "",
      `**Task:** ${taskBrief.slice(0, 120)}`,
      `**Action Items:** ${items.length}`,
      `**Cross-Department Items:** ${crossDeptCount}`,
      `**Departments Involved:** ${deptIds.map((id) => deptMap.get(id) ?? id).join(", ") || "none"}`,
      "",
      "## Action Items",
      "",
    ];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const deptLabel = item.department_id ? (deptMap.get(item.department_id) ?? item.department_id) : "unassigned";
      summaryLines.push(`${i + 1}. **${item.title}** _(${deptLabel})_${item.is_cross_dept ? " 🔀" : ""}`);
    }

    const plan = { items };
    const summaryMd = summaryLines.join("\n");

    return {
      status: requireApproval ? "awaiting_approval" : "success",
      outputs: {
        plan,
        summary: summaryMd,
        department_ids: deptIds,
      },
      summary: `Planning meeting: ${items.length} action item(s), ${crossDeptCount} cross-dept`,
    };
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PlanItem {
  title: string;
  description: string;
  department_id: string | null;
  assigned_agent_id: string | null;
  is_cross_dept: boolean;
}

type DeptKeyword = { id: string; keywords: string[] };

function buildDeptKeywords(departments: Array<{ id: string; name: string }>): DeptKeyword[] {
  return departments.map((d) => ({
    id: d.id,
    keywords: [
      d.id.toLowerCase(),
      d.name.toLowerCase(),
      // Common aliases
      ...(d.id === "dev" || d.name.toLowerCase().includes("develop") ? ["code", "implement", "build", "engineer"] : []),
      ...(d.id === "design" || d.name.toLowerCase().includes("design")
        ? ["ui", "ux", "visual", "mockup", "figma"]
        : []),
      ...(d.id === "qa" || d.name.toLowerCase().includes("qa") ? ["test", "quality", "review", "bug"] : []),
      ...(d.id === "ops" || d.name.toLowerCase().includes("ops") ? ["deploy", "infra", "ci", "pipeline"] : []),
      ...(d.id === "docs" || d.name.toLowerCase().includes("knowledge") ? ["document", "wiki", "docs"] : []),
    ],
  }));
}

function detectDepartment(text: string, deptKeywords: DeptKeyword[], scopeDeptId: string | null): string | null {
  const lower = text.toLowerCase();
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const dk of deptKeywords) {
    let score = 0;
    for (const kw of dk.keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = dk.id;
    }
  }

  return bestScore > 0 ? bestMatch : scopeDeptId;
}

export default PlanningMeetingNode;
