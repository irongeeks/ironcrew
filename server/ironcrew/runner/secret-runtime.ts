/** A credential exists only while a single native-runner job is executing.
 * The control plane sends the task, never a key or a vault session. A fresh
 * lookup per run makes rotation effective without restarting either process.
 */
import { z } from "zod";
import { newId } from "../domain/ids.ts";
import { redact, redactValue } from "../security/redaction.ts";
import type { SecretRef } from "../secrets/secret-ref.ts";
import type { SecretProvider } from "../secrets/secret-provider.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
} from "../runtime/run-events.ts";

const secretRefSchema = z
  .object({
    provider: z.enum(["keychain", "protonpass", "vaultwarden"]),
    itemRef: z.string().trim().min(1).max(1024),
    field: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export function parseRunnerSecretRef(raw: string | undefined): SecretRef | null {
  if (!raw?.trim()) return null;
  try {
    return secretRefSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("IRONCREW_OPENROUTER_SECRET_REF must be a JSON SecretRef, never a plaintext key.");
  }
}

export interface RunnerSecretRuntimeOptions {
  runtimeType: string;
  secretRef: SecretRef | null;
  providers: ReadonlyMap<SecretRef["provider"], SecretProvider>;
  /** A new short-lived runtime per invocation. The key never becomes a field here. */
  createRuntime: (key: string) => AgentRuntime;
  capabilities: RuntimeCapabilities;
}

export class RunnerSecretRuntime implements AgentRuntime {
  readonly id: string;
  readonly type: string;
  private readonly active = new Map<string, { controller: AbortController; runtime?: AgentRuntime }>();
  constructor(private readonly opts: RunnerSecretRuntimeOptions) {
    this.type = opts.runtimeType;
    this.id = `runner-secret:${this.type}`;
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    return this.opts.capabilities;
  }
  async authStatus(): Promise<AuthStatus> {
    const ref = this.opts.secretRef;
    const provider = ref ? this.opts.providers.get(ref.provider) : undefined;
    if (!ref || !provider)
      return {
        authenticated: false,
        verification: "unverified",
        method: "api-key",
        detail: "Kein verwendbarer SecretRef auf dem nativen Runner konfiguriert.",
        setupHint: "IRONCREW_OPENROUTER_SECRET_REF im Runner konfigurieren und dessen Tresor anmelden.",
      };
    // A vault probe establishes vault availability, not API-key validity.
    // Do not resolve a credential simply because somebody opened Settings.
    try {
      const status = await provider.testConnection();
      return {
        authenticated: false,
        verification: "unverified",
        method: "api-key",
        detail: status.ok
          ? "Runner-Tresor erreichbar; API-Schlüssel wird erst für einen Run aufgelöst."
          : "Runner-Tresor nicht erreichbar oder nicht angemeldet.",
      };
    } catch {
      return {
        authenticated: false,
        verification: "unverified",
        method: "api-key",
        detail: "Runner-Tresorprüfung fehlgeschlagen.",
      };
    }
  }
  async healthCheck(): Promise<RuntimeHealth> {
    const ref = this.opts.secretRef;
    const provider = ref ? this.opts.providers.get(ref.provider) : undefined;
    let healthy = false;
    if (provider) {
      try {
        healthy = (await provider.testConnection()).ok;
      } catch {
        healthy = false;
      }
    }
    return {
      installed: true,
      healthy,
      checkedAt: Date.now(),
      detail: healthy
        ? "Nativer Adapter und Tresor erreichbar; API-Verbindung wird beim Run geprüft."
        : "SecretRef oder Tresor-Anmeldung auf dem Runner fehlt.",
    };
  }
  async cancelRun(runId: string): Promise<void> {
    const job = this.active.get(runId);
    job?.controller.abort();
    await job?.runtime?.cancelRun(runId);
  }
  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (context.signal?.aborted) controller.abort();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const job: { controller: AbortController; runtime?: AgentRuntime } = { controller };
    this.active.set(context.runId, job);
    let key = "";
    let resolved = false;
    try {
      if (controller.signal.aborted) {
        yield terminal(context, "run.cancelled", "Vor dem Start abgebrochen.");
        return;
      }
      const ref = this.opts.secretRef;
      const provider = ref ? this.opts.providers.get(ref.provider) : undefined;
      if (!ref || !provider) {
        yield terminal(context, "run.failed", "Runner-SecretRef ist nicht konfiguriert.");
        return;
      }
      key = await provider.resolve(ref);
      if (key.length < 8) {
        yield terminal(context, "run.failed", "Runner-Tresor lieferte keinen verwendbaren API-Schlüssel.");
        return;
      }
      resolved = true;
      if (controller.signal.aborted) {
        yield terminal(context, "run.cancelled", "Während der Tresorabfrage abgebrochen.");
        return;
      }
      const known = [...(context.redactValues ?? []), key];
      job.runtime = this.opts.createRuntime(key);
      for await (const event of job.runtime.startRun(input, {
        ...context,
        signal: controller.signal,
        redactValues: known,
      })) {
        const payload = redactValue(event.payload, known);
        const changed = JSON.stringify(payload) !== JSON.stringify(event.payload);
        yield {
          ...event,
          payload,
          redaction: {
            redacted: event.redaction.redacted || changed,
            rules: [...event.redaction.rules, ...(changed ? ["runner_secret"] : [])],
          },
        };
      }
    } catch (err) {
      // A failing provider may include stdout in its exception: before we
      // know the value, there is no safe literal-based redaction of that text.
      const detail = resolved
        ? redact(err instanceof Error ? err.message : String(err), [key]).text
        : "Secret konnte auf dem Runner nicht aufgelöst werden.";
      yield terminal(context, controller.signal.aborted ? "run.cancelled" : "run.failed", detail);
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      this.active.delete(context.runId);
      job.runtime = undefined;
      key = ""; // JS strings cannot be zeroized; release all retained references.
    }
  }
}

function terminal(context: RunContext, type: "run.failed" | "run.cancelled", message: string): RunEvent {
  return {
    eventId: newId("evt"),
    companyId: context.companyId,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    correlationId: context.correlationId,
    timestamp: Date.now(),
    seq: 0,
    type,
    payload: { message },
    redaction: { redacted: false, rules: [] },
  };
}
