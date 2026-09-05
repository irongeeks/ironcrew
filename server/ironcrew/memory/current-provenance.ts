/** Current source metadata is checked alongside persisted references before
 * model-facing retrieval. Missing or malformed classification fails closed. */
import { load } from "js-yaml";
import { z } from "zod";
import type { MemoryProvenance } from "./memory-provider.ts";

const provenanceSchema = z.object({
  companyId: z.string().min(1),
  taskId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  sensitivity: z.enum(["public", "internal", "confidential"]),
});

export function readCurrentProvenance(content: string): MemoryProvenance | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  try {
    const parsed = provenanceSchema.safeParse(load(frontmatter));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Owner-facing reads remain available; invalid YAML cannot authorize a run.
    return undefined;
  }
}

export function mayRetrieveMemory(
  provenance: MemoryProvenance | undefined,
  scope: { companyId: string; taskId: string; projectId: string | null; agentId: string | null; sensitive: boolean },
): boolean {
  return Boolean(
    provenance &&
    provenance.companyId === scope.companyId &&
    (!provenance.taskId || provenance.taskId === scope.taskId) &&
    (!provenance.projectId || provenance.projectId === scope.projectId) &&
    (!provenance.agentId || provenance.agentId === scope.agentId) &&
    (["public", "internal"].includes(provenance.sensitivity ?? "") ||
      (provenance.sensitivity === "confidential" && scope.sensitive)),
  );
}
