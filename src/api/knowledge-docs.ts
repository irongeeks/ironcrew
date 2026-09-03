import { del, patch, post, request } from "./core";

// ── Docs Provider Types ─────────────────────────────────────────────────────

export interface DocsProvider {
  id: string;
  name: string;
  providerType: string;
  vaultPath: string;
  enabled: boolean;
  readOnly: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface DocsProviderBinding {
  id: string;
  provider_id: string;
  project_id: string | null;
  project_path_prefix: string | null;
  created_at: number;
}

export interface DocsTestResult {
  ok: boolean;
  reachable: boolean;
  previewCount?: number;
  error?: string;
}

// ── Provider CRUD ───────────────────────────────────────────────────────────

export async function getDocsProviders(): Promise<DocsProvider[]> {
  const j = await request<{ ok: boolean; providers: DocsProvider[] }>("/api/knowledge/docs/providers");
  return j.providers;
}

export async function createDocsProvider(input: {
  name: string;
  vaultPath: string;
  enabled?: boolean;
  readOnly?: boolean;
}): Promise<DocsProvider> {
  const j = await post<{ ok: boolean; provider: DocsProvider }>("/api/knowledge/docs/providers", input);
  return j.provider;
}

export async function updateDocsProvider(
  id: string,
  input: { name?: string; vaultPath?: string; enabled?: boolean; readOnly?: boolean },
): Promise<DocsProvider> {
  const j = await patch<{ ok: boolean; provider: DocsProvider }>(`/api/knowledge/docs/providers/${id}`, input);
  return j.provider;
}

export async function deleteDocsProvider(id: string): Promise<void> {
  await del(`/api/knowledge/docs/providers/${id}`);
}

export async function testDocsProvider(id: string): Promise<DocsTestResult> {
  return request<DocsTestResult>(`/api/knowledge/docs/providers/${id}/test`);
}

// ── Provider Bindings ───────────────────────────────────────────────────────

export async function getDocsProviderBindings(providerId: string): Promise<DocsProviderBinding[]> {
  const j = await request<{ ok: boolean; bindings: DocsProviderBinding[] }>(
    `/api/knowledge/docs/providers/${providerId}/bindings`,
  );
  return j.bindings;
}

export async function createDocsProviderBinding(
  providerId: string,
  input: { projectId?: string | null; projectPathPrefix?: string | null },
): Promise<DocsProviderBinding> {
  const j = await post<{ ok: boolean; binding: DocsProviderBinding }>(
    `/api/knowledge/docs/providers/${providerId}/bindings`,
    input,
  );
  return j.binding;
}

export async function deleteDocsProviderBinding(bindingId: string): Promise<void> {
  await del(`/api/knowledge/docs/bindings/${bindingId}`);
}
