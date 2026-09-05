# Memory: Obsidian and optional Honcho

Operational references, provenance and the synchronization outbox are stored in SQLite.
Markdown in the configured Obsidian vault is authoritative and works without a network.
The optional Honcho v3 adapter adds semantic retrieval of explicitly permitted notes.
It does not run a Python sidecar or import Honcho server code.

## Configuration and composition

`config/memory.yaml` is versioned and Zod validated by `loadMemoryConfig`. Honcho is
disabled by default. Only `public` content is eligible initially; an administrator can
explicitly also allow `internal`. `confidential`, `restricted`, missing and unknown
classifications never leave the vault. Caller provenance must match the configured
company. Authentication is provided through the `resolveApiKey` callback, which should
resolve an existing SecretRef just before the request. Tokens are never serialized into
notes, the outbox, logs or browser state.

Compose an `ObsidianProvider` with `HonchoMemoryProvider` using
`HybridMemoryProvider({ db, local, semantic })`. The hybrid keeps the local provider's
`kind` (`obsidian`) so existing references remain readable. The application scheduler
calls `syncPending()`; no provider starts a hidden polling timer. `syncStatus()` reports
pending, failed, synchronized and pending-deletion counts. An unavailable Honcho does
not prevent a local write, read, search or export.

Managed endpoint: `https://api.honcho.dev`. A self-hosted endpoint is configurable;
local/private access requires `allowLocal: true`. The normal transport uses the existing
DNS-pinned SSRF guard; redirects are rejected so authorization cannot be forwarded to
another origin. Requests have a deadline, 256 KiB write limit and 1 MiB response limit.
Tests inject a transport and never contact a server.

## Provenance and privacy

`MemoryWriteInput.provenance` carries company, task, project, agent, source, confidence
and sensitivity. Obsidian serializes this safely into YAML frontmatter with creation
and update timestamps; multiline titles/tags cannot inject YAML fields. Pattern-based
secret redaction applies before hybrid local writes and again before external sends.
Pattern redaction cannot prove that arbitrary prose contains no sensitive information;
classification remains the gate. Do not classify sensitive customer documents as public.

Honcho maps each company to a distinct hashed workspace, owners to an `owner` peer,
and agents to distinct hashed peers. Every note has a stable isolated session containing
its task/project provenance. This permits retry and deletion without deleting other
project memories. No agent observes another agent by default. Automatic reasoning,
peer cards, summaries and dreaming are disabled: inferred owner preferences must not
be invented or survive deletion of a source note. This adapter provides semantic search
of attributed source messages; automatic cross-session personality inference is not
claimed as implemented.

Ordinary search remains local because its query has no sensitivity label. Explicit
`searchSemantic(query, sensitivity)` only transmits permitted query classifications,
merges/deduplicates results and falls back to local hits when Honcho fails. It suppresses
unknown locators, other companies, tombstones and files removed from the local vault.
Local search reads current files, so edits made in Obsidian are immediately visible.
`ObsidianProvider.watch()` detects edits without polling and calls
`HybridMemoryProvider.localChanged()` to requeue already classified notes. Revision
fences keep changes made during uploads pending for the next sync. Unknown files never
receive automatic external permission. Local content remains authoritative when opening
a result. The application owns watcher shutdown and surfaces watcher failures.

Before every semantic upload, the current file must still carry valid YAML
provenance matching the originally approved company, task, project, agent and
sensitivity. Missing, malformed or changed provenance revokes that transmission
grant: the old remote copy is deleted, with persistent retries on failure, while
the local document remains available. Semantic results are suppressed immediately
when the current provenance no longer authorizes them, even before the watcher or
synchronization runs; queued edits never return stale remote snippets. Restoring a
classification after successful revocation does not silently re-enroll the file.


## Recovery, forgetting and export

Migration 0026 adds a reference-only durable outbox. No full note body is duplicated in
SQLite. Bounded scheduler batches claim entries atomically and retry failures with
exponential backoff up to one hour. Uploads replace the note's deterministic session,
so a lost upload acknowledgement does not accumulate duplicate messages.

Deletion first persists a tombstone, then deletes the local file. The entry immediately
disappears from local reads/searches. Remote deletion retries across restarts and stays
visible in `pendingDeletion` until acknowledged. An in-flight upload cannot overwrite
that tombstone. This is eventual remote deletion, not a claim that an offline service
has already erased data. Honcho reasoning is disabled specifically to avoid retained
inferences outside that note's session.

`exportEntries()` exports caller-authorized locators from the canonical vault, excluding
forgotten entries, with limits of 1,000 entries and 10 MiB. The caller joins the existing
SQLite memory references to include provenance and enforces owner authorization.

## Verified API sources

The adapter was implemented against the official Honcho v3 REST documentation:

- [Workspace creation](https://honcho.dev/docs/v3/api-reference/endpoint/workspaces/get-or-create-workspace)
- [Session creation and configuration](https://honcho.dev/docs/v3/api-reference/endpoint/sessions/get-or-create-session)
- [Message creation](https://honcho.dev/docs/v3/api-reference/endpoint/messages/create-messages-for-session)
- [Semantic workspace search](https://honcho.dev/docs/v3/api-reference/endpoint/workspaces/search-workspace)
- [Session deletion](https://honcho.dev/docs/v3/api-reference/endpoint/sessions/delete-session)
- [Queue health](https://honcho.dev/docs/v3/api-reference/endpoint/workspaces/get-queue-status)

A live managed/self-hosted Honcho smoke test remains an operator step requiring an
explicitly configured endpoint and credentials. Mock transport tests verify actual
request paths, payloads, redaction, policy gates, retries and deletion semantics.
