# Roadmap

The authoritative requirement-by-requirement view is
[MASTER_PROMPT_COVERAGE.md](MASTER_PROMPT_COVERAGE.md). Historical phase completion
labels described narrower milestones and are not evidence that the entire master
prompt is implemented, integrated and accepted.

## Current work: complete and verify the integrated product

The branch `feature/company-os-completion` extends the merged modern Office/CEO
workflow with the outbound runner fleet, concrete sandbox access and approval
consumption, character media/3D, coaching/evaluation, project planning, native service
installation and production verification. These changes need a final consolidated
CI and browser run after integration; individually present modules are not equivalent
to a completed end-to-end product acceptance.

The new platform workflow covers Linux/macOS native tests, migration/recovery,
portable installation definitions, a booted production Docker image, persistent
private figures/vault/attachments, backup restore and production dependency evidence.
No actual operating-system services or production accounts are installed by these tests.

## Next: acceptance on the operator's host

1. Install official Claude/Codex/Antigravity tools as the dedicated runner account;
   use the official login mechanism and verify the installed CLI's actual capabilities.
2. Complete CEO → EA → task → real CLI → streamed events → review → revision/resume,
   including cancellation, cooldown and recovery after restart.
3. Verify the responsive office, selectable figures and optional 3D view with the
   real crew, while retaining keyboard navigation, DOM details and Reduced Motion.
4. Rehearse backup restore to an isolated directory/host; prove that tasks, events,
   uploaded characters, vault and attachments survive and that encrypted stored
   credentials still decrypt using the original secret.
5. Configure and test optional outbound WSS fleet nodes or the separate native mTLS
   endpoint, Honcho, OIDC, MCP, mail and business
   integrations one at a time with controlled test data. Productive external writes
   remain subject to the appropriate owner approvals.

## Remaining product expansion

- Complete any remaining administrator-editable abstract routing profiles and
  versioned policy/configuration editors, with tests for every external boundary.
- Connect real MSP, agency and finance data sources before exposing their KPIs as
  business facts. Forecasts require measured inputs and traceable assumptions.
- Extend business-pack write workflows only with concrete adapters, idempotency,
  audit and approvals; feature flags must not disguise fake integration success.
- Expand agent evaluations with operator-supplied objective cases and reviewed
  coaching changes. No autonomous self-promotion or unreviewed core-code modification.
- Expand semantic conversational reasoning only with explicit provenance, privacy
  policy and deletion semantics. Honcho source search is available; automatic
  personality inference remains disabled.

## Optional later infrastructure

PostgreSQL, HA, more extensive multi-company operations and additional secret/memory
adapters remain separate design and acceptance projects. They are not prerequisites
for the local single-owner installation and are not claimed implemented merely
because a provider interface or roadmap entry exists.

Inherited custom-license dependencies, especially Remotion, require separate review
before commercial deployment. The CI inventory baseline detects changes; it does not
license the software on behalf of the operator.
