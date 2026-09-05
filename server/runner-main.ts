/**
 * IronCrew runner — the process that holds the CLI logins.
 *
 * Started by its own systemd unit, under its own OS user, with that user's
 * officially stored CLI credentials. The control plane connects over a Unix
 * socket and receives capabilities, status and normalised events — never a
 * token (docs/RUNNER_PROTOCOL.md, docs/THREAT_MODEL.md T-05).
 *
 * It also hosts the MCP servers whose credentials are SecretRefs. Same
 * reason: resolving a vault item in the control plane would only move the
 * plaintext from the database into the process this project keeps
 * credential-free (mcp-secrets.ts, T-17). The runner has the vault session —
 * it is this user's keychain, this user's `bw login` — so it is the one place
 * where resolving is not a step backwards.
 *
 * Deliberately tiny. It wires up the same CLI adapters and the same secret
 * providers the control plane would have used, hands them to the daemon, and
 * gets out of the way; everything worth testing lives in runner-server.ts,
 * mcp-host.ts and runner-daemon.ts, which need no socket to test.
 */

import path from "node:path";
import process from "node:process";
import os from "node:os";
import { OpenRouterRuntime } from "./ironcrew/runtime/openrouter-runtime.ts";
import type { AgentRuntime } from "./ironcrew/runtime/run-events.ts";
import { RunnerSecretRuntime, parseRunnerSecretRef } from "./ironcrew/runner/secret-runtime.ts";
import { RunnerWorkspaceTools } from "./ironcrew/runner/workspace-tools.ts";
import { createAdapterRegistry, isCliAdapter } from "./adapters/index.ts";
import { CliAdapterRuntime } from "./ironcrew/runtime/cli-adapter-runtime.ts";
import { TlsRunnerDaemon } from "./ironcrew/runner/tls-runner-daemon.ts";
import { runnerTlsListenerFromEnv } from "./ironcrew/runner/transport.ts";
import { OutboundRunner } from "./ironcrew/runner/fleet/outbound.ts";
import { readFile } from "node:fs/promises";
import { RunnerDaemon } from "./ironcrew/runner/runner-daemon.ts";
import { LocalMcpHost } from "./ironcrew/runner/mcp-host.ts";
import { VaultwardenSecretProvider } from "./ironcrew/secrets/vaultwarden-provider.ts";
import { ProtonPassSecretProvider } from "./ironcrew/secrets/protonpass-provider.ts";
import { KeychainSecretProvider } from "./ironcrew/secrets/keychain-provider.ts";
import { SecretResolutionError, type SecretProvider } from "./ironcrew/secrets/secret-provider.ts";
import type { SecretRef } from "./ironcrew/secrets/secret-ref.ts";
import { logger } from "./observability/logger.ts";

const log = logger.child({ module: "ironcrew-runner" });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    // Refusing to start beats starting with a default: an unauthenticated
    // runner or one rooted at "/" is worse than one that is simply not there.
    log.fatal(`${name} is required. The runner will not start without it.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const tlsOptions = runnerTlsListenerFromEnv();
  const socketPath = process.env.IRONCREW_RUNNER_SOCKET ?? "/run/ironcrew/runner.sock";
  if (tlsOptions && process.env.IRONCREW_RUNNER_SOCKET) throw new Error("Choose Unix or TLS listener, not both.");
  const outboundUrl = process.env.IRONCREW_FLEET_URL;
  if (outboundUrl && (tlsOptions || process.env.IRONCREW_RUNNER_SOCKET))
    throw new Error("Choose outbound fleet or a runner listener.");
  const token = outboundUrl ? "" : required("IRONCREW_RUNNER_TOKEN");
  const workspaceRoot = path.resolve(required("IRONCREW_RUNNER_WORKSPACE_ROOT"));

  const adapters = createAdapterRegistry();
  const runtimes: AgentRuntime[] = adapters
    .list()
    .filter(isCliAdapter)
    .map((adapter) => new CliAdapterRuntime(adapter));

  if (runtimes.length === 0) {
    // Not fatal: an operator who has not logged into any CLI yet should still
    // see a running daemon reporting "nothing available" rather than a unit
    // that refuses to start for reasons they have to dig for.
    log.warn("no CLI adapters available — the runner will report an empty runtime list");
  }

  // The same three providers the control plane registers, for the same
  // reason: which one actually works is decided by testConnection() at use
  // time, not by guessing here.
  const providers = new Map<SecretRef["provider"], SecretProvider>();
  for (const provider of [
    new VaultwardenSecretProvider({ serverUrl: process.env.VAULTWARDEN_SERVER_URL }),
    new ProtonPassSecretProvider(),
    new KeychainSecretProvider(),
  ]) {
    providers.set(provider.kind, provider);
  }

  const secretRef = parseRunnerSecretRef(process.env.IRONCREW_OPENROUTER_SECRET_REF);
  const toolExecutor = new RunnerWorkspaceTools(
    process.env.IRONCREW_RUNNER_TOOL_AUDIT ??
      path.join(os.homedir(), ".local", "state", "ironcrew", "tool-audit.ndjson"),
  );
  const createOpenRouter = (apiKey: string) =>
    new OpenRouterRuntime({
      apiKey,
      defaultModel: process.env.OPENROUTER_DEFAULT_MODEL,
      toolExecutor,
    });
  runtimes.push(
    new RunnerSecretRuntime({
      runtimeType: "openrouter",
      secretRef,
      providers,
      createRuntime: createOpenRouter,
      capabilities: await createOpenRouter("").capabilities(),
    }),
  );

  const mcp = new LocalMcpHost({
    resolveSecret: async (ref) => {
      const provider = providers.get(ref.provider);
      if (!provider) throw new SecretResolutionError(`Kein Secret-Provider für "${ref.provider}" auf dem Runner.`);
      return provider.resolve(ref);
    },
  });

  const daemon = outboundUrl
    ? new OutboundRunner({
        url: outboundUrl,
        credentialFile: required("IRONCREW_FLEET_CREDENTIAL_FILE"),
        enrollmentToken: process.env.IRONCREW_FLEET_ENROLLMENT_TOKEN,
        workspaceRoot,
        runtimes,
        ca: process.env.IRONCREW_FLEET_CA_FILE ? await readFile(process.env.IRONCREW_FLEET_CA_FILE) : undefined,
        onStatus: (status) => log.info({ status }, "fleet connection"),
      })
    : tlsOptions
      ? new TlsRunnerDaemon({ tls: tlsOptions, token, workspaceRoot, runtimes, mcp })
      : new RunnerDaemon({ socketPath, token, workspaceRoot, runtimes, mcp });
  if (daemon instanceof OutboundRunner) await daemon.start();
  else await daemon.listen();
  delete process.env.IRONCREW_FLEET_ENROLLMENT_TOKEN;

  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log.info({ signal }, "runner shutting down");
      void daemon.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "runner failed to start");
  process.exit(1);
});
