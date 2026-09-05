# Outbound native runner fleet

A fleet runner opens a persistent **outgoing WSS connection** to the control plane. It needs no inbound port, SSH access or mounted user home. The existing native-runner v2 protocol (including the usage acknowledgement that gates subsequent paid model rounds) is multiplexed over this connection. Unix sockets and the optional inbound mTLS runner remain available as separate deployment modes.

## Enable explicitly

On the control plane, enable the fleet feature and configure the dedicated TLS listener:

```dotenv
IRONCREW_RUNNER_MODE=fleet
IRONCREW_FLEET_HOST=127.0.0.1
IRONCREW_FLEET_PORT=9443
IRONCREW_FLEET_CERT_FILE=/etc/ironcrew/tls/fleet.crt
IRONCREW_FLEET_KEY_FILE=/etc/ironcrew/tls/fleet.key
```

Use an explicitly reachable bind address when connecting from another machine. The listener accepts only `/api/crew/fleet/connect`, uses TLS 1.3, and does not trust forwarded protocol headers. A production runner requires `wss:` with a valid server certificate and hostname. Development-only constructor injection permits loopback plaintext in tests; no environment option enables it in the native entry point.

The owner registers a worker in the command center or `POST /api/crew/fleet/enrollments` with a label, absolute non-root workspace, allowed runtime types, explicit project IDs, concurrency and priority. `allowUnscoped` must be enabled explicitly for tasks without projects. Project IDs must belong to the company. Scopes are immutable: revoke and register a replacement to change them.

Enrollment returns one token, valid for ten minutes by default (maximum fifteen), displayed once with `Cache-Control: no-store`. Send it to the dedicated runner operator through a suitable private channel. Do not paste it into URLs, source files or shell history. On the native runner, supply the token through its private service environment for initial enrollment:

```dotenv
IRONCREW_FLEET_URL=wss://control.example:9443/api/crew/fleet/connect
IRONCREW_FLEET_CREDENTIAL_FILE=/var/lib/ironcrew-runner/fleet-credential.json
IRONCREW_FLEET_ENROLLMENT_TOKEN=<one-time-token>
IRONCREW_FLEET_CA_FILE=/etc/ironcrew/tls/company-ca.crt
IRONCREW_RUNNER_WORKSPACE_ROOT=/var/lib/ironcrew/workspaces
```

Run `node --import tsx server/runner-main.ts` under the dedicated operating-system user. Existing `IRONCREW_RUNNER_SOCKET` or inbound TLS configuration must be removed when choosing outgoing fleet mode. `IRONCREW_RUNNER_TOKEN` is not needed in this mode. Publicly trusted server certificates do not need a custom CA file.

The runner writes its new credential atomically to the specified private file (0600); the parent directory must be owned and not writable by other users. Remove the enrollment token from the service environment after first use. Subsequent starts use the credential file. The server stores credential hashes, never plaintext or provider OAuth tokens. Credentials expire after thirty days and rotate during the final day with a two-minute old-credential grace window for interrupted rotation. An expired or lost credential requires a new owner-issued enrollment token. Revocation immediately closes the connection and invalidates credentials and pending enrollment tokens. A revoked worker must be replaced with a new registration.

The official Claude/Codex/Antigravity login and OpenRouter SecretRef resolution remain entirely on the native runner. The fleet credential authenticates this application protocol; it is not a provider credential.

## Routing and failure handling

Workers report actual capabilities, installation, health and authentication hints. Eligible workers must be connected, healthy, under capacity, and match the company, runtime, project and workspace scope. Selection is deterministic: lowest active lease count, then highest configured priority, then stable worker ID. A SQL task claim prevents duplicate simultaneous leases. `crew_runs.worker_id` records the chosen worker and the audit identifies the task, run, correlation and lease.

There is no silent fallback to another transport. Session continuation is pinned to the worker that owns the original persisted session. No filesystem or session migration is implied. Project workspace paths must already exist under the enrolled native root; CLI execution checks real paths and symlink escapes. Pure-text runtimes may use an empty workspace; filesystem tools still require project and explicit tool grants.

Heartbeats renew sixty-second execution leases. The runner requires replies and cancels local streams after forty-five seconds without control-plane responses. On disconnection, revocation or replacement connection, old logical streams close and the native server aborts their processes. A new generation fences stale events. Lost/revoked task leases remain unavailable for reassignment until their original deadline, allowing cancellation to drain. The same native server instance retains task locks across reconnects. No buffered start frames are replayed. On control-plane restart, previous online state and active leases are recovered as offline/lost; the ordinary durable scheduler may retry once the prior lease drains.

Model usage is still acknowledged only after the control plane processes the event. A budget hard stop cancels instead of acknowledging. Cancellation, disconnect and the existing usage-ack timeout stop the next tool/model round.

## Limits and verification

The fleet is single-control-plane infrastructure, not HA. It does not implement shared filesystem provisioning, automatic remote CLI installation, OAuth export, remote MCP enrollment, or dynamic migration of provider sessions between machines. Native workspace read/list tools use the existing explicit agent/project grants. Dedicated runner ownership, workspace permissions and application configuration remain operator responsibilities.

`server/ironcrew/runner/fleet/fleet.test.ts` runs real local TLS/WSS connections with temporary test certificates. It covers single-use enrollment, hash-only storage, TTL, rotation/revocation, normal task streaming, usage-ACK budget cancellation, scope/capacity/duplicate-claim rejection, reconnect generations and draining leases, credential persistence, and server-certificate rejection. No provider login or external paid call is used by these tests.
