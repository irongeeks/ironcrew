# Directive vs. New Task — Detaillierter Ablaufvergleich

## Gesamtübersicht

```
                    USER INPUT
                   /          \
                  /            \
     "$" in Chat Panel     "New Task" Button
           |                      |
           v                      v
   ┌──────────────┐      ┌───────────────┐
   │  DIRECTIVE    │      │  CREATE TASK  │
   │  FLOW         │      │  MODAL FLOW   │
   └──────┬───────┘      └───────┬───────┘
          |                      |
          v                      v
   directives-inbox-     POST /api/tasks
   routes.ts:462            crud.ts:247
          |                      |
          v                      v
   Status: "planned"     Status: "inbox"
   Agent: Team Leader    Agent: keiner
          |                      |
          v                      |
   ┌──────────────┐              |
   │  PLANNING    │              |
   │  MEETING     │              |
   │ (optional)   │              |
   └──────┬───────┘              |
          |                      |
          v                      |
   Subtasks aus                  |
   Meeting-Notes                 |
          |                      |
          v                      v
   Auto-Execution         User klickt "Run"
   (kein Klick)           POST /api/tasks/:id/run
          |                      |
          └──────────┬───────────┘
                     |
                     v
            ┌────────────────┐
            │  SHARED PATH:  │
            │  execution-    │
            │  run.ts        │
            └────────┬───────┘
                     |
                     v
            Graph-Runner Pipeline
            (seed → run → complete → next phase → ...)
                     |
                     v
            Review Meeting → done
```

---

## Detailfluss: DIRECTIVE (`$`)

```
User tippt: "$ Erstelle eine Landing Page für TeleCalm"
     |
     v
┌─────────────────────────────────────────────────────────┐
│ POST /api/inbox  ODER  POST /api/directives             │
│ directives-inbox-routes.ts                              │
│                                                         │
│  :462  raw.startsWith("$") → isDirective = true         │
│  :463  content = raw.slice(1).trimStart()                │
│  :606  INSERT INTO messages (type="directive")           │
│  :775  broadcast("announcement", msg)                    │
│  :778  scheduleAnnouncementReplies(content)              │
│         → Team Leaders antworten async (1-2s delay)      │
│  :779  analyzeDirectivePolicy(content)                   │
│         → { skipPlannedMeeting: false, ... }             │
│  :781  shouldExecuteDirectiveDelegation() → true         │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ handleTaskDelegation()                                  │
│ task-delegation.ts:125                                  │
│                                                         │
│  :143  resolveWorkflowPackKeyForTask()                   │
│         → Pack aus Projekt-Default oder "development"    │
│  :156  taskId = randomUUID()                             │
│  :177  INSERT INTO tasks (status = "planned")            │
│         ❌ KEIN agent_routing Feld gesetzt               │
│         ❌ KEIN user-gewähltes Pack (auto-resolved)      │
│  :402  Agent-Zuweisung:                                  │
│         Team Leader → delegiert an Subordinate           │
│         UPDATE tasks SET assigned_agent_id = ...         │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ PLANNING MEETING (optional)                             │
│ planned-approval.ts:72                                  │
│                                                         │
│  :196  callLeadersToCeoOffice()                          │
│         → Leaders laufen zum CEO Office (Pixi.js)        │
│  :216  Opening Phase: Planning Leader präsentiert Task    │
│  :235  Feedback Phase: Andere Leader geben Input          │
│  :259  Summary Phase: Konsens                             │
│  :278  Action Items: Leader schlagen Subtasks vor         │
│  :332  onApproved(planItems) callback                     │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ SUBTASK SEEDING (aus Meeting)                           │
│ subtask-seeding.ts:94                                   │
│                                                         │
│  :145  Erstellt: "Finalize execution plan"               │
│  :171  Für jeden Planning-Note: INSERT subtask           │
│         (status=pending oder blocked wenn cross-dept)    │
│                                                         │
│  ⚠️  Diese Subtasks sind ZUSÄTZLICH zu den Pipeline-    │
│      Phasen die der Graph-Runner später seeded!          │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
              AUTOMATISCHER EXECUTION START
              (kein User-Klick nötig!)
              task-delegation.ts:477
                          |
                          v
                  ┌───────────────┐
                  │ SHARED PATH   │
                  │ (siehe unten) │
                  └───────────────┘
```

---

## Detailfluss: NEW TASK (UI)

```
User klickt "New Task" Button
     |
     v
┌─────────────────────────────────────────────────────────┐
│ CreateTaskModal.tsx                                      │
│                                                         │
│  User füllt aus:                                         │
│   - Title, Description                                   │
│   - Workflow Pack (dropdown)         ← User wählt!       │
│   - Agent Routing Toggle             ← NEU! single/dept  │
│   - Project Path                                         │
│   - Agent (optional)                                     │
│   - Priority, Department                                 │
│   - Pack Inputs, Skipped Phases                          │
│                                                         │
│  submitTaskWithProjectHandling()                         │
│  submit-task.ts:407-422                                  │
│   → onCreate({ title, ..., agent_routing, ... })         │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ POST /api/tasks                                         │
│ crud.ts:247                                             │
│                                                         │
│  :248  Parse CreateTaskSchema (inkl. agent_routing)      │
│  :264  Auto-Workspace falls Pack default_workspace hat   │
│  :328  resolveWorkflowPackKeyForTask()                   │
│         → User-gewähltes Pack hat Vorrang!               │
│  :309  INSERT INTO tasks                                 │
│         status = "inbox"                                 │
│         workflow_pack_key = user-selected                 │
│         agent_routing = user-selected   ← NEU!           │
│  :368  broadcast("task_update")                          │
│                                                         │
│  ❌ KEIN Planning Meeting                                │
│  ❌ KEIN Auto-Start                                      │
│  ❌ KEIN Agent zugewiesen                                │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
              Task erscheint im TaskBoard
              Status: "inbox", kein Agent
                          |
                          v
              User klickt "▶ Run" Button
                          |
                          v
                  ┌───────────────┐
                  │ SHARED PATH   │
                  │ (siehe unten) │
                  └───────────────┘
```

---

## SHARED PATH: Execution → Pipeline → Completion

```
POST /api/tasks/:id/run
execution-run.ts:114
     |
     v
┌─────────────────────────────────────────────────────────┐
│ PRE-FLIGHT                                              │
│                                                         │
│  :116  Fetch task from DB                                │
│  :151  Status-Check: in_progress → reset to pending      │
│  :161  activeProcesses / taskLaunchLocks guard            │
│  :174  Agent vorhanden?                                  │
│         Nein → selectAutoAssignableAgentForTask()         │
│         :188  Pick idle agent by dept priority            │
│  :205  Status: inbox → planned                           │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ GRAPH-RUNNER SEEDING (erster Run)                       │
│                                                         │
│  :589  Pack in packRegistry?                             │
│  :597  Pipeline-Subtasks existieren schon?               │
│         Nein → graphRunner.seedSubtasks()    :611        │
│         Erstellt: [pipeline:analysis]     = pending      │
│                   [pipeline:planning]     = blocked      │
│                   [pipeline:implementation] = blocked     │
│                   [pipeline:review]        = blocked      │
│  :619  graphRunner.dispatchAutoPhases()                   │
│         (für node_type Phasen ohne Agent)                │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ PHASE PROMPT BUILDING                                   │
│                                                         │
│  :695  GUARD: Phase awaiting_approval? → 409 reject      │
│  :709  Finde erste pending Phase → mark in_progress      │
│  :717  graphRunner.buildPhasePrompt(pack, phaseId, lang) │
│         → Guidance aus guidance/analysis.en.md            │
│  :719  pipelinePhaseHint = "[Current Pipeline Phase]..." │
│                                                         │
│  :463  Department Constraints:                           │
│         ┌─────────────────────────────────────────┐      │
│         │ if agent_routing === "single":           │      │
│         │   deptConstraint = ""     ← SUPPRESSED   │      │
│         │   departmentPrompt = ""   ← SUPPRESSED   │      │
│         │ else (department mode):                   │      │
│         │   deptConstraint = getDeptRoleConstraint()│      │
│         │   departmentPrompt = dept.prompt           │      │
│         └─────────────────────────────────────────┘      │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ PROMPT ASSEMBLY                                         │
│  :750  buildTaskExecutionPrompt([                        │
│           Available Skills,                              │
│           Task Session,                                  │
│           Project Structure,                             │
│           Obsidian Docs,                                 │
│           Recent Changes,                                │
│           Dept Pipeline Instruction,                     │
│           [Task] title + description,                    │
│           Related Task Context,                          │
│           SSH / MCP Tools,                               │
│           *** Pipeline Phase Hint ***  ← Phase Guidance  │
│           Continuation / Conversation Context,           │
│           Agent Identity + Personality,                  │
│           *** Dept Constraint ***      ← ggf. suppressed │
│           *** Dept Shared Prompt ***   ← ggf. suppressed │
│           Worktree Notice,                               │
│           Run Instruction,                               │
│         ])                                               │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ AGENT SPAWN                                             │
│                                                         │
│  :817  Status → in_progress                              │
│  :920  spawnCliAgent() / launchApiProviderAgent()        │
│         → Agent arbeitet in isoliertem Git Worktree      │
│         → onClose: handleTaskRunComplete(id, exitCode)   │
└─────────────────────────┬───────────────────────────────┘
                          |
                          v
              Agent arbeitet... (Claude CLI etc.)
                          |
                          v
┌─────────────────────────────────────────────────────────┐
│ RUN COMPLETE                                            │
│ run-complete-handler.ts:176                             │
│                                                         │
│  Exit Code 0 (Erfolg):                                   │
│  :320  Find completed phase subtask (in_progress)        │
│  :332  Mark subtask "done"                               │
│  :345  graphRunner.onPhaseComplete()                     │
│         → Prüft Gates, Dependencies, Fan-out              │
│         → Returns { taskDone, nextPhases }                │
│                                                         │
│  taskDone?                                               │
│  ├── true  → handleSuccessPath() → Status: "review"      │
│  │           → Review Consensus Meeting                   │
│  │           → done                                       │
│  │                                                       │
│  └── false, nextPhases > 0:                               │
│       │                                                   │
│       ▼                                                   │
│  ┌────────────────────────────────────────────┐          │
│  │ AGENT ROUTING CHECK                        │          │
│  │                                            │          │
│  │ resolveAgentRouting(task, packRegistry)     │          │
│  │                                            │          │
│  │ "department" mode:                          │          │
│  │   nextPhase.department → targetDept         │          │
│  │   currentAgent.dept !== targetDept?          │          │
│  │     → selectAgentForDepartment(targetDept)  │          │
│  │     → UPDATE tasks SET assigned_agent_id    │          │
│  │     → Log: "Phase routing: analysis →       │          │
│  │             planning, agent → Kurt (dev)"   │          │
│  │                                            │          │
│  │ "single" mode:                              │          │
│  │   → Agent bleibt gleich                     │          │
│  │   → Kein Department-Wechsel                 │          │
│  └────────────────────────────────────────────┘          │
│       │                                                   │
│       ▼                                                   │
│  Status → "planned"                                       │
│  triggerTaskReRun() (2.5s delay)                          │
│  → POST /api/tasks/:id/run   ← LOOP zurück nach oben     │
└─────────────────────────────────────────────────────────┘
```

---

## Phasen-Zyklus (Department Mode)

```
Phase 1: analysis          Phase 2: planning         Phase 3: implementation    Phase 4: review
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Dept: planning   │      │ Dept: planning   │      │ Dept: dev        │      │ Dept: qa         │
│ Agent: Greta     │─────▶│ Agent: Greta     │─────▶│ Agent: Kurt      │─────▶│ Agent: Nele      │
│ (Planning)       │      │ (Planning)       │      │ (Dev)            │      │ (QA)             │
│                  │      │                  │      │                  │      │                  │
│ Gate:            │      │ Gate: auto       │      │ Gate: auto       │      │ Gate: auto       │
│ user_approval    │      │                  │      │                  │      │                  │
│                  │      │ Output:          │      │ Output:          │      │ Output:          │
│ Output:          │      │  plan.md         │      │  SOURCE CODE!    │      │  review_result   │
│  requirements.md │      │  task_breakdown  │      │  summary.md      │      │  review_flags    │
│  scope.json      │      │                  │      │  changes.md      │      │                  │
└──────────────────┘      └──────────────────┘      └──────────────────┘      └──────────────────┘
         │                         │                         │                         │
    User Approve              auto-advance              auto-advance              → review meeting
                                                                                  → done
```

## Phasen-Zyklus (Single Mode)

```
Phase 1: analysis          Phase 2: planning         Phase 3: implementation    Phase 4: review
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Agent: Greta     │      │ Agent: Greta     │      │ Agent: Greta     │      │ Agent: Greta     │
│ (Planning)       │─────▶│ (Planning)       │─────▶│ (Planning)       │─────▶│ (Planning)       │
│                  │      │                  │      │                  │      │                  │
│ ❌ Keine Dept-   │      │ ❌ Keine Dept-   │      │ ❌ Keine Dept-   │      │ ❌ Keine Dept-   │
│    Constraints   │      │    Constraints   │      │    Constraints   │      │    Constraints   │
│                  │      │                  │      │                  │      │                  │
│ ✅ Phase-Guidance│      │ ✅ Phase-Guidance│      │ ✅ Phase-Guidance│      │ ✅ Phase-Guidance│
│    steuert alles │      │    steuert alles │      │    steuert alles │      │    steuert alles │
└──────────────────┘      └──────────────────┘      └──────────────────┘      └──────────────────┘
    Gleicher Agent durchgehend — keine Dept-Constraints, nur Phase-Guidance
```

---

## Wo divergieren die Flows?

| Code-Stelle | Directive | New Task |
|-------------|-----------|----------|
| `directives-inbox-routes.ts:462` | Einstiegspunkt | - |
| `CreateTaskModal.tsx` | - | Einstiegspunkt |
| `task-delegation.ts:125` | Task + Agent + Meeting | - |
| `crud.ts:247` | - | Task erstellen (inbox) |
| `planned-approval.ts:72` | Planning Meeting | - |
| `subtask-seeding.ts:94` | Extra Subtasks aus Meeting | - |
| **execution-run.ts:114** | **GEMEINSAM** | **GEMEINSAM** |
| **graph-runner.ts** | **GEMEINSAM** | **GEMEINSAM** |
| **run-complete-handler.ts** | **GEMEINSAM** | **GEMEINSAM** |
