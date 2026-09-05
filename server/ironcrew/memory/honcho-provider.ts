/** Original Honcho v3 adapter, based on official REST documentation (see docs/MEMORY.md).
 * No Honcho server code or SDK is copied. Only explicitly classified, redacted notes
 * are replicated. Reasoning is disabled: deleting a session must not leave inferred facts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { safeFetch } from "../../security/safe-fetch.ts";
import { redactText } from "../security/redaction.ts";
import type { MemoryProvenance, MemoryWriteInput, MemorySearchHit } from "./memory-provider.ts";

export const HonchoConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    secretRef: z
      .object({
        provider: z.enum(["keychain", "protonpass", "vaultwarden"]),
        itemRef: z.string().trim().min(1).max(500),
        field: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    baseUrl: z.string().url().default("https://api.honcho.dev"),
    allowLocal: z.boolean().default(false),
    allowedSensitivity: z.array(z.enum(["public", "internal"])).default(["public"]),
    timeoutMs: z.number().int().min(100).max(30000).default(5000),
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !value.allowLocal)
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Honcho requires HTTPS, or explicitly permitted local HTTP; no credentials, query or fragment.",
      });
    }
  });
export type HonchoConfig = z.infer<typeof HonchoConfigSchema>;
export interface HonchoOptions {
  config: z.input<typeof HonchoConfigSchema>;
  companyId: string;
  /** Resolve a SecretRef just in time; never persist or expose the returned token. */
  resolveApiKey?: () => Promise<string | null>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}
const messageSchema = z.object({ content: z.string(), metadata: z.record(z.string(), z.unknown()).optional() });
const messagesSchema = z.array(messageSchema);
const noReasoning = {
  reasoning: { enabled: false },
  peer_card: { use: false, create: false },
  summary: { enabled: false },
  dream: { enabled: false },
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);

export class HonchoMemoryProvider {
  readonly kind = "honcho";
  readonly config: HonchoConfig;
  readonly companyId: string;
  readonly workspaceId: string;
  private readonly transport: NonNullable<HonchoOptions["fetchImpl"]>;
  constructor(private readonly options: HonchoOptions) {
    this.config = HonchoConfigSchema.parse(options.config);
    this.companyId = options.companyId;
    if (!this.companyId) throw new Error("Honcho requires a company scope.");
    this.workspaceId = `ironcrew-${digest(this.companyId)}`;
    this.transport =
      options.fetchImpl ?? ((url, init) => safeFetch(url, { ...init, allowLocal: this.config.allowLocal }));
  }
  accepts(provenance?: MemoryProvenance): boolean {
    return (
      this.config.enabled &&
      provenance?.companyId === this.companyId &&
      this.config.allowedSensitivity.includes(provenance.sensitivity as "public" | "internal")
    );
  }
  private session(externalId: string): string {
    return `memory-${digest(externalId)}`;
  }
  private get workspacePath(): string {
    return `/v3/workspaces/${this.workspaceId}`;
  }
  private async request(path: string, body?: unknown, method = "POST", missingOkay = false): Promise<unknown> {
    if (!this.config.enabled) throw new Error("Honcho is disabled.");
    const controller = new AbortController();
    let rejectTimeout!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error("Honcho request timed out."));
    }, this.config.timeoutMs);
    try {
      const key = await Promise.race([this.options.resolveApiKey?.() ?? Promise.resolve(null), deadline]);
      controller.signal.throwIfAborted();
      const response = await Promise.race([
        this.transport(this.config.baseUrl.replace(/\/$/, "") + path, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        deadline,
      ]);
      if (missingOkay && response.status === 404) return null;
      if (!response.ok) throw new Error(`Honcho HTTP ${response.status}`);
      if (response.status === 204 || method === "DELETE") return null;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Honcho response has no body.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await Promise.race([reader.read(), deadline]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new Error("Honcho response exceeds limit.");
          }
          chunks.push(part.value);
        }
      } finally {
        if (controller.signal.aborted) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      // A transport can include URLs, authorization headers or response bodies in errors.
      throw new Error(
        error instanceof Error && /^Honcho (HTTP \d+|response)/.test(error.message)
          ? error.message
          : "Honcho request unavailable or timed out.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  async upsert(externalId: string, entry: MemoryWriteInput): Promise<void> {
    if (!this.accepts(entry.provenance)) throw new Error("Memory policy prevents external synchronization.");
    if (Buffer.byteLength(entry.content, "utf8") > 256 * 1024)
      throw new Error("Memory entry exceeds synchronization limit.");
    const provenance = entry.provenance!;
    await this.request("/v3/workspaces", { id: this.workspaceId, configuration: noReasoning });
    const sessionId = this.session(externalId);
    const peerId = provenance.agentId ? `agent-${digest(provenance.agentId)}` : "owner";
    // One isolated session per note: retries replace that session, avoiding duplicate writes
    // even when the previous POST succeeded but its response was lost.
    await this.request(`${this.workspacePath}/sessions/${sessionId}`, undefined, "DELETE", true);
    await this.request(`${this.workspacePath}/sessions`, {
      id: sessionId,
      configuration: noReasoning,
      peers: { [peerId]: { observe_me: false } },
      metadata: { source: "ironcrew", task_id: provenance.taskId ?? null, project_id: provenance.projectId ?? null },
    });
    messagesSchema.parse(
      await this.request(`${this.workspacePath}/sessions/${sessionId}/messages`, {
        messages: [
          {
            content: redactText(entry.content),
            peer_id: peerId,
            configuration: { reasoning: { enabled: false } },
            metadata: {
              external_id: externalId,
              title: redactText(entry.title),
              kind: entry.kind,
              company_id: this.companyId,
              source: redactText(provenance.source ?? ""),
              confidence: provenance.confidence ?? 1,
              sensitivity: provenance.sensitivity,
            },
          },
        ],
      }),
    );
  }
  async delete(externalId: string): Promise<void> {
    await this.request(`${this.workspacePath}/sessions/${this.session(externalId)}`, undefined, "DELETE", true);
  }
  async search(query: string, limit = 20): Promise<MemorySearchHit[]> {
    if (!query.trim()) return [];
    const messages = messagesSchema.parse(
      await this.request(`${this.workspacePath}/search`, {
        query: redactText(query).slice(0, 4000),
        limit: Math.max(1, Math.min(50, limit)),
      }),
    );
    return messages.flatMap((message) => {
      const metadata = message.metadata;
      if (metadata?.company_id !== this.companyId || typeof metadata.external_id !== "string") return [];
      return [
        {
          externalId: metadata.external_id,
          title: typeof metadata.title === "string" ? redactText(metadata.title) : "Memory",
          snippet: redactText(message.content).slice(0, 400),
          path: null,
        },
      ];
    });
  }
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request(`${this.workspacePath}/queue/status`, undefined, "GET");
      return { ok: true, message: "Honcho erreichbar." };
    } catch {
      return { ok: false, message: "Honcho nicht erreichbar oder Workspace noch nicht synchronisiert." };
    }
  }
}
