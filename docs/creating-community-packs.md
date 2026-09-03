# Creating Community Packs

This guide walks you through creating your own workflow pack for OctoOffice. No code changes required — just YAML and Markdown.

## Quick Start

1. Copy the template:
   ```bash
   cp -r server/packs/community/_template server/packs/community/my_pack
   ```
2. Edit `pack.yaml` and guidance files
3. Restart the server (`pnpm dev`)
4. Your pack appears automatically in the UI

## Directory Structure

```
server/packs/community/my_pack/
├── pack.yaml                    # Pack definition (required)
└── guidance/                    # Agent instructions (required)
    ├── phase_one.en.md          # English guidance (required per phase)
    ├── phase_one.de.md          # German guidance (optional)
    ├── phase_two.en.md
    └── phase_three.en.md
```

The server auto-discovers any subdirectory of `server/packs/community/` containing a `pack.yaml`. Directories starting with `_` (like `_template`) are skipped by the loader.

## Minimal Pack Example

Here's the simplest possible pack — a 2-phase "Plan then Execute" workflow:

```yaml
pack:
  key: my_pack # Unique ID: lowercase, digits, underscores only
  schema_version: 1 # Always 1
  name:
    en: "My Pack" # At least English required
  version: "1.0.0" # Semantic versioning
  description:
    en: "A simple 2-phase workflow"

input:
  required: [] # No user inputs needed
  optional: []

phases:
  - id: planning # Phase IDs: lowercase + underscores
    department: planning
    guidance: "guidance/planning.{lang}.md" # {lang} placeholder required!
    gate: user_approval # Pause for user review before continuing
    outputs:
      - name: plan
        type: markdown
        path: output/plan.md

  - id: execution
    department: dev
    guidance: "guidance/execution.{lang}.md"
    inputs:
      - name: plan # Consume output from planning phase
        from: planning.plan
    outputs:
      - name: result
        type: markdown
        path: output/result.md
```

That's it — ~25 lines of YAML for a working workflow.

## Pack YAML Reference

### `pack:` (required)

| Field             | Required | Description                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `key`             | Yes      | Unique identifier. Regex: `^[a-z][a-z0-9_]*$`                                 |
| `schema_version`  | Yes      | Always `1`                                                                    |
| `name`            | Yes      | Localized names: `{ en: "...", de: "...", ... }`                              |
| `version`         | Yes      | Semantic version string (e.g. `"1.0.0"`)                                      |
| `description`     | Yes      | Localized descriptions                                                        |
| `icon`            | No       | Emoji for UI display (e.g. `"🔬"`)                                            |
| `agent_routing`   | No       | `"department"` (default) or `"single"`                                        |
| `shared_guidance` | No       | Path to shared guidance file prepended to every phase. Must contain `{lang}`. |

#### Shared Guidance

To avoid repeating the same instructions in every phase guidance file, use `shared_guidance`:

```yaml
pack:
  key: my_pack
  shared_guidance: "guidance/shared.{lang}.md" # Prepended to every phase
```

The content of this file is prepended to each phase's guidance automatically. Only create it if you have content that applies to ALL phases (e.g. output conventions, CLAUDE.md update rules).

### `input:` (required, can be empty)

Define what the user fills in when creating a task with this pack.

```yaml
input:
  required:
    - key: topic # Variable name (used in skip_when expressions)
      type: string # string | number | boolean
      label:
        en: "Research Topic"
  optional:
    - key: depth
      type: string
      label:
        en: "Depth"
      default: "standard" # Pre-filled value
      enum: # Restrict to specific choices
        - quick
        - standard
        - deep
```

### `phases:` (required, at least 1)

Each phase is a step in the workflow. Phases form a DAG (directed acyclic graph) — the system determines execution order from the `inputs.from` references.

| Field             | Required | Description                                                        |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `id`              | Yes      | Unique within pack. Regex: `^[a-z][a-z0-9_]*$`                     |
| `department`      | Yes      | Which department runs this phase (matches `staff.name_pool`)       |
| `guidance`        | Yes      | Path to guidance file. **Must contain `{lang}`**                   |
| `inputs`          | No       | List of `{ name, from }` — connects to upstream phase outputs      |
| `outputs`         | No       | List of `{ name, type, path, schema? }` — what this phase produces |
| `gate`            | No       | `"auto"` (default) or `"user_approval"` — pause for human review   |
| `skip_when`       | No       | Expression to skip phase (e.g. `"input.depth == 'quick'"`)         |
| `capability`      | No       | External service (e.g. `"web_search"`, `"text2img"`)               |
| `capability_mode` | No       | `"agent"` (default), `"hybrid"`, or `"server"`                     |
| `fan_out`         | No       | `{ count_from: "phase.output.array.length" }` — parallel execution |
| `on_review_fail`  | No       | `{ rerun: "phase_id", max_passes: 2, flag_output: "name" }`        |
| `node_type`       | No       | Key of a registered NodeType for server-side execution             |
| `node_config`     | No       | Config object passed to the NodeType's `execute()`                 |
| `hooks`           | No       | `{ pre_run: "script.sh", post_run: "script.sh" }`                  |

#### How phases connect

Phases don't need an explicit `depends_on` — the system infers the DAG from `inputs.from` references:

```yaml
phases:
  - id: research # No inputs → root phase (runs first)
    outputs:
      - name: findings
        type: markdown
        path: output/findings.md

  - id: writing # Depends on research (via input reference)
    inputs:
      - name: context
        from: research.findings # Format: <phase_id>.<output_name>
    outputs:
      - name: draft
        type: markdown
        path: output/draft.md

  - id: review # Depends on both research and writing
    inputs:
      - name: draft
        from: writing.draft
      - name: original_findings
        from: research.findings
```

> **Note:** Some built-in packs include a `depends_on` field for documentation purposes, but it is **not part of the schema** and has no effect on execution. Only `inputs.from` determines the phase execution order.

#### Output types

| Type       | Description            | Typical file extension |
| ---------- | ---------------------- | ---------------------- |
| `markdown` | Text content           | `.md`                  |
| `json`     | Structured data        | `.json`                |
| `image`    | Generated/edited image | `.png`, `.jpg`         |
| `video`    | Video content          | `.mp4`                 |
| `audio`    | Audio/speech           | `.mp3`, `.wav`         |
| `document` | Generic document       | `.pdf`, `.docx`        |

Outputs also accept an optional `schema` field (string path to a JSON Schema file) for structured validation of JSON outputs. Example: `schema: schemas/search-strategy.schema.json`

#### `from` reference syntax

| Pattern                          | Meaning                                           |
| -------------------------------- | ------------------------------------------------- |
| `planning.plan`                  | Output "plan" from phase "planning"               |
| `crawl.findings.*`               | All fan-out results (explicit fan-in aggregation) |
| `planning.items[{n}]`            | Index placeholder (expanded per fan-out instance) |
| `planning.strategy.items.length` | JSON sub-path navigation                          |
| `input.topic`                    | Pack-level input variable                         |

> **Fan-in note:** Plain references to fan-out phase outputs (e.g. `crawl.findings` without `.*`) also work — the artifact bridge handles aggregation automatically. The `.*` wildcard is an explicit alternative.

### `cost_profile:` (optional)

```yaml
cost_profile:
  max_rounds: 5 # Max conversation rounds per phase (default: 5)
  default_reasoning: medium # low | medium | high (default: medium)
  max_input_tokens: 50000 # Optional hard limit
  max_output_tokens: 16000 # Optional hard limit
```

### `qa_rules:` (optional)

```yaml
qa_rules:
  require_test_evidence: false # Require test output before approval (default: false)
  max_auto_fix_passes: 2 # Auto-retry failed phases (default: 2)
```

### `staff:` (optional but recommended)

Defines the agents that appear in the office for this pack.

```yaml
staff:
  default_workspace: "my_output" # Output directory for tasks using this pack
  name_pool:
    - name: Alice # Display name
      role: team_leader # team_leader | agent
      department: planning # Must match a phase department
      personality: "Strategic thinker who creates clear, actionable plans."
      name_ko: "앨리스" # Localized names (optional)
      name_ja: "アリス"
      name_zh: "爱丽丝"
      avatar_emoji: "🧭" # Optional avatar
      sprite_number: 3 # Optional pixel art sprite index
    - name: Bob
      role: agent
      department: dev
      personality: "Fast, focused implementer."
  room_theme: # Office room colors (optional)
    floor1: "#e2eef6"
    floor2: "#d8e7f1"
    wall: "#55728d"
    accent: "#5a9fd4"
```

### `ui:` (optional but recommended)

Controls how the pack appears in the dashboard, pack selector, and office view.

```yaml
ui:
  slug: "MP" # Short identifier (max 5 chars)
  label:
    en: "My Pack"
  summary:
    en: "A simple 2-phase workflow"
  departments:
    planning:
      name:
        en: "Planning"
      icon: "📋"
      color: "#f59e0b"
    dev:
      name:
        en: "Development"
      icon: "💻"
      color: "#3b82f6"
  room_themes: # Named room color schemes (numeric hex)
    planning_room:
      floor1: 0xe2eef6
      floor2: 0xd8e7f1
      wall: 0x55728d
      accent: 0x5a9fd4
  staff_cycle: # Department rotation order
    - planning
    - dev
```

> **Color format note:** `ui.room_themes` accepts both numeric hex (`0xe2eef6`) and string hex (`"#e2eef6"`). `staff.room_theme` only accepts string hex.

Departments also support optional `agent_prefix` (localized prefix for agent names) and `avatar_pool` (array of emoji/image options for agents in that department).

Without `ui:`, the pack still loads but won't have custom icons, colors, or labels in the dashboard.

## Writing Guidance Files

Guidance files are plain Markdown. They tell the agent what to do during a phase. No special syntax required.

### Structure

A good guidance file follows this pattern:

```markdown
[Phase: Phase Name — Display Title]

Brief context about this phase's role in the workflow.

1. First step the agent should take
2. Second step
3. Third step

Save as output/filename.md:
(describe expected format or show a template)
```

### Example: Planning Phase

```markdown
[Phase: Planning — Create Project Plan]

You are creating the project plan. Your output determines the scope for all downstream phases.

1. Analyze the task description and identify the key requirements.
2. Break the work into 3-7 concrete steps, each independently executable.
3. For each step, define:
   - What needs to be done (specific, not vague)
   - Expected output (file, code change, document)
   - Estimated complexity (small / medium / large)
4. Flag any risks or unknowns that need user input.

Save as output/plan.md with this structure:

# Project Plan

## Summary

(1-2 sentences)

## Steps

1. **Step name** — Description. Output: `path/to/file`. Complexity: small.
2. ...

## Risks

- Risk 1: ...
```

### Example: Execution Phase

```markdown
[Phase: Execution — Implement Plan]

Read the plan from the previous phase and implement each step.

1. Read output/plan.md to understand what needs to be done.
2. Implement each step in order.
3. After each step, verify the output exists and is correct.
4. Document what you did and any deviations from the plan.

Save as output/result.md:

- Summary of completed work
- List of files created/modified
- Any issues encountered
```

### Tips

- **Be specific about file paths.** Agents need exact paths for inputs and outputs.
- **Show output format examples.** If you expect JSON, show the schema. If Markdown, show the structure.
- **Keep it concise.** 10-25 lines is typical. Agents don't need essays.
- **Reference upstream artifacts.** Tell the agent which files from previous phases to read.

### Multi-language Support

Supported languages: `en` (required), `ko`, `ja`, `zh`, `de`

English is the fallback — if a requested language file doesn't exist, the system uses the English version. You only need to create translations for languages you want to support.

## Common Patterns

### User Approval Gate

Add `gate: user_approval` to pause the workflow and let the user review before continuing. Best for planning or critical decision phases:

```yaml
- id: planning
  department: planning
  guidance: "guidance/planning.{lang}.md"
  gate: user_approval # <-- pauses here
  outputs:
    - name: plan
      type: json
      path: output/plan.json
```

### Conditional Phase Skipping

Use `skip_when` to dynamically skip phases based on user input:

```yaml
input:
  optional:
    - key: skip_tests
      type: boolean
      label: { en: "Skip Testing" }
      default: false

phases:
  - id: testing
    skip_when: "input.skip_tests" # <-- skipped if user checks the box
    # ...
```

### Fan-Out / Parallel Execution

Split work into parallel instances based on a previous phase's output:

```yaml
- id: planning
  outputs:
    - name: items
      type: json
      path: output/items.json # Must contain an array

- id: work
  fan_out:
    count_from: planning.items.length # N instances spawned
  inputs:
    - name: items
      from: planning.items
  outputs:
    - name: result
      type: markdown
      path: "output/results/item_{n}.md" # {n} = instance index
```

The downstream phase receives all parallel outputs automatically. You can use either a plain reference or the explicit wildcard:

```yaml
- id: summary
  inputs:
    - name: all_results
      from: work.result # Fan-in: plain reference works too
      # from: work.result.*        # Explicit wildcard form (equivalent)
```

### Retry on Review Failure

If a review phase fails, automatically re-run an earlier phase:

```yaml
- id: review
  on_review_fail:
    rerun: implementation # Phase to re-run
    max_passes: 2 # Maximum retry attempts
    flag_output: issues # Output name containing the failure reasons
  inputs:
    - name: code
      from: implementation.changes
  outputs:
    - name: result
      type: markdown
      path: output/review.md
    - name: issues
      type: json
      path: output/review_issues.json
```

The `flag_output` JSON must use one of these structures for the graph runner to detect a failure:

- **Array:** `[{ "problem": "..." }, ...]` — non-empty array triggers rerun
- **Object with `failures` key:** `{ "failures": [{ "problem": "..." }] }` — non-empty `failures` array triggers rerun
- **Object with `items` key:** `{ "items": [...] }` — non-empty `items` array triggers rerun
- **Object with `regen_needed` flag:** `{ "regen_needed": true }` — boolean flag triggers rerun

Other structures (e.g. `{ "issues": [...] }`) are **not recognized** and will not trigger a retry.

### External Capability (Connector)

Use an external service like web search or image generation:

```yaml
- id: search
  department: research
  guidance: "guidance/search.{lang}.md"
  capability: web_search # Registered connector capability
  capability_mode: agent # Agent uses the tool (default)
  # ...

- id: generate_image
  department: design
  guidance: "guidance/image.{lang}.md"
  capability: text2img
  capability_mode: server # Connector runs directly, no agent needed
  # ...
```

## Validation & Troubleshooting

The server validates packs at startup. Check the server logs for errors.

### Common Errors

| Error                                                                                           | Cause                                 | Fix                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| `Pack key must start with a letter and contain only lowercase letters, digits, and underscores` | Key uses uppercase, dashes, or spaces | Use `my_pack`, not `my-pack` or `MyPack` |
| `Phase ID must start with a letter...`                                                          | Same as above, for phase IDs          | Use `phase_one`, not `phase-one`         |
| `Guidance path must contain {lang} placeholder`                                                 | Missing `{lang}` in guidance path     | Use `guidance/phase.{lang}.md`           |
| `references unknown phase "X"`                                                                  | Typo in `inputs.from` reference       | Check the source phase ID exists         |
| `references unknown output "X" on phase "Y"`                                                    | Typo in output name                   | Check `outputs.name` on the source phase |
| `Cycle detected`                                                                                | Circular dependency (A → B → A)       | Redesign your DAG to flow forward only   |
| `Too small: expected array to have >=1 items`                                                   | No phases defined                     | Add at least one phase                   |

### Testing Your Pack

1. Place your pack in `server/packs/community/your_pack/`
2. Start the server: `pnpm dev`
3. Check the logs for validation errors
4. Open the Workflows tab in the UI — your pack should appear in the selector
5. Create a test task with your pack to verify the full flow

### Validate via API

All API endpoints require authentication. From localhost, first obtain a session cookie via `/api/auth/session`, then use it for subsequent requests:

```bash
# Step 1: Get session cookie (localhost only — issues cookie + CSRF token)
curl -c cookies.txt http://localhost:8790/api/auth/session

# Step 2: Check loaded packs
curl -b cookies.txt http://localhost:8790/api/ops/workflow-packs/registry
```

To validate a pack definition without saving, use the **Workflows tab → JSON → Validate** button in the UI. The validation endpoint (`POST /api/ops/workflow-packs/validate`) additionally requires a CSRF token header (`x-csrf-token`), which the UI handles automatically.

## Override Built-in Packs

Community packs with the same key as a built-in pack will override it. This lets you customize the default workflows without modifying the source code:

```bash
# Override the development pack
cp -r server/packs/built-in/development server/packs/community/development
# Edit server/packs/community/development/pack.yaml
```

## Real-World Examples

Study the built-in packs for inspiration:

| Pack                 | Phases | Key Features                                | File                               |
| -------------------- | ------ | ------------------------------------------- | ---------------------------------- |
| Development          | 7      | skip_when, user_approval, on_review_fail    | `built-in/development/pack.yaml`   |
| Web Research         | 5      | fan_out/fan_in, capability (web_search)     | `built-in/web-research/pack.yaml`  |
| Video Pre-Production | 7      | Multiple capabilities (text2img, img2video) | `built-in/video-preprod/pack.yaml` |
| Design Studio        | 4      | Figma integration, a11y auditing            | `built-in/design-studio/pack.yaml` |

## Glossary

| Term           | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| **Pack**       | A declarative YAML workflow definition                                 |
| **Phase**      | One step in the workflow, executed by an agent or connector            |
| **Guidance**   | Markdown instructions telling the agent what to do in a phase          |
| **DAG**        | Directed Acyclic Graph — phases flow forward, no circular dependencies |
| **Gate**       | A checkpoint where the workflow pauses for user approval               |
| **Fan-out**    | Splitting one phase into N parallel instances                          |
| **Fan-in**     | Collecting results from parallel fan-out instances                     |
| **Connector**  | An external service integration (web search, image generation, etc.)   |
| **Capability** | A named function provided by a connector (e.g. `text2img`)             |
| **Node Type**  | A server-side TypeScript execution module (no agent needed)            |
