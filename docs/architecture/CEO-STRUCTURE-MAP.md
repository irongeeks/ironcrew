# CEO Structure Map

Generated from parallel architecture analysis lanes:

1. Frontend module map (`src/`)
2. Backend module map (`server/`)
3. Tooling/docs map (`scripts/`, `docs/`)
4. Build/config map (`package.json`, `tsconfig*`, `vite.config.ts`, `.env*`)
5. End-to-end runtime sequence (UI → API → DB/CLI → WS → UI)
6. Repository inventory (tree and key files)

## High-Level System Map

```mermaid
flowchart LR
  subgraph FE[Frontend]
    FE0["src/main.tsx"]
    FE1["src/app/AppMainLayout.tsx"]
    FE2["src/components/*"]
    FE3["src/api/* (7 modules)"]
    FE4["src/hooks/useWebSocket.ts"]
    FE0 --> FE1
    FE1 --> FE2
    FE1 --> FE3
    FE1 --> FE4
  end

  subgraph BE[Backend]
    BE0["server/server-main.ts"]
    BE1["Express REST (/api/*)"]
    BE2["WebSocket broadcast"]
    BE3["SQLite (ironcrew.sqlite)"]
    BE4["CLI/HTTP agents + logs + worktrees"]
    BE0 --> BE1
    BE0 --> BE2
    BE0 --> BE3
    BE0 --> BE4
  end

  FE3 <-->|HTTP| BE1
  FE4 <-->|ws://| BE2
  BE1 --> BE3
  BE1 --> BE4
```

## Frontend Composition

```mermaid
flowchart TD
  App["src/app/AppMainLayout.tsx"] --> Nav["IronCrewTopBar.tsx"]
  App --> MC["MissionControl.tsx (3-col: AgentSidebar + Office+Kanban + Chat)"]
  App --> Office["RetroOfficeView.tsx (Pixi.js)"]
  App --> TaskBoard["taskboard/TaskBoard.tsx"]
  App --> Settings["settings/SettingsPanel.tsx"]
  App --> Chat["ChatPanel.tsx"]
  App --> AgentDetail["AgentDetail.tsx"]
  App --> Terminal["TerminalPanel.tsx"]
  App --> Overlays["AppOverlays.tsx"]
  App --> API["src/api/* (core, comfyui, knowledge, messaging, org, providers, workflow)"]
  App --> Types["src/types/index.ts"]
  App --> WS["hooks/useWebSocket.ts"]
```

## Backend Module Structure

```mermaid
flowchart TD
  Entry["server/server-main.ts"] --> Routes
  Entry --> WS["ws/hub.ts"]
  Entry --> Boot["bootstrap/schema + seeds"]
  Entry --> Life["lifecycle/ (scheduler, ceo-orchestrator, shutdown)"]

  subgraph Routes["modules/routes/"]
    R1["collab/ — chat, delegation, coordination"]
    R2["core/ — agents, tasks, departments, projects"]
    R3["ops/ — settings, skills, oauth, comfyui, servers, messages, terminal"]
    R4["docs/ — knowledge providers, obsidian sync"]
  end

  subgraph Workflow["modules/workflow/"]
    W1["core/ — CLI tools, prompt building, project context"]
    W2["agents/ — cli-runtime, subtask routing/seeding, providers"]
    W3["orchestration/ — execution, run-complete, reviews, meetings"]
    W4["packs/ — definitions, pipeline phases, artifact bridges, execution-guidance"]
    W5["comfyui/ — connector, types"]
  end

  Routes --> Workflow
  Routes --> DB["db/runtime.ts (SQLite)"]
  Routes --> Security["security/auth.ts"]
  Workflow --> DB
```

## Core Runtime Sequence

```mermaid
sequenceDiagram
  participant UI
  participant API as src/api/*
  participant S as server/server-main.ts
  participant DB as SQLite
  participant AG as CLI/HTTP Agent
  participant WS as WebSocket

  UI->>API: initial load (departments/agents/tasks/stats/settings)
  API->>S: GET /api/*
  S->>DB: SELECT/aggregate
  DB-->>S: rows
  S-->>API: json
  API-->>UI: hydrate state

  UI->>API: POST /api/tasks/:id/run
  API->>S: run request
  S->>DB: update task/agent + append logs
  S->>AG: spawn CLI or call HTTP model
  AG-->>S: output stream
  S->>WS: broadcast task_update/cli_output/agent_status
  WS-->>UI: live updates
  UI->>API: GET /api/tasks/:id/terminal
  API->>S: read log + task_logs
  S-->>API: terminal payload
  API-->>UI: terminal refresh
```

## Key Files

- Runtime entry: `server/server-main.ts`, `src/main.tsx`, `src/app/AppMainLayout.tsx`
- API client modules: `src/api/core.ts`, `src/api/comfyui-workflows.ts`, `src/api/knowledge-docs.ts`, `src/api/messaging-runtime-oauth.ts`, `src/api/organization-projects.ts`, `src/api/providers-reports-github.ts`, `src/api/workflow-skills-subtasks.ts`
- Shared model types: `src/types/index.ts`
- Workflow packs: `server/modules/workflow/packs/definitions.ts`
- Pipeline orchestration: `server/modules/workflow/orchestration/run-complete-handler.ts`

## Refresh Commands

```bash
pnpm run arch:map
```
