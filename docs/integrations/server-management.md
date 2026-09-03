# Server Management System

## Overview

OctoOffice supports external runtime server management for jobs requiring shared infrastructure.

- Supported server types: `comfyui`, `llm_api`, `database`, `file_storage`
- Status model: `online`, `offline`, `busy`, `idle`
- Allocation lifecycle: `queued` -> `active` -> `released`

Typical use cases:

- ComfyUI image/video generation endpoints
- Shared LLM gateway endpoints
- Database/file-storage resources required by specialized tasks

## Core Routes

- Server CRUD:
  - `GET /api/ops/servers/presets`
  - `GET /api/ops/servers`
  - `GET /api/ops/servers/:id`
  - `POST /api/ops/servers`
  - `PATCH /api/ops/servers/:id`
  - `DELETE /api/ops/servers/:id`
- Health:
  - `POST /api/ops/servers/health-check`
  - `POST /api/ops/servers/:id/health-check`
- Allocation + queue:
  - `GET /api/ops/servers/allocations`
  - `POST /api/ops/servers/allocations/request`
  - `POST /api/ops/servers/allocations/release`
  - `POST /api/ops/servers/allocations/process-queue`

## Quickstart

Register an LLM server:

```bash
curl -X POST http://127.0.0.1:8790/api/ops/servers \
  -H 'content-type: application/json' \
  -d '{
    "name":"LLM Gateway A",
    "type":"llm_api",
    "endpoint_url":"http://127.0.0.1:11434/v1",
    "max_concurrent_jobs":4,
    "enabled":true
  }'
```

Request allocation for a task:

```bash
curl -X POST http://127.0.0.1:8790/api/ops/servers/allocations/request \
  -H 'content-type: application/json' \
  -d '{
    "task_id":"<task-id>",
    "agent_id":"<agent-id>",
    "requested_server_type":"llm_api",
    "queue_reason":"awaiting_capacity"
  }'
```

Release allocation when finished:

```bash
curl -X POST http://127.0.0.1:8790/api/ops/servers/allocations/release \
  -H 'content-type: application/json' \
  -d '{"task_id":"<task-id>","reason":"task_completed"}'
```

## Allocation Behavior

- Allocation chooses lowest-load eligible server first.
- If capacity is full, request is queued and gets a queue position.
- Queue processing activates pending allocations as slots become available.
- Lifecycle broadcasts `server_update` events for dashboard synchronization.
