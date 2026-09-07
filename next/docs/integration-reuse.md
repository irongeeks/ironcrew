# Integration adapters: implementation and evidence

Status: 2026-09-07. These are real HTTP/CLI adapters, tested with local fixtures; no customer account has been live validated. Connection configuration is administrative input and is never accepted from a model tool call. The control plane must persist the action, authorization, result evidence and effects journal. The service intentionally does not manufacture persistence or delivery evidence.

## Interface

`packages/integrations/src/index.ts` exports `IntegrationService`, `toolCapabilities`, `ProtonPassResolver`, `MailConnector`, `verifyTelegramInbound`, `verifyDiscordInbound`, `safeFetch` and `IntegrationError`.

The integration service requires an authorization callback and exact company/area/customer/project scope matching. It checks enabled capabilities, validates arguments, restricts selected resources and resolves a SecretRef immediately before the connector operation. Parallelism is limited to two requests per configured account. The control plane must ensure that two configurations do not duplicate the same account to bypass that limit. Reads get at most three attempts; Retry-After is honored, and long waits are returned for scheduling. Writes never retry automatically. Ambiguous write transport failures, malformed acknowledgments and server errors produce `effect_unknown`.

`effectStatus: accepted` means provider acceptance. It is not proof of delivery, a repaired service, an executed task or a bank payment. Adapter `evidenceRefs` are initially empty: the runtime stores immutable result evidence and adds those references. Every result records observation time. Full provider response data is preserved after secret redaction, including pagination and partial-payment facts, for domain validation.

Public source fetch resolves all addresses, refuses nonglobal addresses, pins the socket to a validated address and refuses redirects. A conservative IPv6 policy currently excludes the entire 2001 prefix. Internal systems use separately configured connectors. Environment settings are not inherited by Proton CLI calls; only an explicit broker allowlist is used. Model processes must never receive that broker environment.

## Reuse decisions

| Existing source                                                | Reused knowledge                                                              | New boundary                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `server/ironcrew/packs/integrations/sevdesk.ts`                | Bare Authorization token, Invoice/Voucher pagination and original status data | Action/scope authorization, separate writes, typed failures, effect ambiguity      |
| `server/ironcrew/packs/integrations/nextcloud.ts`              | Account WebDAV URL and Basic app-password auth                                | Conditional PUT, configured root, no traversal, version conflict                   |
| `server/ironcrew/packs/integrations/{tactical-rmm,proxmox}.ts` | Read paths and authentication formats                                         | Selected-resource restrictions, action authorization, Proxmox UPID                 |
| `server/ironcrew/search/brave-provider.ts`                     | Brave URL/query/header and result fields                                      | Timeout, bounded retry, response limits, no redirect, secret redaction             |
| `server/ironcrew/notify/*` and `mail/*`                        | Channel protocol patterns                                                     | Signed/raw-body verification, SMTP acceptance semantics, no automatic CEO identity |
| `server/ironcrew/secrets/protonpass-provider.ts`               | Stable share/item references                                                  | New exact CLI version/output contract; no stderr or inherited environment          |

No old policy, SSH worker, CLI harness or generic unrestricted endpoint dispatcher was imported.

## Current primary-source checks

- [Proton Pass agent contract](https://protonpass.github.io/pass-cli/commands/agent/): reason environment variable, scoped agents and two-hour sessions.
- [Proton Pass view command](https://protonpass.github.io/pass-cli/commands/contents/view/) and [pinned 2.3.3 implementation](https://github.com/protonpass/pass-cli/blob/2.3.3/pass-cli/src/commands/item/view.rs): selected fields print plain values, even when JSON is requested. The old JSON parser would misinterpret that output. New resolver requires `pass-cli 2.3.3` and removes exactly one output newline. Version checked from the current official GitHub release API on 2026-09-07. No CLI binary installed or real vault accessed in this test run.
- [Nextcloud WebDAV](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html): file operations and conditional requests. Local fixture verifies `If-Match` and HTTP 412.
- [Google Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads): multipart file creation. New predecessor versions are checked; the adapter creates a new file instead of overwriting after a nonatomic check. Native Google documents are explicitly refused by this binary-file capability.
- [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started): search path and subscription-token header. Search and source retrieval remain separate.
- [Tactical RMM API](https://docs.tacticalrmm.com/functions/api/): API key permissions, trailing slashes and installed Swagger. Script execution needs installation-specific payload validation before enabling it for a real account.
- [Microsoft Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0): 202 indicates acceptance, not delivery.
- [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook) and [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding): Telegram secret header and Discord Ed25519 raw-body signature.
- The original sevdesk OpenAPI URL initially returned HTTP 403. The official `https://api.sevdesk.de/openapi.yaml?format=yaml` endpoint subsequently provided schema version 2.0.0; the used operation/schema structures and source SHA-256 are retained in `packages/integrations/fixtures/sevdesk-openapi-2.0.0.json`. This revealed distinct top-level Voucher, VoucherLog, Invoice and Email responses, now explicitly validated. Proxmox API-viewer retrieval failed, so its package/local-source contracts remain provisional until target validation.

## Deliberate remaining work

The domain must enforce fresh payment state before reminder dispatch, deduplicate receipts/reminder stages, reconcile unknown sends, persist inbox/outbox identities and binding challenges, perform lead/CEO decisions, and store artifacts. These are not inferred from HTTP success. The service implements voucher upload, `sevdesk.voucher.stage` via saveVoucher with fixed draft status 50, `sevdesk.voucher.book` with an explicitly scoped account and existing transaction, and reminder draft/send. Tax/accounting fields follow the selected account version; target-level contract validation is still required. Google Drive native Docs/Sheets/Slides editing, Graph nonmail administration beyond license assignment, automatic OAuth refresh and banking imports are not provided here. IMAP currently reads message envelopes, not attachment ingestion or trusted approval identity. SMTP/IMAP code has no live account acceptance test yet.

## Automated evidence

`node node_modules/vitest/vitest.mjs run tests/contracts/integrations-http.test.ts tests/contracts/integrations-git.test.ts tests/unit/integrations-security.test.ts tests/unit/integrations-broker.test.ts`: 50 tests passed. Includes real loopback HTTP server request assertions, sevdesk draft/book/reminder schema contracts, timeouts, bounded retry, ETag conflict, Drive copy/version check, Proxmox task acceptance, Graph acceptance, malformed Telegram acknowledgment, tenant/resource denial, secret redaction, public-IP checks, webhook signature/replay checks, pinned CLI fixtures, real isolated Git commits and local bare-remote pushes, and typed servicebroker argv fixtures.

`node node_modules/eslint/bin/eslint.js packages/integrations tests/contracts/integrations-http.test.ts tests/unit/integrations-security.test.ts`: passed. Native TypeScript import is checked separately; no parameter properties are used.

## Git delivery

`GitConnector` uses an injected `GitActionPort` compatible with real `ManagedActions`. `stage` creates a detached worktree and a commit under the exclusively owned `refs/heads/ironcrew/<target-id>` branch, checks all expected file hashes before writes, then advances that ref using compare-and-swap. The caller's checked-out branch is never advanced. `push` requires concrete approval, checks the configured remote URL and expected remote revision, uses a lease and verifies the resulting remote commit. A timed-out/uncertain push remains unknown. Commands use `execFile` argument arrays, disable hooks/external filters/credential helpers/global Git config, never inherit model process environment, and keep auth headers in broker environment only. HTTPS and explicitly allowed local test remotes are supported; SSH credentials need a separately verified connector profile. Bare-remote fixture tests perform actual commits and pushes only inside temporary local test directories. No workspace source commit, public push or external message was sent by this implementation session.

## Control/runtime wiring

`apps/control/configuration.ts` accepts administrative `gitConnections` and `serviceTargets` arrays with exact scopes and absolute native paths. Local workflows use the persistent `ManagedActions` broker even when neither OpenRouter nor Proton is configured; `liveExecutionEnabled` must be true. The model runtime exposes `git.stage`, `git.push` and the six native service verbs through the same configured clients. Runtime tool arguments contain `targetId`, `targetConfigSha256` and typed `parameters`. Tool descriptions provide the configured fingerprint and destination only for the current exact company/area/customer/project scope. Push and restart require concrete approvals; a changed configuration fingerprint invalidates approval replay. Native restart acceptance still requires a separate functional check.

Research Git delivery now runs a durable two-step flow: create a real report commit under the owned Git branch, persist its commit/action IDs, then request approval for the exact push. Delivery input uses `expectedRevision` for the local base commit, optional `path`, `expectedFileSha256` and `expectedRemoteHead` (null for a new remote branch). Approval replay reuses the saved commit and action ID instead of producing another report commit. Unknown stage/push outcomes remain blocked for reconciliation. A configured existing repository with an initial commit is required; the workflow never invents or clones a repository destination.

`tests/integration/git-broker-control.test.ts` adds seven control integration tests: real temporary Git/bare-remote research delivery and replay, scope/configuration validation, actual fixture native-process execution behind service approval, configuration-change invalidation, and unknown restart deduplication. The native fixture verifies the command/approval boundary; it is not a claim of a Docker/systemd/Windows installation test.
