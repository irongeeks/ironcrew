import type { NodeTypeDefinition } from "../../node-type-interface.ts";

/**
 * Cross-Department Handoff node — takes a set of plan items (typically from
 * a planning_meeting node) and routes them to the appropriate departments.
 *
 * For each item that targets a different department than the source, it
 * creates a handoff record with the assigned team leader. The output is
 * a structured handoff manifest that downstream phases can consume.
 */
const CrossDeptNode: NodeTypeDefinition = {
  key: "cross_dept",

  meta: {
    label: "Cross-Dept Handoff",
    description: "Route plan items to target departments and assign team leaders for cross-department collaboration.",
    icon: "🔀",
    color: "#f59e0b",
    category: "collaboration",
  },

  configSchema: [
    {
      key: "source_department",
      type: "string",
      label: "Source Department",
      description:
        "Department ID of the originating team. Items targeting this department are not treated as cross-dept.",
      required: false,
    },
    {
      key: "require_approval",
      type: "boolean",
      label: "Require Approval",
      description: "When true, pause after creating handoffs so the user can review assignments before proceeding",
      default: false,
    },
  ],

  inputs: [
    {
      name: "plan",
      type: "json",
      label: "Execution Plan",
      required: true,
      description:
        "Plan object from a planning_meeting node: { items: Array<{ title, description, department_id, is_cross_dept }> }",
    },
  ],

  outputs: [
    {
      name: "handoffs",
      type: "json",
      label: "Handoff Manifest",
      required: true,
      description: "Array of { department_id, department_name, team_leader_id, team_leader_name, items: [...] }",
    },
    {
      name: "summary",
      type: "markdown",
      label: "Handoff Summary",
      required: true,
      description: "Human-readable markdown summary of all cross-department handoffs.",
    },
    {
      name: "handoff_count",
      type: "number",
      label: "Handoff Count",
      required: true,
      description: "Number of departments that received handoffs.",
    },
  ],

  async execute(ctx) {
    const plan = ctx.inputs.plan as { items?: PlanItem[] } | undefined;
    const sourceDeptId = (ctx.config.source_department as string) || null;
    const requireApproval = ctx.config.require_approval as boolean;

    if (!plan?.items || !Array.isArray(plan.items)) {
      return {
        status: "error",
        outputs: {},
        error: "Input 'plan' must contain an 'items' array. Did you connect a planning_meeting node?",
      };
    }

    // Identify cross-department items
    const crossItems = plan.items.filter((item) => item.department_id && item.department_id !== sourceDeptId);

    // Group by target department
    const byDept = new Map<string, PlanItem[]>();
    for (const item of crossItems) {
      const deptId = item.department_id!;
      if (!byDept.has(deptId)) byDept.set(deptId, []);
      byDept.get(deptId)!.push(item);
    }

    // Build handoff manifest
    const handoffs: Handoff[] = [];
    for (const [deptId, items] of byDept) {
      const dept = ctx.db.get("SELECT id, name FROM departments WHERE id = ?", deptId) as
        | { id: string; name: string }
        | undefined;
      const leader = ctx.db.get(
        "SELECT id, name FROM agents WHERE department_id = ? AND role = 'team_leader' LIMIT 1",
        deptId,
      ) as { id: string; name: string } | undefined;

      handoffs.push({
        department_id: deptId,
        department_name: dept?.name ?? deptId,
        team_leader_id: leader?.id ?? null,
        team_leader_name: leader?.name ?? null,
        items: items.map((i) => ({ title: i.title, description: i.description })),
      });
    }

    // Build markdown summary
    const summaryLines = [
      "# Cross-Department Handoffs",
      "",
      `**Source Department:** ${sourceDeptId ?? "not specified"}`,
      `**Departments Receiving Handoffs:** ${handoffs.length}`,
      `**Total Items Routed:** ${crossItems.length}`,
      "",
    ];

    for (const h of handoffs) {
      summaryLines.push(`## ${h.department_name}`);
      summaryLines.push(`**Team Leader:** ${h.team_leader_name ?? "unassigned"}`);
      summaryLines.push("");
      for (const item of h.items) {
        summaryLines.push(`- ${item.title}`);
      }
      summaryLines.push("");
    }

    if (handoffs.length === 0) {
      summaryLines.push("_No cross-department handoffs required — all items stay within the source department._");
    }

    return {
      status: requireApproval ? "awaiting_approval" : "success",
      outputs: {
        handoffs,
        summary: summaryLines.join("\n"),
        handoff_count: handoffs.length,
      },
      summary: `Cross-dept handoff: ${crossItems.length} item(s) → ${handoffs.length} department(s)`,
    };
  },
};

// ── Types ────────────────────────────────────────────────────────────────────

interface PlanItem {
  title: string;
  description: string;
  department_id: string | null;
  is_cross_dept?: boolean;
}

interface Handoff {
  department_id: string;
  department_name: string;
  team_leader_id: string | null;
  team_leader_name: string | null;
  items: Array<{ title: string; description: string }>;
}

export default CrossDeptNode;
