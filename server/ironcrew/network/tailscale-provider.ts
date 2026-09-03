/**
 * IronCrew — Tailscale (or a Tailscale-protocol-compatible self-hosted
 * control server, e.g. Headscale) status wrapper.
 *
 * This wraps the standard `tailscale` CLI, not a specific coordination
 * server — the same client talks to Tailscale's own SaaS control plane or
 * to a self-hosted Headscale instance depending only on which
 * `--login-server` the node was brought up with (an operator concern, done
 * once, out of band; this class only reads status, it never runs
 * `tailscale up`). That is deliberate: it is the natural way to satisfy
 * both halves of "Tailscale, or something similar, ideally open source or
 * self-hosted" — the client CLI and its command surface stay identical
 * either way.
 *
 * `tailscale status --json`'s field names (BackendState, Self, Peer,
 * HostName, DNSName, TailscaleIPs, Online) are stable, documented parts of
 * the CLI's output, but this wrapper has not been exercised against a real
 * `tailscale`/`headscale` install in this environment (neither is
 * installed here) — verify against a real tailnet before relying on it in
 * production. Follows this project's established CLI-wrapping pattern
 * (argv-array spawning via shared/cli-runner.ts, timeouts,
 * dependency-injected runner for tests).
 */

import { type CliRunner, spawnCliRunner } from "../shared/cli-runner.ts";

export class TailscaleError extends Error {}

export interface TailscalePeer {
  id: string;
  hostName: string;
  dnsName: string;
  tailscaleIPs: string[];
  online: boolean;
  os: string;
}

/** This node's own tailnet identity — structurally the same shape as a peer, since that's what it is to every other node. */
export type TailscaleSelf = TailscalePeer;

export interface TailscaleStatus {
  /** e.g. "Running", "Stopped", "NeedsLogin". */
  backendState: string;
  self: TailscaleSelf | null;
  peers: TailscalePeer[];
}

export interface TailscaleConnectionStatus {
  ok: boolean;
  /** Human-readable, never a key or token. */
  message: string;
}

interface RawPeer {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  OS?: string;
}

interface RawStatus {
  BackendState?: string;
  Self?: RawPeer;
  Peer?: Record<string, RawPeer>;
}

function mapPeer(raw: RawPeer): TailscalePeer {
  return {
    id: raw.ID ?? "",
    hostName: raw.HostName ?? "",
    dnsName: raw.DNSName ?? "",
    tailscaleIPs: raw.TailscaleIPs ?? [],
    online: raw.Online ?? false,
    os: raw.OS ?? "",
  };
}

export interface TailscaleProviderOptions {
  /** Path to the `tailscale` binary. Defaults to "tailscale" (resolved via PATH). */
  tailscalePath?: string;
  timeoutMs?: number;
  run?: CliRunner;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class TailscaleProvider {
  private readonly tailscalePath: string;
  private readonly timeoutMs: number;
  private readonly run: CliRunner;

  constructor(opts: TailscaleProviderOptions = {}) {
    this.tailscalePath = opts.tailscalePath ?? "tailscale";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = opts.run ?? spawnCliRunner;
  }

  async status(): Promise<TailscaleStatus> {
    const res = await this.run([this.tailscalePath, "status", "--json"], { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      throw new TailscaleError(`tailscale status failed — ${res.stderr.trim() || "unknown error"}`);
    }
    let parsed: RawStatus;
    try {
      parsed = JSON.parse(res.stdout) as RawStatus;
    } catch {
      throw new TailscaleError("could not parse 'tailscale status --json' output");
    }
    return {
      backendState: parsed.BackendState ?? "Unknown",
      self: parsed.Self ? mapPeer(parsed.Self) : null,
      peers: Object.values(parsed.Peer ?? {}).map(mapPeer),
    };
  }

  async testConnection(): Promise<TailscaleConnectionStatus> {
    try {
      const status = await this.status();
      if (status.backendState !== "Running") {
        return { ok: false, message: `tailscale backend: ${status.backendState}` };
      }
      const addr = status.self?.tailscaleIPs[0];
      return {
        ok: true,
        message: status.self ? `verbunden als ${status.self.hostName}${addr ? ` (${addr})` : ""}` : "verbunden",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
