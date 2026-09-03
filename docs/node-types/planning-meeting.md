# Planning Meeting Node

Analyze a task brief and produce a structured execution plan with action items and department assignments.

## When to Use

- Starting a multi-department workflow with an automated planning phase
- Converting planning discussion notes into actionable, department-scoped items
- Generating a plan that the `cross_dept` node can route to departments
- Any workflow where you need a structured plan before agent execution begins

## How It Works

1. Reads departments and team leaders from the database
2. Deduplicates and caps planning notes to `max_items`
3. For each note, detects the target department using keyword matching
4. Assigns the department's team leader to cross-department items
5. Outputs a structured plan, markdown summary, and list of involved departments

When no planning notes are provided, creates a single "finalize plan" item from the task brief.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_items` | number | `8` | Maximum action items to extract (1–20). |
| `require_approval` | boolean | `false` | When `true`, pauses with `awaiting_approval` so the user can review the plan before the workflow continues. Outputs are still persisted for UI display. |

## Inputs

| Port | Type | Required | Description |
|------|------|----------|-------------|
| `task_brief` | string | Yes | The task title and/or description to plan around. |
| `planning_notes` | json | No | Array of planning discussion note strings. |
| `department_scope` | string | No | Department ID to scope to. Cross-dept detection runs relative to this. |

## Outputs

| Port | Type | Description |
|------|------|-------------|
| `plan` | json | `{ items: Array<{ title, description, department_id, assigned_agent_id, is_cross_dept }> }` |
| `summary` | markdown | Human-readable plan summary with department assignments. |
| `department_ids` | json | Array of unique department IDs involved in the plan. |

## Example pack.yaml

```yaml
phases:
  - id: planning
    department: planning
    guidance: guidance/planning.en.md
    node_type: planning_meeting
    node_config:
      max_items: 6
      require_approval: true
    inputs:
      - name: task_brief
        from: input.description
      - name: planning_notes
        from: brainstorm.notes
      - name: department_scope
        from: input.department
    outputs:
      - name: plan
        type: json
        path: output/planning/plan.json
      - name: summary
        type: markdown
        path: output/planning/summary.md
      - name: department_ids
        type: json
        path: output/planning/departments.json

  - id: handoff
    department: planning
    guidance: guidance/handoff.en.md
    node_type: cross_dept
    node_config:
      source_department: planning
    inputs:
      - name: plan
        from: planning.plan
    outputs:
      - name: handoffs
        type: json
        path: output/handoff/manifest.json
```

## Common Issues

- **No departments detected**: The keyword matcher looks for department names and common aliases (e.g. "code"/"implement" for dev, "ui"/"figma" for design). If your department names are non-standard, items fall back to the `department_scope`.
- **Duplicate notes**: Notes are deduplicated by case-insensitive comparison. Identical notes produce only one action item.
- **`require_approval` blocks the workflow**: This is intentional. Approve the phase in the Decision Panel or reply "approve planning" via Telegram.
