# Node Type System — Execution Flows

This document describes the complete lifecycle of a node type phase from pack definition to completion notification.

## Entry Points

Node type phases are triggered through the same entry points as any pack workflow:

| Entry Point | Description |
|------------|-------------|
| **Dashboard "Run"** | User clicks Run on a task — `seedSubtasks()` + `dispatchAutoPhases()` |
| **`$` Directive** | CEO broadcast creates a task and runs it |
| **Autonomous Scheduler** | Background scheduler picks up pending tasks |
| **API** | `POST /api/core/tasks/:id/run` |

All paths converge at the graph-runner, which is the single execution engine.

## Execution Flow

```
1. Task created with workflow_pack_key
   |
2. seedSubtasks(db, taskId, pack, taskInput)
   |-- Creates [pipeline:<phaseId>] subtasks for each phase
   |-- All subtasks start as "pending"
   |
3. dispatchAutoPhases(db, taskId, pack, rootDir)
   |-- Loop: find unblocked phases where all upstream deps are "done"
   |
   |-- Phase has node_type? ──YES──> executeNodeTypePhase()
   |                                  |
   |                                  |-- Look up NodeTypeDefinition from registry
   |                                  |-- Mark subtask "in_progress"
   |                                  |-- Resolve config: schema defaults + node_config
   |                                  |-- Resolve inputs: artifact-bridge + pack inputs
   |                                  |-- Call nodeDef.execute(ctx)
   |                                  |-- Persist outputs to declared paths
   |                                  |-- Status handling:
   |                                  |     success → mark "done", advance downstream
   |                                  |     awaiting_approval → mark "awaiting_approval",
   |                                  |       persist outputs, notify Telegram
   |                                  |     error → mark "pending" for agent fallback
   |                                  |
   |-- Phase has capability_mode: server? ──YES──> executeConnectorPhase()
   |                                                (legacy connector dispatch)
   |
   |-- Otherwise ──> leave as "pending" for agent spawn
   |
4. _onPhaseComplete(taskId, phaseId)
   |-- Recursively check downstream phases
   |-- Auto-dispatch any newly unblocked node_type phases
   |-- If all terminal phases done → taskDone = true
```

## Input Resolution

Node type inputs support all `from:` reference forms:

| Form | Example | Resolution |
|------|---------|------------|
| Direct | `from: planning.plan` | Read artifact file at the output path |
| Pack input | `from: input.description` | Read from task metadata |
| Nested pack input | `from: input.meta.depth` | Dot-path traversal into task metadata |
| Wildcard | `from: crawl.result[{n}]` | Fan-out indexed artifacts |

JSON outputs are automatically parsed into structured data before passing to `ctx.inputs`.

## Output Persistence

For both `success` and `awaiting_approval` results, outputs are written to disk:

```typescript
for (const outputDef of phase.outputs) {
  const value = result.outputs[outputDef.name];
  // String values written as-is, objects JSON-serialized
  await writeFile(absPath, content, "utf-8");
}
```

This ensures the Decision Panel can display plan/handoff data even before the user approves.

## Feedback Loop

### Dashboard Notifications

The `NotificationToast` component listens to WebSocket events:

| Event | Trigger | Toast Type |
|-------|---------|------------|
| `task_update` status=`review` | Task ready for review | Warning |
| `task_update` status=`done` | Task completed | Success |
| `task_update` status=`failed` | Task failed | Error |
| `subtask_update` status=`awaiting_approval` | Phase needs approval | Warning |

### Telegram Phase Approval

When a node type phase enters `awaiting_approval`:

1. **Outbound**: `notifyPhaseApprovalNeeded()` sends a formatted message to all configured messenger channels:
   ```
   ⏸ [Approval Needed] Task Title
   Phase: planning
   Summary: Planning meeting: 4 action items, 1 cross-dept
   Reply "approve planning" to approve.
   ```

2. **Inbound**: The phase approval bridge (`phase-approval-bridge.ts`) catches replies:
   - `approve <phaseId>` — approve for the only matching task
   - `approve <taskId>/<phaseId>` — disambiguate when multiple tasks have the same phase
   - Delegates to `POST /api/core/tasks/:taskId/phases/:phaseId/approve` for correct graph advancement

3. **Acknowledgment**: Sends confirmation back to the messenger channel:
   ```
   ✅ Phase "planning" approved for "Build landing page".
   ```

## Phase Approval (UI + Messenger)

Both UI clicks and Telegram replies converge at the same endpoint:

```
POST /api/core/tasks/:taskId/phases/:phaseId/approve
```

This endpoint:
1. Finds the `[pipeline:<phaseId>]` subtask with status `awaiting_approval`
2. Marks it as `done` with `completed_at` timestamp
3. Broadcasts `subtask_update` via WebSocket
4. Triggers `_onPhaseComplete()` to advance downstream phases

## Node Type Registry

```
server/node-types/
├── built-in/
│   ├── echo/index.ts           — pass-through (control)
│   ├── comfyui-generate/       — media generation (connector)
│   ├── planning-meeting/       — plan generation (collaboration)
│   └── cross-dept/             — department routing (collaboration)
├── community/                  — user-created nodes (override built-in by key)
├── node-type-interface.ts      — TypeScript interfaces
├── node-type-registry.ts       — register/get/list
└── node-type-loader.ts         — auto-scan built-in/ and community/ at startup
```

The loader runs at server startup (`server-main.ts`). Community nodes with the same key as a built-in override the built-in.
