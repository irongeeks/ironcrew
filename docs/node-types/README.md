# Node Types

Node types are reusable workflow building blocks that the graph-runner can dispatch automatically. Unlike agent phases (where an LLM agent executes the work), node type phases run server-side TypeScript logic with defined inputs, outputs, and configuration.

## Available Node Types

| Key | Label | Category | Description |
|-----|-------|----------|-------------|
| [`echo`](echo.md) | Echo | Control | Passes inputs through unchanged. Testing and debugging. |
| [`comfyui_generate`](comfyui-generate.md) | ComfyUI Generate | Connector | Generate images, videos, or speech via ComfyUI server. |
| [`planning_meeting`](planning-meeting.md) | Planning Meeting | Collaboration | Produce a structured execution plan with department assignments. |
| [`cross_dept`](cross-dept.md) | Cross-Dept Handoff | Collaboration | Route plan items to target departments with team leader assignment. |

## Categories

- **Collaboration** — Multi-agent orchestration nodes (meetings, handoffs)
- **Connector** — External service integrations (ComfyUI, APIs)
- **Control** — Flow control (gates, conditions, pass-through)
- **Custom** — Community-contributed nodes

## How to Use a Node Type in a Pack

Reference the node type key in a phase definition:

```yaml
phases:
  - id: plan
    department: planning
    guidance: guidance/plan.en.md
    node_type: planning_meeting
    node_config:
      max_items: 6
      require_approval: true
    inputs:
      - name: task_brief
        from: input.description
    outputs:
      - name: plan
        type: json
        path: output/plan/plan.json
      - name: summary
        type: markdown
        path: output/plan/summary.md
      - name: department_ids
        type: json
        path: output/plan/departments.json
```

The graph-runner auto-dispatches node type phases without spawning an agent.

## How to Create a Community Node Type

1. Create `server/node-types/community/<your-key>/index.ts`
2. Export a `NodeTypeDefinition` as the default export
3. Restart the server — the loader auto-discovers it
4. Reference it in any pack.yaml with `node_type: <your-key>`

See the [Echo node](../../../server/node-types/built-in/echo/index.ts) as a minimal template.

## API

```
GET /api/ops/node-types
```

Returns all registered node types with their metadata, config schema, inputs, and outputs. Used by the Graph Editor palette and property panel.

## Architecture

```
pack.yaml (phase with node_type: <key>)
    |
    v
graph-runner.ts
    |-- resolves config (node_config + configSchema defaults)
    |-- resolves inputs (artifact-bridge from upstream phases)
    |-- calls NodeTypeDefinition.execute(ctx)
    |-- persists outputs to declared artifact paths
    |-- updates subtask status (done / awaiting_approval / error)
    |-- notifies messenger channels on awaiting_approval
    v
downstream phases unblocked
```
