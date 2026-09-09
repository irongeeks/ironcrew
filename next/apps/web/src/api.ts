import { z } from "zod";
const errorSchema = z
  .object({ code: z.string().optional(), message: z.string().optional(), messageKey: z.string().optional() })
  .passthrough();
const rowSchema = z.record(z.string(), z.unknown());
export type Row = Record<string, unknown>;
export const SESSION_EXPIRED_EVENT = "ironcrew:session-expired";
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}
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
  const requestCsrf = csrf;
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
    if (response.status === 401 && csrf && csrf === requestCsrf) {
      csrf = "";
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    const parsed = errorSchema.safeParse(payload);
    const messages: Record<string, [string, string]> = {
      model_free_endpoint_unavailable: [
        "Für dieses kostenlose Modell ist derzeit kein Endpunkt verfügbar. openrouter/free manuell auswählen und erneut starten.",
        "No endpoint is currently available for this free model. Select openrouter/free manually and restart.",
      ],
      model_cost_reconciliation_required: [
        "Zuerst die Modellkosten mit einem Anbieterbeleg abgleichen.",
        "Reconcile the model costs with provider evidence first.",
      ],
      model_response_not_pending: [
        "Diese Modellantwort wartet nicht mehr auf Klärung. Den aktuellen Stand neu laden.",
        "This model response is no longer pending. Reload the current state.",
      ],
      catalog_refresh_failed: [
        "Der OpenRouter-Katalog konnte nicht aktualisiert werden. Vorhandene Modelle bleiben erhalten. Verbindung prüfen und erneut versuchen; Details stehen im Serverprotokoll.",
        "The OpenRouter catalog could not be refreshed. Existing models are retained. Check the connection and retry; see the server log for details.",
      ],
      model_secret_configuration: [
        "Der Modellzugang wurde nicht gespeichert: Proton Pass CLI benötigt einen absoluten Programmpfad und eine stabile Version ab 2.3.2.",
        "Model access was not saved: Proton Pass CLI requires an absolute executable path and a stable version of 2.3.2 or newer.",
      ],
      model_secret_unavailable: [
        "Der Modellzugang wurde nicht gespeichert: Proton Pass konnte das Secret nicht lesen. Anmeldung, Sitzung, Berechtigungen und Feldverweis prüfen.",
        "Model access was not saved: Proton Pass could not read the secret. Check login, session, permissions and the field reference.",
      ],
    };
    const translated =
      parsed.success && parsed.data.code
        ? messages[parsed.data.code]?.[document.documentElement.lang === "en" ? 1 : 0]
        : undefined;
    throw new ApiError(
      translated ??
        (parsed.success
          ? (parsed.data.message ?? parsed.data.messageKey ?? parsed.data.code ?? `HTTP ${response.status}`)
          : `HTTP ${response.status}`),
      response.status,
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
