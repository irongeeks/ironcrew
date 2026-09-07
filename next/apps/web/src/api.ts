import { z } from "zod";
const errorSchema = z
  .object({ code: z.string().optional(), message: z.string().optional(), messageKey: z.string().optional() })
  .passthrough();
const rowSchema = z.record(z.string(), z.unknown());
export type Row = Record<string, unknown>;
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export const string = (row: Row, key: string, fallback = ""): string =>
  typeof row[key] === "string" ? (row[key] as string) : fallback;
export async function request<T = Row>(
  path: string,
  options: { method?: string; body?: unknown; revision?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = crypto.randomUUID();
    headers["X-CSRF-Token"] = csrf;
  }
  if (options.revision !== undefined) headers["If-Match"] = String(options.revision);
  if (options.token) headers["X-Setup-Token"] = options.token;
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload: unknown = await response.json().catch(() => ({
    code: "invalid_response",
    ...(response.status === 429
      ? {
          message:
            document.documentElement.lang === "en"
              ? "Too many requests. Please try again later."
              : "Zu viele Anfragen. Bitte später erneut versuchen.",
        }
      : {}),
  }));
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error(
      parsed.success
        ? (parsed.data.message ?? parsed.data.messageKey ?? parsed.data.code ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`,
    );
  }
  if (path === "/session" || path === "/setup") {
    const p = rowSchema.safeParse(payload);
    if (p.success && typeof p.data.csrfToken === "string") csrf = p.data.csrfToken;
  }
  return payload as T;
}
export async function list(path: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path;
    const page = z
      .object({ items: z.array(rowSchema), nextCursor: z.string().nullable().optional() })
      .passthrough()
      .parse(await request<unknown>(query));
    rows.push(...page.items);
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error("Pagination cursor repeated");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export function money(value: unknown, locale = "de") {
  if (value === undefined || value === null) return locale === "de" ? "noch ungeklärt" : "not reconciled";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
      Number(BigInt(String(value))) / 1e6,
    );
  } catch {
    return locale === "de" ? "noch ungeklärt" : "not reconciled";
  }
}
