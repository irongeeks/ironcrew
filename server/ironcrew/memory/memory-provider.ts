/**
 * IronCrew — MemoryProvider contract.
 *
 * Provider-agnostic shape for long-term memory backends (Obsidian first,
 * see obsidian-provider.ts). Modeled after this project's SecretProvider
 * (secrets/secret-provider.ts) and AgentRuntime (runtime/run-events.ts)
 * contracts: a provider only ever deals in its own external storage —
 * writing, reading and searching real content — and never persists the
 * IronCrew-side reference (company/task/project/agent provenance, kind,
 * confidence, sensitivity). That reference lives in crew_memory_refs via
 * domain/memory-store.ts; CompanyOrchestrator is what ties the two
 * together (see recordMemory()/readMemoryContent()/searchMemory()), the
 * same division of responsibility SecretRef/SecretProvider already use.
 */

export const MEMORY_KINDS = ["note", "fact", "preference", "hypothesis", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value as string);
}

export interface MemoryWriteInput {
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
}

export interface MemoryWriteResult {
  /** Provider-generated locator, opaque to the caller — passed back to read()/delete(). */
  externalId: string;
  /** Human-readable location, e.g. a vault-relative path. Null when the provider has no such concept. */
  path: string | null;
}

export interface MemorySearchHit {
  externalId: string;
  title: string;
  snippet: string;
  path: string | null;
}

export interface MemoryConnectionStatus {
  ok: boolean;
  /** Human-readable; never note content. */
  message: string;
}

export interface MemoryProvider {
  readonly kind: string;
  write(entry: MemoryWriteInput): Promise<MemoryWriteResult>;
  /** Returns null when the id no longer resolves to anything (e.g. the file was deleted out from under it). */
  read(externalId: string): Promise<string | null>;
  delete(externalId: string): Promise<void>;
  /** Full-text search over content this provider itself wrote. Never throws on "not found" — an empty array. */
  search(query: string, limit?: number): Promise<MemorySearchHit[]>;
  /** Reachability check. Never requires a real entry to succeed. */
  testConnection(): Promise<MemoryConnectionStatus>;
}
