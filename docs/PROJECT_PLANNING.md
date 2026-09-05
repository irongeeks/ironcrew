# EA project planning

A CEO message classified as a project now creates a real project and an EA planning
task. Select an existing project in the chat to keep its workspace and context.
Planning uses the EA's configured runtime and streams into the ordinary run history.
A filesystem CLI requires an absolute project workspace before it can start; the
MockRuntime provides explicitly labelled deterministic planning fixtures without
external calls.

The runtime returns a versioned JSON plan: goal, scope, non-goals, assumptions,
risks, deliverables, approval points, budget and up to 30 attributed tasks.
The backend rejects malformed output, unknown agents, duplicate keys, missing
dependencies and dependency cycles. Invalid output remains visible as a failed
planning task with run evidence; request a revision to try again.

Planning receives restricted permissions and no granted tools. Sandbox elevation
cannot be consumed by a planning task. The plan itself never grants runtime or tool
permissions; those remain separately governed.

In **Projektpläne**, the owner reviews the concrete plan before approving or
rejecting it. Approval atomically creates canonical child tasks, dependencies and
a monetary hard ceiling. An existing smaller positive monthly project limit stays
binding. An unknown plan budget (0) requires an already configured positive project
hard limit before approval. Separate budgets for company, agent, runtime and task
continue to apply. Model-generated risk labels cannot remove independently detected
sensitive actions: those children remain behind individual approvals.

Nothing is delegated before plan approval. Rejected plans produce no child tasks.
Duplicate approval cannot create a second task tree. The generic board, review and
revision routes cannot bypass an outstanding action approval. Tasks, plan, run
sources and audit survive restart. Finished work also appears in the CEO chat for
acceptance or revision.

Tests: `server/ironcrew/orchestrator/project-plan-workflow.test.ts`, the focused
planning-boundary tests, `src/ironcrew/ProjectPlanningPanel.test.tsx`, and
`tests/e2e/flows/project-planning.spec.ts`.
