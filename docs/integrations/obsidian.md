# Obsidian Docs Integration

## Overview

OctoOffice can connect local Obsidian vaults and expose them as knowledge providers.

- Provider type: `obsidian_local`
- Department usage: Knowledge/docs workflows and project-bound documentation sync
- Sync direction: bidirectional (read/search + write/update + task-output sync to vault)

## Core Routes

- Provider lifecycle:
  - `GET /api/knowledge/docs/providers`
  - `POST /api/knowledge/docs/providers`
  - `PATCH /api/knowledge/docs/providers/:id`
  - `DELETE /api/knowledge/docs/providers/:id`
- Binding and resolution:
  - `GET /api/knowledge/docs/providers/:id/bindings`
  - `POST /api/knowledge/docs/providers/:id/bindings`
  - `DELETE /api/knowledge/docs/bindings/:bindingId`
  - `GET /api/knowledge/docs/tasks/:taskId/providers`
- Notes and search:
  - `GET /api/knowledge/docs/providers/:id/notes`
  - `GET /api/knowledge/docs/providers/:id/notes/content`
  - `PUT /api/knowledge/docs/providers/:id/notes/content`
  - `POST /api/knowledge/docs/providers/:id/notes`
  - `POST /api/knowledge/docs/providers/:id/search`
  - `GET /api/knowledge/docs/providers/:id/backlinks`
- Wikilinks and sync:
  - `POST /api/knowledge/docs/wikilinks/format`
  - `POST /api/knowledge/docs/tasks/:taskId/sync`

## Quickstart

Create provider:

```bash
curl -X POST http://127.0.0.1:8790/api/knowledge/docs/providers \
  -H 'content-type: application/json' \
  -d '{
    "name":"Main Vault",
    "vaultPath":"/abs/path/ObsidianVault",
    "enabled":true,
    "readOnly":false
  }'
```

Bind to project:

```bash
curl -X POST http://127.0.0.1:8790/api/knowledge/docs/providers/<provider-id>/bindings \
  -H 'content-type: application/json' \
  -d '{"projectId":"<project-id>"}'
```

Format wikilink:

```bash
curl -X POST http://127.0.0.1:8790/api/knowledge/docs/wikilinks/format \
  -H 'content-type: application/json' \
  -d '{"target":"Architecture/API","alias":"API Contract"}'
```

## Wikilink + Tag Behavior

- `[[wikilink]]` targets are normalized without `.md` extension.
- YAML frontmatter tags are normalized via `PUT .../notes/content` with `tags` payload.
- Backlinks resolve by normalized title/target matching.

## Safety

- Vault path access is constrained to paths inside the provider root.
- `readOnly: true` blocks write APIs while still allowing list/search/read.
