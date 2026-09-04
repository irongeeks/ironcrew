# Change proposals

An agent that can write files can write any file. That makes every
file-touching capability an all-or-nothing trust decision, which is why such
capabilities stay switched off.

A change proposal is the missing middle state: the agent produces the **exact
content** it wants written, the owner sees paths and contents, and **nothing
reaches the disk until the proposal's approval is approved**.

## The shape of it

```text
  crew_change_proposals        one proposal: title, workspace root, status
        │  1:n
  crew_change_proposal_files   path, operation, content, expected hash
        │
  crew_approvals               the gate — no approval, no write
```

A proposal and its `ApprovalRequest` are created together and decided
together. They are two halves of one thing: a proposal without an approval is
a change nobody gated, and an approval without a proposal is a decision about
nothing.

## Proposing

`CompanyOrchestrator#proposeChanges()` raises an approval of type
`file_change` with `riskLevel: "high"`, an impact line naming how many files
in which workspace, and a rollback plan that is simply the truth:

```text
Die Freigabe verweigern; ohne Freigabe wird nichts geschrieben.
```

The approval's `proposedAction` lists **paths and operations, never
contents** — a summary an owner skims should say what would be touched, and
the contents are one click away in `GET /api/crew/change-proposals/:id`.

The proposal is then created, a notification goes into the decision inbox and
out to every notification channel, and the work stops there until someone
decides.

Every path is validated **before any row is written**: a title is required, at
least one file is required, the same path may not be proposed twice, every
path must resolve inside the workspace, and a `create` or `update` without
content is refused. A rejected proposal leaves nothing behind.

`expectedSha256` is optional per file. Omitted, it is read from disk at
proposal time — which is right when the agent has just looked at the file, and
wrong if a long time has passed since. A caller that knows what it read should
say so.

## The four rules the store enforces

### 1. No approval, no apply — and there is no force flag

`apply()` refuses unless the proposal is `approved`. There is deliberately no
force flag and no "apply anyway" parameter, because a gate with a bypass is
not a gate.

The orchestrator additionally **re-reads the approval** rather than trusting
the proposal row: a decision that was reversed, expired or cancelled after the
proposal was marked approved must stop the write, and the approval is where
that lives.

### 2. The expected hash must still match at apply time

Every file carries the hash it had when the proposal was made. At apply time:

- an `update` or `delete` whose file is **gone** is refused,
- an `update` whose current hash **differs** from `expected_sha256` is refused,
- a `create` whose file now **exists** is refused — "create" that quietly
  overwrites is a different act from the one that was approved.

Without this, an approval granted an hour ago silently clobbers every edit
made since, by a person, by another agent, or by a `git pull`. The owner
approved a change against a state of the world; if the world moved, the
approval no longer describes what would happen, so it has stopped being an
approval. Refusing is the only honest outcome.

### 3. Path containment is re-checked at apply

`workspace_path` is the root every file must resolve inside, and containment
is tested **at apply time as well as at proposal time** — not once, when the
proposal was created and the tree looked different.

Absolute paths are refused outright. `..` is caught by resolving the path
against the root and comparing prefixes. And then the check that the string
test cannot make: the **real path of the containing directory** is resolved
with `realpath` and compared against the real root. That is what catches a
**symlinked directory** pointing out of the tree — a path that looks contained
in every character and writes somewhere else.

`..`, absolute paths and symlink escapes are all the same failure: outside the
root.

### 4. All or nothing

Files are validated first, written second. A proposal that would half-apply is
refused **before the first write**, so one conflicting file means nothing at
all is written — not even the files that would have applied cleanly.

The proposal moves to `failed`, `apply_error` records every conflict, and the
response names them:

```json
{
  "proposal": { "id": "chg_…", "status": "failed" },
  "applied": [],
  "conflicts": [
    { "path": "src/app.ts", "reason": "Datei wurde seit dem Vorschlag geändert; …" }
  ]
}
```

A failed proposal is not retried in place. The agent proposes again against
the world as it now is, and the owner decides again — which is the point:
the second decision is about the second state of the world.

## Applying is idempotent

Applying an already-applied proposal is a **no-op**, not a second write: it
returns the proposal with an empty `applied` list and no conflicts. A retry
after a timeout, a double click, or a repeated call from a caller that lost
its answer cannot write anything twice.

## Statuses

| status       | meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| `pending`    | proposed, waiting on the owner. Only a pending proposal can be decided |
| `approved`   | decided yes; may now be applied                               |
| `rejected`   | decided no; nothing will ever be written                      |
| `applied`    | written, with `applied_at`, `applied_by` and per-file hashes  |
| `failed`     | apply refused; `apply_error` says why, and nothing was written |
| `superseded` | overtaken by a newer proposal for the same work               |

`supersede()` keeps the row rather than deleting it — what was proposed and
why it was dropped is part of the record — and refuses on an `applied`
proposal, which already happened and cannot be un-proposed.

## What the audit log records, and what it never does

| action                          | details recorded                          |
| ------------------------------- | ------------------------------------------ |
| `change_proposal.created`       | title, and `operation:path` for each file  |
| `change_proposal.approved`      | title, reason                              |
| `change_proposal.rejected`      | title, reason                              |
| `change_proposal.applied`       | title, the paths written                   |
| `change_proposal.apply_failed`  | the conflicting paths and the reason       |
| `change_proposal.superseded`    | title                                      |

The lifecycle is fully recorded; **file contents never are**. An audit log is
not a place to duplicate a repository, and a log that carried the contents
would become a second copy of the thing it exists to describe — including of
whatever was in those files.

## Endpoints

```http
GET  /api/crew/change-proposals                  # optional ?status=pending
GET  /api/crew/change-proposals/:id              # → { proposal, files }
POST /api/crew/change-proposals/:id/decision     { "decision": "approved" | "rejected", "reason"?: "…" }
POST /api/crew/change-proposals/:id/apply        # → { proposal, applied, conflicts }
```

`GET /api/crew/change-proposals/:id` is the only place file contents are
served, and the only endpoint that answers the question the owner actually has
before deciding: what exactly would be written.

`/decision` moves the approval and the proposal together, so the two can never
disagree about whether a change was authorised, and broadcasts both
`crew_change_proposal_changed` and `crew_approval_changed`.

A refusal answers **409 `change_proposal_refused`** with the reason — 409
rather than 400 because the request was well-formed and the *gate* is what
said no. Refusing to write is the feature.

See `THREAT_MODEL.md` **T-15**.
