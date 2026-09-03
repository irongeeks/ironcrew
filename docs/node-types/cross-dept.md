# Cross-Dept Handoff Node

Route plan items to target departments and assign team leaders for cross-department collaboration.

## When to Use

- After a `planning_meeting` node, to distribute work across departments
- Any workflow where plan items need to be routed to specific teams
- When you need a handoff manifest showing which departments received what

## How It Works

1. Receives a plan with items that have `department_id` fields
2. Filters items where `department_id` differs from `source_department`
3. Groups cross-department items by target department
4. Looks up each department's team leader from the database
5. Outputs a handoff manifest with assignments and a markdown summary

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `source_department` | string | — | Department ID of the originating team. Items targeting this department are not treated as cross-dept handoffs. |
| `require_approval` | boolean | `false` | When `true`, pauses with `awaiting_approval` so the user can review handoff assignments. |

## Inputs

| Port | Type | Required | Description |
|------|------|----------|-------------|
| `plan` | json | Yes | Plan object with `items` array. Each item needs `{ title, description, department_id }`. Typically comes from a `planning_meeting` node. |

## Outputs

| Port | Type | Description |
|------|------|-------------|
| `handoffs` | json | Array of `{ department_id, department_name, team_leader_id, team_leader_name, items: [{ title, description }] }` |
| `summary` | markdown | Human-readable summary of all cross-department handoffs. |
| `handoff_count` | number | Number of departments that received handoffs. |

## Example pack.yaml

```yaml
phases:
  - id: route_work
    department: planning
    guidance: guidance/route.en.md
    node_type: cross_dept
    node_config:
      source_department: dev
      require_approval: true
    inputs:
      - name: plan
        from: planning.plan
    outputs:
      - name: handoffs
        type: json
        path: output/routing/handoffs.json
      - name: summary
        type: markdown
        path: output/routing/summary.md
      - name: handoff_count
        type: number
        path: output/routing/count.txt
```

## Common Issues

- **"Input 'plan' must contain an 'items' array"**: The input must be a JSON object with an `items` property. Check that the upstream phase outputs the correct format.
- **No handoffs created**: All items target the `source_department`, so there is nothing to hand off. This is normal for single-department workflows.
- **Team leader not assigned**: The department has no agent with `role = 'team_leader'`. The handoff is created with `team_leader_id: null`.
