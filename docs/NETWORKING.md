# Networking: Tailscale/Headscale + remote workers

IronCrew can reach machines outside its own host — a Tier0 environment, a
customer's network — over a private mesh network (a "tailnet"), and act
inside them over SSH. Two pieces make this work, both following this
project's established safe-CLI-wrapping pattern (argv-array spawning,
timeouts, dependency-injected runner for tests — see
`server/ironcrew/shared/cli-runner.ts`):

- **Tailscale status** (`server/ironcrew/network/tailscale-provider.ts`) —
  read-only visibility into this node's own tailnet membership and its
  reachable peers.
- **Remote workers** (`server/ironcrew/domain/remote-worker-store.ts`) — a
  registry of SSH connection targets, reached over the tailnet, that
  reuses the existing SSH connector
  (`server/modules/workflow/ssh/ssh-connector.ts`) rather than inventing a
  second one.

## Choosing a coordination server

The wrapper talks to the standard `tailscale` CLI, not to a specific
coordination server — the same client works against:

- **Tailscale's own SaaS control plane** (the default, easiest to start
  with, free for small tailnets), or
- **[Headscale](https://github.com/juanfont/headscale)**, an open-source,
  self-hosted, protocol-compatible reimplementation of that control
  server — the natural fit if you want the whole stack self-hosted.

Which one a node uses is decided once, out of band, when it joins the
tailnet (`tailscale up --login-server=https://your-headscale.example.com`
for Headscale, or no flag for Tailscale's own SaaS). IronCrew never runs
`tailscale up` itself — it only reads status via `tailscale status --json`
(`GET /api/crew/tailscale`, the Settings → Netzwerk panel's "Dieser
Knoten" / "Tailnet-Peers" sections).

## Registering a remote worker

A remote worker is an SSH target — typically a Tier0 box or a machine
inside a customer's network that has joined the same tailnet. Register one
in Settings → Netzwerk → "Neuer Remote Worker":

| Field                  | Meaning                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Label                  | A short identifier, unique per company (e.g. `tier0-acme`).                                                                                                                                                                                |
| Umgebung (environment) | A free-text tag (e.g. `tier0`, `customer:acme`) — not enforced, just for the operator's own use.                                                                                                                                           |
| Tailnet-Host           | The worker's tailnet IP or `*.ts.net` hostname — so SSH traffic to it never leaves the tailnet.                                                                                                                                            |
| SSH-Benutzer           | The SSH user IronCrew connects as.                                                                                                                                                                                                         |
| Pfad zum Schlüssel     | A filesystem path **on the IronCrew server** to the private key — never the key material itself; nothing key-shaped is ever stored in the database, the same convention `server/modules/workflow/ssh/types.ts`'s `SshConfig` already uses. |
| Known-Hosts-Richtlinie | `strict` (default) verifies the host key; `accept` skips that check — only use `accept` for a worker you've already verified out of band.                                                                                                  |

"Testen" runs a real SSH connectivity check (`ssh -o ConnectTimeout=5 ... echo ok`)
through the tailnet and reports honestly whether it succeeded — the same
`SshConnectorInterface.testConnection()` the rest of the codebase's SSH
tooling uses, nothing invented for this feature.

## What this does _not_ do yet

Registering a remote worker makes it reachable and lets an operator verify
that reachability. It does not yet route an agent's task _execution_ to a
specific remote worker (i.e. there is no `RemoteWorkerRuntime` implementing
the `AgentRuntime` contract that runs a CLI adapter's command over SSH
instead of a local `spawn()`). That is the natural next increment, built on
the same `SshConnectorInterface.exec()` this registry already validates
connectivity through — tracked as a follow-up, not claimed here.
