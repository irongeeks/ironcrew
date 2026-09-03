import { post, put, request } from "./core.ts";

import type { PackRegistryEntry } from "../types";

const BASE = "/api/ops/workflow-packs";

export interface LoadedPhaseEntry {
  id: string;
  department: string;
  fanOut?: boolean;
}

export interface LoadedPackEntry {
  key: string;
  name: string;
  version: string;
  source: "builtin" | "community";
  enabled: boolean;
  phaseCount: number;
  phases: LoadedPhaseEntry[];
}

export interface LoadedPacksResponse {
  packs: LoadedPackEntry[];
}

export interface ReloadPacksResponse {
  packs: Array<{ key: string; name: string; version: string; source: string; enabled: boolean }>;
  reloaded: boolean;
}

export async function fetchLoadedPacks(): Promise<LoadedPacksResponse> {
  return request<LoadedPacksResponse>(`${BASE}/loaded`);
}

export async function reloadPacks(): Promise<ReloadPacksResponse> {
  return post<ReloadPacksResponse>(`${BASE}/reload`);
}

export async function fetchPackRegistry(): Promise<PackRegistryEntry[]> {
  try {
    const data = await request<{ packs: PackRegistryEntry[] }>(`${BASE}/registry`);
    return data.packs ?? [];
  } catch {
    return [];
  }
}

export async function fetchPackDefinition(packKey: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`${BASE}/${encodeURIComponent(packKey)}/definition`);
}

export async function fetchPackPositions(packKey: string): Promise<Record<string, { x: number; y: number }> | null> {
  try {
    return await request<Record<string, { x: number; y: number }>>(`${BASE}/${encodeURIComponent(packKey)}/positions`);
  } catch {
    return null;
  }
}

export async function savePackPositions(
  packKey: string,
  positions: Record<string, { x: number; y: number }>,
): Promise<void> {
  try {
    await put(`${BASE}/${encodeURIComponent(packKey)}/positions`, positions);
  } catch (err) {
    console.warn("Failed to save positions:", err);
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export async function validatePackDefinition(definition: Record<string, unknown>): Promise<ValidationResult> {
  return post<ValidationResult>(`${BASE}/validate`, definition);
}

export async function savePackDefinition(packKey: string, definition: Record<string, unknown>): Promise<void> {
  await put(`${BASE}/${encodeURIComponent(packKey)}/definition`, definition);
}

export async function createPack(definition: Record<string, unknown>): Promise<{ ok: boolean; key?: string }> {
  const data = await post<{ ok?: boolean; key?: string }>(`${BASE}/create`, definition);
  return { ok: true, key: data.key };
}

export async function listGuidanceLanguages(packKey: string, phaseId: string): Promise<string[]> {
  try {
    const data = await request<{ languages: string[] }>(
      `${BASE}/${encodeURIComponent(packKey)}/guidance/${encodeURIComponent(phaseId)}`,
    );
    return data.languages ?? [];
  } catch {
    return [];
  }
}

export async function fetchGuidance(packKey: string, phaseId: string, lang: string): Promise<string | null> {
  try {
    const data = await request<{ content: string }>(
      `${BASE}/${encodeURIComponent(packKey)}/guidance/${encodeURIComponent(phaseId)}/${encodeURIComponent(lang)}`,
    );
    return data.content ?? null;
  } catch {
    return null;
  }
}

export async function saveGuidance(packKey: string, phaseId: string, lang: string, content: string): Promise<void> {
  await put(
    `${BASE}/${encodeURIComponent(packKey)}/guidance/${encodeURIComponent(phaseId)}/${encodeURIComponent(lang)}`,
    { content },
  );
}

// ── Node types ──

/** Mirrors NodeTypeInfo from pack-editor/types — defined here to avoid cross-layer imports */
export interface NodeTypeInfoResponse {
  key: string;
  meta: {
    label: string;
    description: string;
    icon: string;
    color: string;
    category: "collaboration" | "connector" | "control" | "custom";
    docsUrl?: string;
  };
  configSchema: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "select";
    label: string;
    description: string;
    default?: string | number | boolean;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    required?: boolean;
  }>;
  inputs: Array<{ name: string; type: string; label: string; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string; label: string; required: boolean; description?: string }>;
}

// ── Module-level cache for editor metadata ──
// These rarely change during a session; caching avoids redundant network requests
// every time PropertyPanel or NodePalette remounts (e.g. clicking different nodes).

let _nodeTypesCache: Promise<NodeTypeInfoResponse[]> | null = null;

export function fetchNodeTypes(): Promise<NodeTypeInfoResponse[]> {
  if (!_nodeTypesCache) {
    _nodeTypesCache = request<NodeTypeInfoResponse[]>("/api/ops/node-types").catch(() => {
      _nodeTypesCache = null;
      return [] as NodeTypeInfoResponse[];
    });
  }
  return _nodeTypesCache;
}

// ── Editor metadata ──

const EDITOR_BASE = "/api/ops/pack-editor";

export interface CapabilityInfo {
  name: string;
  connector: string;
}

export interface DepartmentInfo {
  id: string;
  name: string;
}

let _capabilitiesCache: Promise<CapabilityInfo[]> | null = null;

export function fetchEditorCapabilities(): Promise<CapabilityInfo[]> {
  if (!_capabilitiesCache) {
    _capabilitiesCache = request<{ capabilities: CapabilityInfo[] }>(`${EDITOR_BASE}/capabilities`)
      .then((data) => data.capabilities ?? [])
      .catch(() => {
        _capabilitiesCache = null;
        return [] as CapabilityInfo[];
      });
  }
  return _capabilitiesCache;
}

let _departmentsCache: Promise<DepartmentInfo[]> | null = null;

export function fetchEditorDepartments(): Promise<DepartmentInfo[]> {
  if (!_departmentsCache) {
    _departmentsCache = request<{ departments: DepartmentInfo[] }>(`${EDITOR_BASE}/departments`)
      .then((data) => data.departments ?? [])
      .catch(() => {
        _departmentsCache = null;
        return [] as DepartmentInfo[];
      });
  }
  return _departmentsCache;
}

/** Invalidate all editor metadata caches (e.g. after settings change). */
export function invalidateEditorCaches(): void {
  _nodeTypesCache = null;
  _capabilitiesCache = null;
  _departmentsCache = null;
}
