# Workflow Packs Reference

> Complete reference for how each workflow pack orchestrates tasks, agents, meetings, and inter-phase coordination.

---

## Table of Contents

1. [General Workflow Lifecycle](#general-workflow-lifecycle)
2. [Agent Coordination & Communication](#agent-coordination--communication)
3. [Meeting System](#meeting-system)
4. [Video Production Pipeline (video_preprod)](#video-production-pipeline-video_preprod)
5. [Web Research Pipeline (web_research_report)](#web-research-pipeline-web_research_report)
6. [Design Studio (design_studio)](#design-studio-design_studio)
7. [Development Pack (development)](#development-pack-development)

---

## General Workflow Lifecycle

Every task — regardless of pack — follows this core lifecycle:

```
inbox → planned → in_progress → review → done
                      ↑            │
                      └── revision ┘
```

### Task Creation

1. **User creates a task** via the UI or API (`POST /api/tasks`).
2. The task enters `inbox` or `planned` status depending on context.
3. No agent is assigned yet; no subtasks exist.

### Task Execution (`POST /api/tasks/:id/run`)

1. **Agent resolution** — the system checks if an agent is already assigned. If not, `selectAutoAssignableAgentForTask()` picks one based on:
   - Pack-specific department priority ordering (e.g., video prefers `design` → `planning` → `dev`)
   - Agent availability (`idle` status preferred)
   - CLI provider and model compatibility
2. **Pipeline seeding** — on first execution, multi-phase packs seed their subtasks (see per-pack sections below). This only happens once per task (idempotency check).
3. **Phase routing** — for multi-phase packs, the system checks the current pipeline phase and reassigns the agent to the correct department if needed via `selectAgentForDepartment()`.
4. **Worktree creation** — for code-based tasks, an isolated git worktree is created.
5. **Guidance injection** — `buildWorkflowPackExecutionGuidance()` assembles pack-specific rules, phase prompts, artifact context, and language-appropriate instructions (EN/KO/JA/ZH).
6. **Agent spawn** — the agent is launched via its CLI provider (`spawnCliAgent`), API provider (`launchApiProviderAgent`), or HTTP provider (`launchHttpAgent`).
7. Task status becomes `in_progress`.

### Run Completion (`handleTaskRunComplete`)

When the agent process exits, the run-complete handler chain executes:

1. **Process cleanup** — remove from active processes, stop progress timer, release server allocations.
2. **Log capture** — last 2000 chars of output stored in `tasks.result`.
3. **Exit code 0 (success):**
   - Auto-complete own-department subtasks (pipeline subtasks excluded — handled by phase logic).
   - Delegate foreign-department subtasks via `processSubtaskDelegations()`.
   - Sync docs back to Knowledge vault if applicable.
   - Run phase advancement logic (pack-specific, see below).
   - If no more phases pending → set status to `review` → trigger review meeting.
   - If more phases pending → set status to `planned` → auto-trigger next phase run.
4. **Exit code != 0 (failure):**
   - **QA bounce** — if a QA step fails, bounce back to the previous dev step (max 2 bounces).
   - **Auto-retry** — if configured in `workflow_meta_json.auto_retry`, reassign to a different agent and re-run.
   - **Hard failure** — set status to `failed`, notify CEO.
5. **Agent cleanup** — set agent to `idle`, broadcast status update.

### Review & Approval

After the final phase succeeds, a **review consensus meeting** is convened (see [Meeting System](#meeting-system)). Outcomes:

| Decision | Effect |
|----------|--------|
| **Approved** | Task status → `done`, completion recorded |
| **Revision requested** | Task status → `planned`, revision memo attached, task re-runs |

---

## Agent Coordination & Communication

### Message Types

Agents communicate through several channels:

| Type | Description | Trigger |
|------|-------------|---------|
| `chat` | Direct conversation between agents | Manual or automated |
| `task_assign` | Task delegation notification | Agent assignment |
| `announcement` | Company-wide broadcast | CEO directive |
| `directive` | CEO directive (`$` prefix) | User input |
| `report` | Task completion report | Task done |
| `status_update` | Agent status change | State transition |

All messages are persisted to the `messages` table and broadcast via WebSocket (`new_message` event) for real-time UI updates.

### CEO Directives (`$` prefix)

1. User sends a message starting with `$`.
2. System creates an announcement and schedules a team leader meeting.
3. Planning team leader convenes the meeting, proposes a plan.
4. Smart routing delegates to the best-fit agent.
5. Execution begins.

### Task Board Posting (`#` prefix)

1. User sends a message starting with `#`.
2. Task is posted to the board in `inbox` status.
3. System prompts for project path if missing.
4. Appropriate agent is selected and execution begins.

### Cross-Department Cooperation

When a task requires work from multiple departments:

1. Agent creates subtasks targeting foreign departments.
2. `processSubtaskDelegations()` creates child tasks owned by the target department.
3. `CrossDeptDelivery` events track handoffs (from → to agent, baton label).
4. The original task waits until all delegated subtasks complete.

### Real-Time Status (WebSocket)

The frontend stays synchronized via WebSocket events:

| Event | Content | Batching |
|-------|---------|----------|
| `task_update` | Task status/details | Immediate |
| `agent_status` | Agent state change | Immediate |
| `cli_output` | CLI process output | 250ms batch |
| `subtask_update` | Subtask progress | 150ms batch |
| `ceo_office_call` | Meeting presence | Immediate |
| `new_message` | Agent/CEO message | Immediate |
| `cross_dept_delivery` | Department handoff | Immediate |

---

## Meeting System

### When Meetings Happen

Meetings are triggered at specific workflow points:

1. **Planned approval meeting** — after a CEO directive when `skipPlannedMeeting` is false. The Planning team leader leads a discussion to create an action plan.
2. **Review consensus meeting** — when a task enters `review` status (after final phase completion). Team leaders evaluate the work and decide to approve or request revisions.

Multi-phase packs (video, research) defer the review meeting until all phases are complete. Individual phase transitions do NOT trigger meetings.

### Meeting Venue

All meetings take place in the **CEO Office** in the pixel-art office view. Up to 6 team leaders can sit at once (seats 0–5).

### Meeting Flow (Review Consensus)

```
1. callLeadersToCeoOffice()
   └─ Broadcast ceo_office_call events
   └─ Leaders transition from departments to CEO office

2. Leader Selection
   └─ getTaskReviewLeaders(taskId, departmentId)
   └─ Planning leader = primary reviewer
   └─ Related department leaders = secondary reviewers

3. Meeting Phases
   ├─ Opening: Planning leader presents task summary
   ├─ Feedback: Other leaders provide critique
   └─ Summary: Consensus building

4. Decision
   ├─ Approved → task status = 'done'
   └─ Revision → task status = 'planned', revision memo attached

5. dismissLeadersFromCeoOffice()
   └─ Leaders return to their departments
```

### Meeting Parameters

| Parameter | Value |
|-----------|-------|
| Max review rounds | 3 (configurable via `REVIEW_MAX_ROUNDS`) |
| Meeting timeout | 65 seconds per one-shot (with retry) |
| Planned approval hold | 90 seconds |
| Review consensus hold | 600 seconds (10 minutes) |
| Max revision signals per round | Configurable |
| Max revision signals per dept per round | Configurable |

### Meeting Speech

During meetings, agents emit speech via `emitMeetingSpeech()`:
- Speech is broadcast to the CEO office UI.
- Summarized to 96 characters for the speech bubble.
- Decision classification: `"approved"`, `"hold"`, or `"reviewing"`.
- Rendered as animated speech bubbles in the Pixi.js office view.

### Meeting Records

All meetings are persisted:
- `meeting_minutes` table — meeting metadata (type, round, status, timestamps).
- `meeting_minute_entries` table — individual speaker turns with content and message type.
- Revision items extracted via `collectRevisionMemoItems()` and attached to the task.

---

## Video Production Pipeline (`video_preprod`)

### Overview

A 7-phase sequential pipeline that produces short-form video content using ComfyUI for image/video generation and ffmpeg for final assembly.

### Phase Sequence

```
concept → screenplay → image_generation → image_review → video_generation → voice_prep → assembly
   │          │              │                 │               │                │            │
planning   planning         dev               qa             dev           planning        dev
```

### Pipeline Seeding

On first execution, `seedVideoPipelineSubtasks()` creates 7 subtasks:

| # | Phase | Department | Initial Status |
|---|-------|------------|----------------|
| 1 | `concept` | planning | `pending` |
| 2 | `screenplay` | planning | `blocked` |
| 3 | `image_generation` | dev | `blocked` |
| 4 | `image_review` | qa | `blocked` |
| 5 | `video_generation` | dev | `blocked` |
| 6 | `voice_prep` | planning | `blocked` |
| 7 | `assembly` | dev | `blocked` |

Only the first phase (`concept`) starts as `pending`. All others are `blocked` until the preceding phase completes.

### Phase-by-Phase Workflow

#### Phase 1: Concept (Planning)

**Agent:** Planning department (e.g., Vision)
**Input:** Task description/topic
**Output:** Concept pitch with character descriptions

The agent:
1. Analyzes the topic and target platform.
2. Creates a concept pitch with characters, visual style, and narrative arc.
3. Defines prompt-ready character descriptions that will be reused verbatim across all shots.

**Completion → unblocks Phase 2.**

#### Phase 2: Screenplay & Storyboard (Planning)

**Agent:** Planning department (e.g., Script)
**Input:** Concept pitch from Phase 1
**Output:** Shot list as JSON with ComfyUI prompts

The agent:
1. Creates a structured shot list (JSON) with per-scene details.
2. Each shot includes:
   - **Positive prompt** (4-part structure): Subject (with character name), Setting, Artistic Style, Lighting.
   - **Motion prompt** (LTX I2V): describes ONLY motion/action, not static elements.
   - Timing and transition information.
3. Scene count is informed by `workflow_meta_json.scene_count` if set.

**Completion → unblocks Phase 3.**

#### Phase 3: Image Generation (Dev)

**Agent:** Dev department (e.g., Pixel)
**Input:** Shot list from Phase 2
**Output:** Images at `video_output/images/shot_XX.png`

The agent:
1. Executes ComfyUI `text2img` workflows for each shot.
2. Uses the ComfyUI connector: `submitWorkflow()` → `pollJobCompletion()` → `downloadOutput()`.
3. Workflow JSON templates are injected with per-shot parameters via `injectParameters()`.
4. In **regeneration mode** (triggered by `workflow_meta_json.image_regen_shots`), only flagged shots are regenerated.

**Completion → unblocks Phase 4.**

#### Phase 4: Image Review (QA)

**Agent:** QA department (e.g., Lens)
**Input:** Generated images from Phase 3
**Output:** Review notes; optionally flags shots for regeneration

The agent:
1. Reviews each image for quality, consistency, and adherence to the shot list.
2. Checks character consistency across shots.
3. If issues found: writes `review_notes.json` with flagged shot indices.
4. If regeneration needed: the run-complete handler resets `image_generation` to `pending` and `image_review` to `blocked`, incrementing the regeneration cycle.

**If regen needed → loops back to Phase 3.**
**If approved → unblocks Phase 5.**

#### Phase 5: Video Generation (Dev)

**Agent:** Dev department (e.g., Clip)
**Input:** Approved images (artifact-bridged via `bridgeImagesForVideoGeneration()`)
**Output:** Clips at `video_output/clips/shot_XX.mp4`

The agent:
1. Executes ComfyUI `img2video` workflows for each approved image.
2. Uses LTX I2V motion prompts from the screenplay.
3. Image paths are injected into the subtask description by the artifact bridge.

**Completion → unblocks Phase 6.**

#### Phase 6: Voice Prep (Planning)

**Agent:** Planning department
**Input:** Screenplay and timing data
**Output:** Voiceover script with timecodes

The agent:
1. Creates a voiceover script aligned to the shot timing.
2. Adds timecodes for synchronization.
3. TTS execution is currently a stub (`tts-stub-connector.ts`) — the actual TTS service is TBD.

**Completion → unblocks Phase 7.**

#### Phase 7: Assembly (Dev)

**Agent:** Dev department (e.g., Clip)
**Input:** Video clips (artifact-bridged via `bridgeClipsForAssembly()`) + voiceover script
**Output:** `video_output/final.mp4`

The agent:
1. Concatenates all clips using ffmpeg.
2. Target format: 720x1280 portrait.
3. Overlays voiceover if available.
4. Final output at `video_output/final.mp4`.

**Completion → task enters `review` → review consensus meeting.**

### Phase Transitions

```
Phase N agent completes (exit code 0)
  ↓
handleVideoPhaseAdvancement()
  ├─ Check review_notes.json for regen flags
  │   ├─ Regen needed → reset Phase 3 to pending, Phase 4 to blocked
  │   └─ No regen → continue
  ├─ Mark current phase subtask as 'done'
  ├─ advancePipelinePhase() → unblock next phase
  ├─ If more phases pending:
  │   └─ Set task status = 'planned' → triggerTaskReRun()
  │      → Agent for next department selected → next phase executes
  └─ If all phases done:
      └─ Set task status = 'review' → start review meeting
```

### Agent Reassignment Between Phases

Each phase maps to a department. When the pipeline advances:
1. `getCurrentPipelinePhase()` determines the active phase.
2. `VIDEO_PHASE_DEPARTMENT_MAP[phaseId]` returns the target department.
3. If the current agent is not in that department, `selectAgentForDepartment()` picks a new agent.
4. The new agent inherits the task context and continues execution.

### Artifact Flow

```
concept ──pitch──→ screenplay ──shot list──→ image_generation ──images──→ image_review
                                                                              │
                                                          ┌──regen flags──────┘
                                                          ↓
                                                   image_generation (retry)
                                                          │
                                              ┌───images──┘
                                              ↓
                                      video_generation ──clips──→ assembly ──→ final.mp4
```

Artifact bridging functions inject file paths and content from prior phases into the next phase's subtask description:
- `bridgeImagesForVideoGeneration()` — scans `video_output/images/`, injects paths into video_generation subtask.
- `bridgeClipsForAssembly()` — scans `video_output/clips/`, injects paths into assembly subtask.

---

## Web Research Pipeline (`web_research_report`)

### Overview

A 5-phase fan-out/fan-in pipeline that conducts parallel web research, synthesizes findings, fact-checks claims, and produces a final report with inline citations.

### Phase Sequence

```
planning ──→ crawl:0 ──┐
             crawl:1 ──┤──→ synthesis ──→ fact_check ──→ final_report
             crawl:2 ──┘
             (fan-out)     (fan-in)      (sequential)   (sequential)
```

### Depth Configuration

The `depth` parameter (from `workflow_meta_json.depth`) controls parallelism and thoroughness:

| Depth | Crawlers | Phases | Max Rounds |
|-------|----------|--------|------------|
| `quick` | 1 | planning → crawl → final_report (fact_check skipped) | 5 |
| `standard` | 3 | all 5 phases | 5 |
| `deep` | 5 | all 5 phases | 5 |

### Pipeline Seeding

On first execution, `seedResearchPipelineSubtasks()` creates subtasks based on depth:

**Standard depth (3 crawlers) example:**

| # | Subtask | Department | Initial Status |
|---|---------|------------|----------------|
| 1 | `[pipeline:planning]` | planning | `pending` |
| 2 | `[pipeline:crawl:0]` | dev | `blocked` |
| 3 | `[pipeline:crawl:1]` | dev | `blocked` |
| 4 | `[pipeline:crawl:2]` | dev | `blocked` |
| 5 | `[pipeline:synthesis]` | planning | `blocked` |
| 6 | `[pipeline:fact_check]` | qa | `blocked` |
| 7 | `[pipeline:final_report]` | qa | `blocked` |

For `quick` depth: 1 crawler, `fact_check` is seeded as `cancelled`.

### Phase-by-Phase Workflow

#### Phase 1: Planning (Planning Dept)

**Agent:** Planning department (e.g., Sage)
**Input:** Research topic from task description
**Output:** `research_output/search_strategy.json`

The agent:
1. Analyzes the topic and identifies knowledge gaps.
2. Performs MECE decomposition into N sub-questions.
3. For each sub-question, defines:
   - Search keywords
   - Source types (academic, news, official, etc.)
   - Priority level
4. Outputs structured JSON validated by `SearchStrategySchema` (Zod).

**Completion → triggers fan-out: all crawler subtasks unblocked.**

#### Phase 2: Crawl (Dev Dept — Parallel Fan-Out)

**Agents:** Dev department (e.g., Crawl, Archive, Spider — one per crawler)
**Input:** Sub-question from search strategy (artifact-bridged via `bridgePlanningForCrawlers()`)
**Output:** `research_output/findings/crawler_N.md` per crawler

Each crawler agent:
1. Receives its assigned sub-question with keywords and source types.
2. Uses WebSearch and WebFetch tools to investigate.
3. Evaluates source quality (authority, recency, type).
4. Documents findings with citations.

**All crawlers run in parallel.** The system uses `areAllCrawlersComplete()` to check if ALL crawlers have finished before advancing.

**All crawlers complete → triggers fan-in: synthesis subtask unblocked.**

#### Phase 3: Synthesis (Planning Dept — Fan-In)

**Agent:** Planning department (e.g., Sage)
**Input:** All crawler findings (artifact-bridged via `bridgeCrawlerFindingsForSynthesis()`, capped at 8KB per crawler)
**Output:** `research_output/draft_report.md`

The agent:
1. Receives merged findings from all crawlers.
2. Performs **thematic** merge (NOT crawler-by-crawler summary).
3. Identifies contradictions between sources and resolves them.
4. Performs gap analysis — flags areas where evidence is thin.
5. Produces a structured draft report.

**Completion → unblocks Phase 4 (or Phase 5 if fact_check is skipped).**

#### Phase 4: Fact Check (QA Dept)

**Agent:** QA department (e.g., Verify)
**Input:** Draft report (artifact-bridged via `bridgeSynthesisForFactCheck()`, capped at 8KB)
**Output:** `research_output/fact_check_results.json`

The agent:
1. Re-verifies key claims against original sources.
2. Cross-validates facts across multiple sources.
3. Assigns confidence scores: `high`, `medium`, or `low`.
4. Output validated by `FactCheckResultSchema` (Zod): claim, verified, confidence, original_source, verification_source, notes.

**Skipped for `quick` depth.**
**Completion → unblocks Phase 5.**

#### Phase 5: Final Report (QA Dept)

**Agent:** QA department (e.g., Verify)
**Input:** Draft report + fact-check results (artifact-bridged via `bridgeFactCheckForFinalReport()`)
**Output:** `research_output/final_report.md`

The agent:
1. Polishes the draft report with fact-check results.
2. Adds inline citations throughout.
3. Adjusts confidence levels based on fact-check findings.
4. Produces the final, publication-ready report.

**Completion → task enters `review` → review consensus meeting.**

### Phase Transitions

```
Phase completes (exit code 0)
  ↓
handleResearchPhaseAdvancement()
  ├─ Wrap in DB transaction
  ├─ Determine which phases are complete/blocked
  ├─ Run artifact bridge for the transition:
  │   ├─ planning done + crawlers blocked → bridgePlanningForCrawlers()
  │   ├─ ALL crawlers done + synthesis blocked → bridgeCrawlerFindingsForSynthesis()
  │   ├─ synthesis done + fact_check blocked → bridgeSynthesisForFactCheck()
  │   ├─ synthesis done + fact_check cancelled → bridgeFactCheckForFinalReport()
  │   └─ fact_check done + final_report blocked → bridgeFactCheckForFinalReport()
  ├─ advanceResearchPipelinePhase()
  │   ├─ Fan-out: planning → unblock ALL crawlers simultaneously
  │   ├─ Fan-in: last crawler → unblock synthesis
  │   └─ Sequential: each remaining phase → unblock next
  └─ If more phases pending:
      └─ Set agent idle → task status = 'planned' → triggerTaskReRun()
```

### Agent Reassignment Between Phases

Department mapping per phase:

| Phase | Department | Ideal Model Profile |
|-------|-----------|-------------------|
| Planning | `planning` | Strong reasoning (Opus, o3) |
| Crawl | `dev` | Fast + tool-use (Sonnet, GPT-4o) |
| Synthesis | `planning` | Long context + reasoning |
| Fact Check | `qa` | Precise + tool-use |
| Final Report | `qa` | Good writing |

On each phase transition, `selectAgentForDepartment()` picks an idle agent from the target department. Multiple crawlers can run simultaneously with different dev-department agents.

### Artifact Flow

```
planning ──search_strategy.json──→ crawl:0 ──crawler_0.md──┐
                                   crawl:1 ──crawler_1.md──┤──→ synthesis ──draft_report.md──→ fact_check
                                   crawl:2 ──crawler_2.md──┘                                      │
                                                                              fact_check_results.json
                                                                                      │
                                                                                      ↓
                                                                                final_report.md
```

Artifact validation is non-blocking:
- `SearchStrategySchema` validates search strategy; falls back to legacy plain string array format.
- `FactCheckResultSchema` validates fact-check results; falls back to raw content on invalid JSON.
- Per-crawler findings capped at 8KB before injection into synthesis.

---

## Design Studio (`design_studio`)

### Overview

A single-phase workflow (no multi-phase pipeline) for UI design tasks with structured input/output, accessibility auditing, and developer handoff.

### Workflow

Unlike video and research packs, Design Studio runs as **one continuous task execution** — no subtask seeding, no phase transitions.

```
Task created → Agent assigned → Single execution → Review meeting → Done
```

### Input Schema

| Field | Required | Description |
|-------|----------|-------------|
| `design_goal` | Yes | What the design should accomplish |
| `target_surface` | Yes | Platform/device target |
| `brand_constraints` | Yes | Brand guidelines to follow |
| `figma_url` | No | Figma file URL for reference |
| `accessibility_target` | No | WCAG level or custom a11y target |
| `component_inventory` | No | Existing components to reuse |
| `handoff_scope` | No | What to include in dev handoff |

### Execution Flow

1. **Agent assignment** — Design department preferred, fallback to planning → dev.
2. **Guidance injection** — Pack rules include:
   - Reference to skill docs: `ui_design.md`, `component_creation.md`, `design_review.md`, `accessibility_audit.md`.
   - Required accessibility checks: contrast, focus_order, hit_target, state_visibility.
   - Required output structure (see below).
3. **Agent executes** — produces all output sections in a single run.
4. **Design artifact sync** — `syncDesignArtifactsFromWorktree()` copies design files from the worktree to `design_output/task-{taskId}/`.
5. **Review meeting** — follows the standard review consensus flow.

### Required Output Sections

| Section | Content |
|---------|---------|
| `design_brief` | Summary of design decisions and rationale |
| `mockup_summary` | Description of mockups produced |
| `design_tokens` | Extracted design tokens (colors, spacing, typography) |
| `accessibility_audit` | A11y check results (contrast, focus order, hit targets) |
| `design_review_notes` | Notes for the review meeting |
| `design_to_code_handoff` | Structured JSON for developers |

### Developer Handoff JSON Structure

```json
{
  "components": [...],
  "tokens": {...},
  "interaction_states": [...],
  "layout_rules": [...],
  "implementation_notes": "...",
  "asset_manifest": [...]
}
```

### QA Review Chain

```
Design Agent → QA Agent → CEO Approval
```

- A11y checks required: contrast, focus_order, hit_target.
- Max auto-fix passes: 2 (agent can self-correct accessibility issues up to twice before escalating).

### Design Artifact Sync

After execution, `syncDesignArtifactsFromWorktree()` scans for design files:

**Source directories (priority order):** `design_output`, `design-assets`, `design_assets`, `screenshots`, `tokens`, `assets/design`

**File categories:**

| Category | Extensions |
|----------|-----------|
| Mockup | `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.pdf` |
| Screenshot | `.gif` |
| Token | `.json`, `.yaml`, `.yml`, `.css`, `.scss` |

Output is copied to `design_output/task-{taskId}/` with a `manifest.json` listing all files.

### Agent Name Pool

| Department | Agents |
|-----------|--------|
| Design Planning | Design PM |
| UI Design | UI Designer |
| Design QA | Design QA |
| Handoff Engineering | Handoff Engineer |

---

## Development Pack (`development`)

### Overview

The general-purpose pack for software development tasks. No multi-phase pipeline — runs as a single execution with optional subtask delegation.

### Workflow

```
Task created → Agent assigned → Execution → (Subtask delegation) → Review meeting → Done
```

### Input Schema

| Field | Required | Description |
|-------|----------|-------------|
| `project` | Yes | Project path or identifier |
| `instruction` | Yes | What to build/fix |
| `constraints` | No | Technical or business constraints |

### Execution Flow

1. **Agent assignment** — Dev department preferred, then QA → DevSecOps → Operations → Planning → Design.
2. **Worktree creation** — isolated git worktree for the task.
3. **Agent executes** — the CLI agent works in the worktree, writing code, running tests, etc.
4. **Subtask creation** — agents can spawn subtasks during execution:
   - Claude Code: detected via `tool_use` with `tool='Task'`.
   - Codex: detected via `collab_tool_call` with `tool='spawn_agent'`.
   - Gemini: detected via plan output `{"subtasks": [...]}`.
5. **Foreign-department subtasks** — if a subtask targets another department, it's delegated via `processSubtaskDelegations()`, creating a child task in the target department.
6. **Completion** — on exit code 0, own-department subtasks auto-complete, then review meeting begins.

### QA Rules

| Rule | Value |
|------|-------|
| Require test evidence | Yes |
| Require risk notes | Yes |
| Max auto-fix passes | 3 |
| Max rounds | 3 |

### Department Pipeline (Optional)

Development tasks can optionally use a **department pipeline** via `workflow_meta_json.pipeline`:

```json
{
  "pipeline": {
    "current_step": 0,
    "steps": [
      { "department": "dev", "label": "Implementation" },
      { "department": "qa", "label": "Testing" },
      { "department": "devsecops", "label": "Security Review" }
    ]
  }
}
```

This creates a sequential department handoff:
1. Dev implements → on success, advance to next step.
2. QA tests → on success, advance.
3. DevSecOps reviews → on success, enter final review.

If a QA step fails (exit code != 0), it bounces back to the previous dev step (max 2 bounces via `MAX_QA_BOUNCES`).

---

## CLI Providers: OpenClaw

### Overview

OpenClaw is a CLI provider type (`openclaw`) that enables **local LLM models** (e.g., vLLM with Qwen) to run as agents in the office. Its defining feature is **profile-based isolation**: each profile gets its own configuration directory, model settings, and tool permissions — preventing cross-model contamination.

### How It Differs from Other Providers

| Feature | Claude / Codex / Gemini | OpenClaw |
|---------|------------------------|----------|
| Prompt delivery | via stdin | via `--message` flag |
| Model configuration | CLI flag (`--model`) | Profile config (`openclaw.json`) |
| Isolation | None | Per-profile directory (`~/.openclaw-<name>/`) |
| Auth | OAuth or API key | None (local only) |
| Gateway mode | n/a | Removed — only `--local` mode |
| Reasoning level | Supported (Codex) | Not supported |
| Session tracking | Not used | `--session-id` per task |

### Profile System

Each OpenClaw profile is fully isolated:

```
~/.openclaw-qwen/
├── openclaw.json        # Model provider, API endpoint, context window
├── workspace-qwen/
│   └── SOUL.md          # Agent personality and tool instructions
└── ...                  # Separate state, logs, cache
```

**Profile configuration** (`~/.openclaw-<name>/openclaw.json`):

```json
{
  "models": { "providers": { "vllm": {
    "baseUrl": "http://<host>:<port>/v1",
    "apiKey": "vllm-local",
    "api": "openai-completions",
    "models": [{ "id": "<model-id>", "contextWindow": 32768, "maxTokens": 8192 }]
  }}},
  "agents": { "defaults": { "model": { "primary": "vllm/<model-id>" }}},
  "tools": { "elevated": { "enabled": true }}
}
```

**Setup example:**

```bash
openclaw --profile qwen config set agents.defaults.model.primary "vllm/qwen3.5-35b-moe"
openclaw --profile qwen config set tools.elevated.enabled true
```

### Spawn Command

When a task is assigned to an OpenClaw agent, the system spawns:

```bash
openclaw --profile <name> agent --local --json --session-id <taskId> --message "<prompt>"
```

Key points:
- `--profile <name>` — selects the isolated profile directory.
- `--local` — runs the embedded agent directly (no gateway dependency).
- `--json` — structured output mode.
- `--session-id <taskId>` — tracks conversation state per task.
- `--message "<prompt>"` — delivers the prompt (NOT via stdin like other providers).

**In code** (`cli-tools.ts`, `buildAgentArgs`):

```typescript
case "openclaw": {
  const args = ["openclaw"];
  if (profile) args.push("--profile", profile);
  args.push("agent", "--local", "--json");
  return args;
}
```

The `--session-id` and `--message` flags are appended at spawn time in `cli-runtime.ts`:

```typescript
if (provider === "openclaw") {
  args.push("--session-id", taskId, "--message", prompt);
}
// stdin is NOT written for openclaw
if (provider !== "openclaw") {
  child.stdin?.write(prompt);
}
```

### Database Schema

The `agents` table stores OpenClaw-specific data:

```sql
cli_provider TEXT CHECK(cli_provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api','openclaw'))
cli_profile  TEXT  -- nullable, used ONLY for openclaw
```

- `cli_profile` stores the profile name (e.g., `'qwen'`).
- Other providers always have `cli_profile = NULL`.
- Switching provider away from OpenClaw auto-clears the profile.

### Frontend Integration

**Agent detail editor** (`CliEditorInline.tsx`): When an agent's provider is set to `openclaw`, a profile text input appears with placeholder "Profile (e.g. qwen)". The display shows: `OpenClaw · qwen · <model>`.

**Agent creation form** (`AgentFormModal.tsx`): Includes `cli_profile` field, initialized as empty string.

**Validation rules:**
- Profile is only allowed when `cli_provider = 'openclaw'`.
- Setting a profile on a non-OpenClaw agent returns `400 cli_profile_requires_openclaw_provider`.
- Switching away from OpenClaw auto-clears the profile to `null`.

### Meetings & One-Shot Execution

OpenClaw agents participate in meetings via the one-shot runner (`one-shot-runner.ts`):

```typescript
if (provider === "openclaw") {
  args.push("--session-id", `chat-${agent.id}-${Date.now()}`, "--message", prompt);
}
```

Each meeting gets a unique session ID to avoid session contamination.

### Auth & Lifecycle

OpenClaw requires **no authentication** — it runs locally. During provider fallback logic in `lifecycle.ts`, OpenClaw agents are **skipped** (not reassigned to a fallback provider):

```typescript
if (prov === "copilot" || prov === "antigravity" || prov === "api" || prov === "openclaw") continue;
```

### Environment Configuration

Optional env var in `.env`:

```bash
OPENCLAW_CONFIG="/path/to/openclaw.json"  # Override default config path
```

Setup scripts (`scripts/openclaw-setup.sh`, `scripts/openclaw-setup.ps1`) detect and configure OpenClaw automatically.

### Key Source Files

| Mechanism | File |
|-----------|------|
| CLI argument builder | `server/modules/workflow/core/cli-tools.ts` |
| Spawn logic (--message, stdin skip) | `server/modules/workflow/agents/cli-runtime.ts` |
| One-shot/meeting execution | `server/modules/workflow/core/one-shot-runner.ts` |
| Agent CRUD + profile validation | `server/modules/routes/core/agents/crud.ts` |
| Agent spawn endpoint | `server/modules/routes/core/agents/spawn.ts` |
| DB schema (cli_profile column) | `server/modules/bootstrap/schema/base-schema.ts` |
| Frontend profile input | `src/components/agent-detail/CliEditorInline.tsx` |
| Frontend state management | `src/components/agent-detail/useAgentDetailState.ts` |
| Agent creation form | `src/components/agent-manager/AgentFormModal.tsx` |
| Provider constants & labels | `src/components/agent-detail/constants.ts` |
| Setup scripts | `scripts/openclaw-setup.sh`, `scripts/openclaw-setup.ps1` |

---

## Appendix: Key Source Files

| Mechanism | File |
|-----------|------|
| Pack definitions | `server/modules/workflow/packs/definitions.ts` |
| Execution guidance (all packs) | `server/modules/workflow/packs/execution-guidance.ts` |
| Video phase seeding & advancement | `server/modules/workflow/packs/video-pipeline-phases.ts` |
| Video artifact bridging | `server/modules/workflow/packs/video-pipeline-artifact-bridge.ts` |
| Research phase seeding & advancement | `server/modules/workflow/packs/research-pipeline-phases.ts` |
| Research artifact bridging | `server/modules/workflow/packs/research-artifact-bridge.ts` |
| Design artifact sync | `server/modules/workflow/packs/design-asset.ts` |
| Task execution entry point | `server/modules/routes/core/tasks/execution-run.ts` |
| Agent auto-assignment | `server/modules/routes/core/tasks/execution-run-auto-assign.ts` |
| Run-complete handler chain | `server/modules/workflow/orchestration/run-complete-handler.ts` |
| Video phase advancement | `server/modules/workflow/orchestration/run-complete-video.ts` |
| Research phase advancement | `server/modules/workflow/orchestration/run-complete-research.ts` |
| Dept pipeline advancement | `server/modules/workflow/orchestration/run-complete-dept-pipeline.ts` |
| Meeting orchestrator | `server/modules/workflow/orchestration/meetings.ts` |
| Review consensus | `server/modules/workflow/orchestration/meetings/review-consensus.ts` |
| Leader selection | `server/modules/workflow/orchestration/meetings/leader-selection.ts` |
| Meeting presence (CEO office) | `server/modules/workflow/orchestration/meetings/presence.ts` |
| Meeting minutes | `server/modules/workflow/orchestration/meetings/minutes.ts` |
| Office pack config (name pools) | `src/app/office-workflow-pack.ts` |
| CLI agent spawn | `server/modules/workflow/agents/cli-runtime.ts` |
| Subtask seeding | `server/modules/workflow/agents/subtask-seeding.ts` |
| Meeting prompt builder | `server/modules/workflow/core/meeting-prompt-tools.ts` |

## Visual Node Editor

Packs can be explored and edited visually via the **Visual Node Editor** in the Tasks tab (click the **Graph** button, or navigate to the dedicated **Workflows** tab if present).

| Mode | Description |
|------|-------------|
| **Visualizer** | Read-only phase DAG — shows nodes, dependencies, and artifact edges |
| **Monitor** | Live execution overlay — maps `subtask_update` WebSocket events to phase states |
| **Editor** | Visual editing — drag-to-connect ports, PropertyPanel sidebar, YAML preview + save |
| **Builder** | Create new community packs — node palette, guidance editor with language tabs |

Changes made in Editor mode are saved via `PUT /api/ops/workflow-packs/:key/definition`.
Node positions persist separately via `PUT /api/ops/workflow-packs/:key/positions`.

## Phase Reset

Running tasks can be partially rewound without cancelling the whole run:

| Endpoint | Effect |
|----------|--------|
| `POST /api/core/tasks/:taskId/phases/:phaseId/reset` | Reset a single phase to `pending` |
| `POST /api/core/tasks/:taskId/phases/reset-from/:phaseId` | Reset phase + all downstream (BFS traversal) |

Both endpoints stop any active agent process before mutating state to prevent race conditions.
