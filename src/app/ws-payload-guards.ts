/**
 * Runtime guards for WebSocket payloads.
 * Replace unsafe `payload as X` casts with validated parsing.
 */

/** Narrow unknown to a record, returning null for non-objects. */
export function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/** Narrow unknown to a record, returning empty object for non-objects. */
export function asRecordOrEmpty(payload: unknown): Record<string, unknown> {
  return asRecord(payload) ?? {};
}

/** Validate that a payload has the required string fields. Returns null if any are missing. */
export function requireStringFields<K extends string>(
  payload: unknown,
  ...fields: K[]
): (Record<string, unknown> & Record<K, string>) | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  for (const field of fields) {
    if (typeof rec[field] !== "string") return null;
  }
  return rec as Record<string, unknown> & Record<K, string>;
}

/** Safe nullable string accessor. */
export function strOrNull(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}

/** Safe optional number accessor. */
export function numOrNull(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
