# OpenRouter runtime

The runtime sends Chat Completions requests with `stream: true`. It normalizes
incremental text, client-tool requests/results, usage, errors and cancellation
onto IronCrew's persisted RunEvent protocol. The public protocol was checked
against OpenRouter's official documentation on 2026-09-05:

- [Streaming](https://openrouter.ai/docs/api_reference/streaming)
- [Client tools](https://openrouter.ai/docs/guides/features/tool-calling)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)

## Transport and failure handling

The SSE parser supports comments, multiline data fields, split UTF-8, and
CR/LF/CRLF framing. It requires a complete `[DONE]` marker and completion reason.
The final accounting frame can repeat the completion reason; this produces one
usage event per request and one terminal event per run. Truncated, malformed,
oversized and length-limited responses fail instead of becoming completed work.
HTTP and in-stream 429 responses become `rate_limit.detected` / `run.waiting`.
An HTTP `Retry-After` is carried forward as an absolute reset time when valid.

Cancellation aborts both the request and a waiting stream reader. The timeout
covers the full run, including body consumption and tool callbacks. An executor
must honor its supplied AbortSignal to terminate its underlying operation;
IronCrew also stops awaiting an unresponsive callback. Actual provider-side
billing cancellation depends on that provider, as documented by OpenRouter.

Every model request, including every tool continuation, retains the central
vendor/provider allowlist and privacy policy. Tool-enabled requests also set
`require_parameters: true`. No server-side OpenRouter plugins, arbitrary URLs,
provider fallback models or unregistered tools are enabled by this runtime.

## Client tools

An explicit `OpenRouterToolExecutor` supplies permitted definitions, authorization,
execution and a durable audit callback. No executor means no advertised tool
capability. Definitions use Zod schemas, from which the request's JSON Schema is
generated. Complete arguments are validated locally before authorization or
execution. Unknown names, duplicate IDs and malformed arguments fail closed.

Execution ordering is request audit → authorization → start audit → execution →
result audit. All normal tool events are also emitted for RunStore persistence.
An audit failure prevents subsequent execution. Approval-required calls emit the
normal `approval.required` event and park the run; they do not execute an action.
Tool results and audit payloads are redacted before they leave the runtime.

`createCompanyToolExecutor` provides scoped task list/read and memory search,
plus structured approval requests. It advertises only enabled, explicitly granted
registry tools. Company identity comes from RunContext, not model arguments.
Task results are checked again for company ownership. The application's memory
callback is responsible for applying the corresponding company/project scope.
The helper does not provide shell execution, network calls, business writes or
approval decisions. Native runners may inject a separate bounded workspace
executor with its own grants and durable audit implementation.

Approval identity is persisted in the existing `crew_approvals.proposed_action`
field as a versioned SHA-256 digest of company, task, project, agent, tool and
canonical JSON arguments. Run IDs, provider call IDs and object-key order do not
change the action. A current, unexpired approval permits only that exact call;
changed arguments or scope require another decision. Current registry grants are
rechecked even after approval. Rejected/cancelled calls remain denied. The normal
owner/quorum approval flow moves the parked `approval_required` task back to the
persistent queue, including after a restart. No schema migration is required.
The `approval_request` tool returns an approved receipt on continuation; it never
executes a deployment, payment or another external action. Repeated identical
read calls within that task may reuse the approval; this is not an exactly-once
write authorization mechanism.

Memory search checks company/task/project/agent scope and sensitivity against
both the operational reference and the current source frontmatter. Unknown or
missing classification is excluded from model-facing tool results. A vault edit
raising sensitivity therefore takes effect even before its database reference is
updated. Only explicitly scoped sensitive tasks may receive confidential notes.
Returned fields are bounded to the search-hit contract and redacted. Owner vault
search remains available for legacy notes without complete provenance.

Tool rounds are bounded: default 8, maximum 32. `RunInput.maxTurns` controls these
rounds; the response-token cap is a separate runtime option (default 4096).
Tools execute sequentially even if a provider returns multiple calls.

## Verification and limits

Tests use local ReadableStreams and injected transports, never paid provider
calls. They cover fragmented tool arguments, malformed/truncated streams,
UTF-8/framing, policy headers, scoped grants, approval deferral, audit failures,
secret redaction, cancellation, body/tool timeout and loop bounds.

OpenRouter API keys are not subscription OAuth tokens. Runner-side SecretRef
resolution is configured separately from this transport. A real provider call,
account quota, billing and company-specific grants still require verification in
the installed environment. Provider-native conversation/session resume is not
advertised; approval continuation uses IronCrew's task/review context.
