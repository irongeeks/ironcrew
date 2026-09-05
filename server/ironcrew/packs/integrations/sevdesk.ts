/**
 * IronCrew — sevDesk PackIntegrationAdapter.
 *
 * The Finance pack's second accounting system, next to Lexware Office
 * (lexware-office.ts). A German trade business runs one of the two, almost
 * never both, and the question that starts every finance routine in Phase 4 is
 * the same in either: "welche Rechnungen sind offen?". This adapter answers it
 * against sevDesk, in the same shape the Lexware one answers it, so the pack
 * above does not have to care which system the company happens to use.
 *
 * DOCUMENTATION THIS ADAPTER WAS WRITTEN FROM
 *
 * - https://api.sevdesk.de/ — the API reference
 * - https://api.sevdesk.de/openapi.yaml — the machine-readable spec behind it;
 *   every path, parameter, enum and field name below was read out of it
 * - https://api.sevdesk.de/#section/Authentication-and-Authorization
 * - https://api.sevdesk.de/#tag/Invoice/Types-and-status-of-invoices
 * - https://api.sevdesk.de/#tag/Voucher/Types-and-status-of-vouchers
 * - https://api.sevdesk.de/#tag/Basics/operation/bookkeepingSystemVersion
 * - https://tech.sevdesk.com/api_news/posts/2025_02_06-authentication-method-removed/
 * - https://tech.sevdesk.com/api_news/posts/2024_04_04-changing-status-invoices-cretid-notes/
 * - https://tech.sevdesk.com/api_news/posts/2024_04_08-new-invoice-status/
 *
 * THE AUTHORIZATION HEADER HAS NO "BEARER"
 *
 * The single easiest thing to get wrong here, because every other adapter in
 * this directory does it the other way round. sevDesk's own words: the token
 * "needs to be provided as a value of an Authorization Header", and the
 * documented example is literally
 *
 *   "Authorization": "b7794de0085f5cd00560f160f290af38"
 *
 * — the raw 32-character hex token, no scheme, no prefix. The OpenAPI spec
 * says the same in machine-readable form:
 * `securitySchemes.api_key = { type: apiKey, name: Authorization, in: header }`,
 * and an `apiKey` scheme carries no scheme word by definition. Sending
 * `Bearer <token>` gets an HTTP 401 that looks exactly like a wrong key, which
 * is why `sevdesk.test.ts` asserts the header is the bare token and would fail
 * the moment somebody "fixed" it.
 *
 * Passing the token as a URL parameter used to work and was switched off on
 * 29 April 2025 — the header is now the only way.
 *
 * WHAT ELSE THE DOCUMENTATION SAYS, AND THIS ADAPTER OBEYS
 *
 * - Base URL: `https://my.sevdesk.de/api/v1`. There is no v2 API: sevDesk's
 *   "sevdesk-Update 2.0" is a *bookkeeping system* version of the tenant's
 *   account, not an API version, and it is still served under `/api/v1`.
 *   Breaking changes to single resources are opted into with an `X-Version`
 *   header, which this adapter does not send, so it gets `default`.
 * - Response envelope: every GET answers `{"objects": [ … ]}` — an array even
 *   when the path addresses one object by id. `Tools/bookkeepingSystemVersion`
 *   is the exception: there `objects` is a single object.
 * - Paging: `limit` (1…1000), `offset`, and `countAll=true` to have a `total`
 *   included. Documented defaults for a list are limit 100, offset 0.
 * - `embed=<nested resource>` expands a nested `{id, objectName}` stub into the
 *   full object. The documentation's own example is an invoice's contact, which
 *   is exactly what `listInvoices()` uses to get a customer *name* instead of a
 *   contact id no owner can read.
 * - Amounts (`sumNet`, `sumGross`, `sumTax`) are JSON **strings**, not numbers,
 *   and `status` is a string holding a numeric code. Both are passed through
 *   untouched — see the comments at `toInvoice()`.
 * - Documented HTTP errors: 400, 401, 403, 404, 500. No 429 and no published
 *   rate limit; see below.
 *
 * READ-ONLY, AND WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE
 *
 * There is no create, no update, no delete and no payment booking here — not
 * "not yet", but by design, and for the same reason as in the Lexware adapter.
 * A write against an accounting system is different in kind from a write
 * against the other packs' systems, where a mistake is an operational problem:
 * a restarted VM, a wrong ticket state, a duplicated calendar entry.
 * `POST /Invoice/Factory/saveInvoice` followed by `PUT /Invoice/{id}/enshrine`
 * produces a *legal* document in the company's own books: an invoice with a
 * gap-free number, a tax statement, and a place in the GoBD-protected audit
 * trail that the owner is liable for and cannot simply delete afterwards —
 * sevDesk's own documentation says of `enshrine` that "this operation cannot be
 * undone". `PUT /Invoice/{id}/bookAmount` is no lighter: booking a payment is a
 * bookkeeping assertion, not a note.
 *
 * Phase 4's finance work is supposed to reach the owner as an *approval* — a
 * draft, a proposed dunning letter, a list of what looks unpaid — not as a
 * fait accompli discovered later in the Steuerberater's export. An agent that
 * could call `saveInvoice` would be one prompt injection away from issuing
 * invoices in a real company's name. Keeping the write verbs out of the
 * adapter means that risk cannot be reached by a bug, a bad prompt, or a future
 * caller who did not read this comment: the capability does not exist, and
 * `sevdesk.test.ts` asserts the callable surface to keep it that way.
 *
 * WHAT IS NOT CONFIRMED
 *
 * - **No published rate limit.** sevDesk's documentation lists 400/401/403/404/
 *   500 and says nothing about a request budget or an HTTP 429. So, unlike the
 *   Lexware adapter, the 429 message below cannot name a number — it says the
 *   limit is not published rather than inventing one. If sevDesk publishes a
 *   figure, put it in `SEVDESK_RATE_LIMIT_NOTE` and the message follows.
 * - **No documented company/profile endpoint.** There is no sevDesk equivalent
 *   of Lexware's `/v1/profile`, and the `SevUser` model that older generated
 *   SDKs expose is documented with a single field literally named `hidden`. So
 *   `testConnection()` proves auth against `Tools/bookkeepingSystemVersion` and
 *   then makes one *best-effort* `GET /CheckAccount` to name the tenant by its
 *   `sevClient` (Mandanten) id and the first payment account — the closest
 *   confirmed "you reached YOUR account" signal there is.
 * - **Invoices carry no due date.** The documented invoice model has
 *   `invoiceDate` and `timeToPay` (payment period in days) but no `dueDate`
 *   field; sevDesk derives the Fälligkeit from the two. This adapter reports
 *   both and does *not* compute the date, because that arithmetic across the
 *   `+02:00` offsets sevDesk sends would move a Fälligkeit by a day around
 *   midnight. To find what is actually overdue, ask sevDesk: the documented
 *   `delinquent=true` filter is exposed as `overdueOnly`. Vouchers *do* have a
 *   documented `paymentDeadline`, and that one is mapped.
 * - **`embed=contact` on invoices** is the documentation's own worked example;
 *   `embed=supplier` on vouchers is not, so `listVouchers()` does not embed by
 *   default and reads the documented `supplierName` field instead.
 *
 * THE HONEST LIMIT
 *
 * Unverified against a live sevDesk tenant from this repository. URLs, the
 * header shape, filter names, status codes and field names come from the
 * documentation cited above and are asserted by the tests; whether a real
 * tenant answers is what `testConnection()` is for.
 */

import {
  integrationFetch,
  integrationJson,
  normaliseBaseUrl,
  redactSecrets,
  PackIntegrationError,
  type IntegrationStatus,
  type PackIntegrationAdapter,
} from "../pack-integration.ts";

/** The one production instance, version segment included. */
export const SEVDESK_BASE_URL = "https://my.sevdesk.de/api/v1";

/** Said out loud in the 429 message, so nobody has to wonder if we know. */
export const SEVDESK_RATE_LIMIT_NOTE = "sevDesk veröffentlicht kein Limit";

/** Documented paging bounds: "The limit must be between 1 and 1000." */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * sevDesk asks integrators to send a meaningful User-Agent so their support can
 * see which integration a customer's calls came from. It costs one header and
 * it is the difference between a solvable and an unsolvable support ticket.
 */
const USER_AGENT = "IronCrew";

export interface SevdeskOptions {
  /** The 32-character hex API token from Einstellungen → Benutzer → Benutzer. */
  apiKey: string;
  /** Instance base, version segment included. Defaults to the public API. */
  baseUrl?: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to the shared 15s. */
  timeoutMs?: number;
}

/**
 * Invoice status codes, straight out of "Types and status of invoices".
 *
 * German words rather than raw numbers, because the consumer of this list is a
 * language model writing a sentence for an owner: "Rechnung RE-1000 ist offen"
 * is an answer, "Rechnung RE-1000 hat Status 200" is a riddle. The numeric code
 * is kept alongside as `statusCode` for anything that wants to filter.
 */
export const SEVDESK_INVOICE_STATUS: Readonly<Record<string, string>> = Object.freeze({
  // Only ever seen on recurring invoices (WKR).
  "50": "deaktivierte Wiederholungsrechnung",
  "100": "Entwurf",
  // sevDesk shows this as "offen" before the pay date and "fällig" after it;
  // the code is the same either way, so "offen" is the honest single word.
  "200": "offen",
  // Introduced with release 4.181 on 13 June 2024. Invoices partially paid
  // before that release still carry 200.
  "750": "teilweise bezahlt",
  "1000": "bezahlt",
});

/** Voucher status codes, from "Types and status of vouchers". */
export const SEVDESK_VOUCHER_STATUS: Readonly<Record<string, string>> = Object.freeze({
  "50": "Entwurf",
  // "Unpaid / Due" — the voucher is booked but not settled.
  "100": "offen",
  "150": "überwiesen",
  "750": "teilweise bezahlt",
  "1000": "bezahlt",
});

/**
 * The status values the `/Invoice` *filter* accepts.
 *
 * Narrower than the status values a response can carry: the query parameter's
 * documented enum is 100/200/1000, so 750 ("teilweise bezahlt") can come back
 * in a result but cannot be asked for.
 */
export type SevdeskInvoiceStatusFilter = 100 | 200 | 1000;

/** Likewise for `/Voucher`: 50, 100 and 1000 are filterable. */
export type SevdeskVoucherStatusFilter = 50 | 100 | 1000;

export interface SevdeskInvoiceQuery {
  /**
   * Defaults to 200 — "offen", i.e. the question the Finance pack asks. Pass
   * "any" to drop the filter entirely and see drafts and paid invoices too.
   */
  status?: SevdeskInvoiceStatusFilter | "any";
  /** `delinquent=true`: only invoices sevDesk itself considers overdue. */
  overdueOnly?: boolean;
  invoiceNumber?: string;
  /** Sent as the documented `contact[id]` + `contact[objectName]` pair. */
  contactId?: string;
  /** Unix seconds; invoice date greater than or equal. */
  startDate?: number;
  /** Unix seconds; invoice date less than or equal. */
  endDate?: number;
  /** 1…1000, default 100. */
  limit?: number;
  offset?: number;
  /** Ask for a `total`. Off by default — it costs sevDesk a second count. */
  countAll?: boolean;
  /** Defaults to ["contact"], which is what fills `contactName`. */
  embed?: string[];
}

export interface SevdeskVoucherQuery {
  /** Defaults to 100 — "offen", the unpaid receipts. "any" drops the filter. */
  status?: SevdeskVoucherStatusFilter | "any";
  /**
   * Defaults to "C" — credit, i.e. "you bought something": the incoming
   * receipts a trade business actually has to pay. "D" is the outgoing side,
   * "any" drops the filter.
   */
  creditDebit?: "C" | "D" | "any";
  descriptionLike?: string;
  contactId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
  countAll?: boolean;
  /** No default: `embed=supplier` is not a documented value. */
  embed?: string[];
}

/** One outgoing invoice, reduced to what answers "was ist offen?". */
export interface SevdeskInvoice {
  id: string;
  /** e.g. "RE-1000". */
  number?: string;
  /** The raw code as sent, e.g. "200" — for filtering, not for reading. */
  statusCode?: string;
  /** The readable German word, e.g. "offen". Absent for an unknown code. */
  status?: string;
  /** RFC 3339 with offset, exactly as sevDesk sent it. */
  invoiceDate?: string;
  /** Payment period in days, as a string. sevDesk sends no due date. */
  timeToPay?: string;
  /** When it was paid, if it was. */
  payDate?: string;
  sendDate?: string;
  /** "RE", "WKR", "SR", "MA", "TR", "AR" or "ER". */
  invoiceType?: string;
  /** ISO-4217, exactly as sent. */
  currency?: string;
  /** Money stays the string sevDesk sent — see the note at `toInvoice()`. */
  sumNet?: string;
  sumGross?: string;
  sumTax?: string;
  /** The one amount sevDesk sends as a JSON number rather than a string. */
  paidAmount?: number;
  /** How many reminders went out. "1" means Zahlungserinnerung. */
  dunningLevel?: string;
  contactId?: string;
  /** Only filled when the contact was embedded — see `embed`. */
  contactName?: string;
}

/** One incoming receipt. */
export interface SevdeskVoucher {
  id: string;
  /** sevDesk's own words: "essentially the voucher number". */
  description?: string;
  statusCode?: string;
  status?: string;
  voucherDate?: string;
  /** Vouchers, unlike invoices, do carry a documented payment deadline. */
  paymentDeadline?: string;
  payDate?: string;
  /** "C" (credit, an expense) or "D" (debit, a revenue). */
  creditDebit?: string;
  /** "VOU" or "RV". */
  voucherType?: string;
  currency?: string;
  sumNet?: string;
  sumGross?: string;
  sumTax?: string;
  paidAmount?: number;
  supplierId?: string;
  /** The embedded supplier's name if present, else the plain `supplierName`. */
  supplierName?: string;
}

export interface SevdeskPage<T> {
  items: T[];
  /** The limit that was actually sent, after clamping. */
  limit: number;
  offset: number;
  /** Only present when `countAll` was requested. */
  total?: number;
  /** See the comment in `page()` — a heuristic when `total` is absent. */
  hasMore: boolean;
}

export class SevdeskAdapter implements PackIntegrationAdapter {
  readonly key = "sevdesk";
  readonly label = "sevDesk";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(opts: SevdeskOptions) {
    // Trimmed, never checked against /^[0-9a-f]{32}$/: guessing at a key format
    // is how an adapter rejects a perfectly good key after a vendor changes it.
    this.apiKey = (opts.apiKey ?? "").trim();
    this.baseUrl = normaliseBaseUrl(opts.baseUrl ?? SEVDESK_BASE_URL);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Cheapest authenticated call sevDesk has: no filters, no paging, one field.
   *
   * The second call is deliberately best-effort. Auth is already proven by the
   * time it runs, and its only job is to let an owner see they connected THEIR
   * tenant — the Mandanten number and the name of a payment account. sevDesk
   * documents no company-name endpoint (see WHAT IS NOT CONFIRMED), so this is
   * the closest confirmed identity signal, and a hiccup fetching a nicety must
   * not turn a working connection into a red cross in the Settings panel.
   */
  async testConnection(): Promise<IntegrationStatus> {
    try {
      const version = await this.getBookkeepingSystemVersion();
      let tenant = "";
      try {
        const raw = await this.get<RawList<RawCheckAccount>>("/CheckAccount?limit=1", "Zahlungskonten");
        const account = Array.isArray(raw.objects) ? raw.objects[0] : undefined;
        const client = str(account?.sevClient?.id);
        const name = str(account?.name);
        if (client) tenant += ` Mandant-Nr. ${client}.`;
        if (name) tenant += ` Zahlungskonto „${name}“.`;
      } catch {
        // Intentionally swallowed: see the note above.
      }
      return {
        ok: true,
        message: `Verbunden mit sevDesk. Buchhaltungssystem ${version ?? "unbekannt"}.${tenant}`,
        // The API version this adapter speaks. sevDesk has no v2 API; "2.0" in
        // their world is the tenant's bookkeeping system, reported above.
        version: "v1",
      };
    } catch (err) {
      // Reported, not thrown: the Settings panel asks "does this work?", and an
      // exception there is an outage in the page rather than an answer.
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `GET /Tools/bookkeepingSystemVersion` — "1.0" or "2.0".
   *
   * Worth knowing beyond the probe: a 2.0 tenant answers with `taxRule` where a
   * 1.0 tenant answers with `taxType`, so anything reasoning about VAT has to
   * ask this first.
   */
  async getBookkeepingSystemVersion(): Promise<string | undefined> {
    // The one endpoint whose `objects` is an object rather than an array.
    const raw = await this.get<{ objects?: { version?: unknown } | null }>(
      "/Tools/bookkeepingSystemVersion",
      "Systemversion",
    );
    return str(raw.objects?.version);
  }

  /**
   * `GET /Invoice` — the answer to "welche Rechnungen sind offen?".
   *
   * Defaults are chosen for exactly that question: status 200 ("offen") and the
   * contact embedded, because a list of contact ids answers nobody. Overdue is
   * not a separate status in sevDesk — an invoice past its pay date still reads
   * 200 — so `overdueOnly` uses sevDesk's own `delinquent=true` filter rather
   * than this adapter doing date arithmetic it cannot do correctly.
   */
  async listInvoices(opts: SevdeskInvoiceQuery = {}): Promise<SevdeskPage<SevdeskInvoice>> {
    const params = new URLSearchParams();
    const status = opts.status ?? 200;
    if (status !== "any") params.set("status", String(status));
    if (opts.overdueOnly) params.set("delinquent", "true");
    if (opts.invoiceNumber) params.set("invoiceNumber", opts.invoiceNumber);
    // The documented pair: an id without its objectName is ignored.
    if (opts.contactId) {
      params.set("contact[id]", opts.contactId);
      params.set("contact[objectName]", "Contact");
    }
    if (opts.startDate !== undefined) params.set("startDate", String(Math.trunc(opts.startDate)));
    if (opts.endDate !== undefined) params.set("endDate", String(Math.trunc(opts.endDate)));
    appendPaging(params, opts.limit, opts.offset, opts.countAll);
    appendEmbed(params, opts.embed ?? ["contact"]);

    const raw = await this.get<RawList<RawInvoice>>(`/Invoice?${params.toString()}`, "Rechnungsliste");
    return page(raw, toInvoice, boundedLimit(opts.limit), boundedOffset(opts.offset));
  }

  /**
   * `GET /Voucher` — the incoming receipts, i.e. what the company owes.
   *
   * `creditDebit=C` by default: sevDesk's own definition is "if you supply C,
   * the voucher is a credit — you bought something". Without it the list also
   * carries the revenue side, which is the invoices' job.
   */
  async listVouchers(opts: SevdeskVoucherQuery = {}): Promise<SevdeskPage<SevdeskVoucher>> {
    const params = new URLSearchParams();
    const status = opts.status ?? 100;
    if (status !== "any") params.set("status", String(status));
    const creditDebit = opts.creditDebit ?? "C";
    if (creditDebit !== "any") params.set("creditDebit", creditDebit);
    if (opts.descriptionLike) params.set("descriptionLike", opts.descriptionLike);
    if (opts.contactId) {
      params.set("contact[id]", opts.contactId);
      params.set("contact[objectName]", "Contact");
    }
    if (opts.startDate !== undefined) params.set("startDate", String(Math.trunc(opts.startDate)));
    if (opts.endDate !== undefined) params.set("endDate", String(Math.trunc(opts.endDate)));
    appendPaging(params, opts.limit, opts.offset, opts.countAll);
    appendEmbed(params, opts.embed);

    const raw = await this.get<RawList<RawVoucher>>(`/Voucher?${params.toString()}`, "Belegliste");
    return page(raw, toVoucher, boundedLimit(opts.limit), boundedOffset(opts.offset));
  }

  /** `GET /Invoice/{id}` — the detail behind one row of `listInvoices()`. */
  async getInvoice(id: string): Promise<SevdeskInvoice> {
    const trimmed = (id ?? "").trim();
    if (trimmed === "") throw new PackIntegrationError("sevDesk: Es wurde keine Rechnungs-ID angegeben.");
    // Encoded so a caller-supplied id can never grow a path segment or a query
    // string of its own.
    const raw = await this.get<RawList<RawInvoice>>(
      `/Invoice/${encodeURIComponent(trimmed)}?embed=contact`,
      "Rechnung",
    );
    // Even a by-id path answers with the `{"objects": [...]}` envelope.
    const first = Array.isArray(raw.objects) ? raw.objects[0] : undefined;
    if (first === undefined) {
      throw new PackIntegrationError(`sevDesk Rechnung: Zu dieser ID wurde keine Rechnung gefunden.`, 404);
    }
    const invoice = toInvoice(first);
    return { ...invoice, id: invoice.id === "" ? trimmed : invoice.id };
  }

  /**
   * The single request path. GET only — see the read-only note in the header;
   * there is deliberately no sibling that takes a method or a body.
   */
  private async get<T>(path: string, what: string): Promise<T> {
    if (this.apiKey === "") {
      // "Not configured" is an answer, and it is the answer an owner gets
      // before they have pasted a token at all.
      throw new PackIntegrationError(`${what}: Der API-Token für sevDesk fehlt.`);
    }

    let res: Response;
    try {
      res = await integrationFetch(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        {
          method: "GET",
          headers: {
            // No "Bearer". See the header comment — this is the whole trick.
            Authorization: this.apiKey,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        },
        this.timeoutMs,
        [this.apiKey],
      );
    } catch (err) {
      // `integrationFetch` turns a transport failure into `Nicht erreichbar:
      // ${err.message}`, and that message is written by the fetch
      // implementation, not by us — an HTTP client that puts the outgoing
      // headers in its error text would hand the token straight to a log line.
      // Guarded here, once, on the only path out of this class.
      throw redact(err, this.apiKey);
    }

    if (!res.ok) throw statusError(what, res.status);
    return await integrationJson<T>(res, `sevDesk ${what}`);
  }
}

/**
 * Turns a status code into something an owner can act on.
 *
 * The response body is never read for this message, and that is the point
 * rather than an oversight: an error string built from a body is one vendor
 * decision away from carrying the token into every log line that touched it.
 */
function statusError(what: string, status: number): PackIntegrationError {
  const prefix = `sevDesk ${what}`;
  switch (status) {
    case 400:
      return new PackIntegrationError(
        `${prefix}: sevDesk hat die Anfrage abgelehnt (HTTP 400) — vermutlich ein ungültiger Filter- oder Datumswert.`,
        status,
      );
    case 401:
      return new PackIntegrationError(
        `${prefix}: Der API-Token wird von sevDesk nicht akzeptiert (HTTP 401). ` +
          `Er ist falsch oder wurde durch einen neu erzeugten Token ersetzt. ` +
          `Der Token steht in sevDesk unter Einstellungen → Benutzer → Benutzer öffnen.`,
        status,
      );
    case 403:
      return new PackIntegrationError(
        `${prefix}: Der Token ist gültig, dieser Benutzer darf auf diesen Bereich aber nicht zugreifen (HTTP 403). ` +
          `Ein sevDesk-Administrator muss die Berechtigung erteilen oder den Token eines berechtigten Benutzers verwenden.`,
        status,
      );
    case 404:
      return new PackIntegrationError(`${prefix}: Nicht gefunden (HTTP 404).`, status);
    case 422:
      return new PackIntegrationError(
        `${prefix}: sevDesk hat die Werte der Anfrage zurückgewiesen (HTTP 422).`,
        status,
      );
    case 429:
      return new PackIntegrationError(
        `${prefix}: sevDesk hat zu viele Anfragen abgewiesen (HTTP 429). ` +
          `Ein konkretes Limit ist nicht dokumentiert (${SEVDESK_RATE_LIMIT_NOTE}); ` +
          `später erneut versuchen und die Aufrufe entzerren.`,
        status,
      );
    case 500:
      return new PackIntegrationError(
        `${prefix}: Serverfehler bei sevDesk (HTTP 500). ` +
          `Laut Dokumentation steckt dahinter gelegentlich auch eine fehlerhafte Anfrage.`,
        status,
      );
    case 503:
      return new PackIntegrationError(`${prefix}: sevDesk ist zurzeit nicht verfügbar (HTTP 503).`, status);
    default:
      return new PackIntegrationError(`${prefix}: Unerwartete Antwort von sevDesk (HTTP ${status}).`, status);
  }
}

/** Replaces the token, wherever a transport error happened to carry it. */
function redact(err: unknown, apiKey: string): unknown {
  if (apiKey === "") return err;
  // The marker comes from the shared helper rather than from here. Two
  // spellings of "a secret was removed" is the same drift that put a scrubber
  // in three of six adapters and left three without one — and a reader
  // grepping the logs for one marker would miss half the redactions.
  const scrub = (value: string): string => redactSecrets(value, [apiKey]);
  if (err instanceof PackIntegrationError) return new PackIntegrationError(scrub(err.message), err.status);
  if (err instanceof Error) {
    // A fresh error rather than a mutated one: the original's `stack` also
    // embeds the message, and rewriting only `.message` would leave the token
    // visible to anything that prints a stack trace.
    return new PackIntegrationError(scrub(err.message));
  }
  return err;
}

function appendPaging(
  params: URLSearchParams,
  limit: number | undefined,
  offset: number | undefined,
  countAll: boolean | undefined,
): void {
  params.set("limit", String(boundedLimit(limit)));
  params.set("offset", String(boundedOffset(offset)));
  if (countAll) params.set("countAll", "true");
}

/** Documented: "The limit must be between 1 and 1000." Default 100. */
function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function boundedOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

/** `embed=a,b` — the documented form is one parameter, comma separated. */
function appendEmbed(params: URLSearchParams, embed: string[] | undefined): void {
  const list = [...new Set((embed ?? []).map((e) => e.trim()).filter((e) => e !== ""))];
  if (list.length > 0) params.set("embed", list.join(","));
}

/**
 * The `{"objects": [...]}` envelope, plus what can honestly be said about
 * whether there is more.
 *
 * With `countAll` the answer is arithmetic. Without it, a full page is the only
 * hint sevDesk gives, and a full page that happens to be the last one reports
 * `hasMore: true` — a wasted extra request, which is the harmless direction to
 * be wrong in. Reporting `false` too early would silently truncate a dunning
 * list, which is not.
 */
function page<TRaw, TOut>(
  raw: RawList<TRaw>,
  map: (row: TRaw) => TOut,
  limit: number,
  offset: number,
): SevdeskPage<TOut> {
  if (!Array.isArray(raw?.objects)) throw new PackIntegrationError("sevDesk: ungültige Datenliste.");
  const rows = raw.objects;
  const items = rows.map(map);
  // `total` is documented as a string ("157"), so it is parsed rather than read.
  const total = countFrom(raw.total);
  return {
    items,
    limit,
    offset,
    total,
    hasMore: total !== undefined ? offset + items.length < total : items.length >= limit,
  };
}

/**
 * Money and dates stay exactly the strings sevDesk sent.
 *
 * sevDesk sends amounts as JSON strings ("119", "1234.56"). Turning them into
 * JavaScript numbers here would be a lossy round trip through binary floating
 * point on a figure that ends up on a Rechnung, and re-formatting them would
 * pick a decimal separator sevDesk did not choose. Dates get the same
 * treatment: an invoice dated `2024-04-08T00:00:00+02:00` re-parsed and
 * rendered in UTC lands on 7 April — a wrong VAT period, not a cosmetic bug.
 */
function toInvoice(row: RawInvoice): SevdeskInvoice {
  const statusCode = str(row?.status);
  const contact = row?.contact ?? undefined;
  return {
    id: str(row?.id) ?? "",
    number: str(row?.invoiceNumber),
    statusCode,
    status: statusCode === undefined ? undefined : SEVDESK_INVOICE_STATUS[statusCode],
    invoiceDate: str(row?.invoiceDate),
    timeToPay: str(row?.timeToPay),
    payDate: str(row?.payDate),
    sendDate: str(row?.sendDate),
    invoiceType: str(row?.invoiceType),
    currency: str(row?.currency),
    sumNet: str(row?.sumNet),
    sumGross: str(row?.sumGross),
    sumTax: str(row?.sumTax),
    paidAmount: num(row?.paidAmount),
    dunningLevel: str(row?.dunningLevel),
    contactId: str(contact?.id),
    contactName: contactName(contact),
  };
}

function toVoucher(row: RawVoucher): SevdeskVoucher {
  const statusCode = str(row?.status);
  const supplier = row?.supplier ?? undefined;
  return {
    id: str(row?.id) ?? "",
    description: str(row?.description),
    statusCode,
    status: statusCode === undefined ? undefined : SEVDESK_VOUCHER_STATUS[statusCode],
    voucherDate: str(row?.voucherDate),
    paymentDeadline: str(row?.paymentDeadline),
    payDate: str(row?.payDate),
    creditDebit: str(row?.creditDebit),
    voucherType: str(row?.voucherType),
    currency: str(row?.currency),
    sumNet: str(row?.sumNet),
    sumGross: str(row?.sumGross),
    sumTax: str(row?.sumTax),
    paidAmount: num(row?.paidAmount),
    supplierId: str(supplier?.id),
    // The embedded contact wins: `supplierName` is documented as the fallback
    // sevDesk shows "in case you did not provide a supplier".
    supplierName: contactName(supplier) ?? str(row?.supplierName),
  };
}

/**
 * A contact's display name, once it has been embedded.
 *
 * sevDesk models an organisation and a person in the same object: `name` holds
 * the company, and its presence is what *makes* the contact an organisation,
 * while a private customer has `surename` (sevDesk's spelling, not a typo here)
 * and `familyname` instead. Without `embed=contact` there is only an id, and
 * this returns undefined rather than inventing a placeholder.
 */
function contactName(contact: RawContactRef | undefined): string | undefined {
  const org = str(contact?.name);
  if (org !== undefined) return org;
  const person = [str(contact?.surename), str(contact?.familyname)].filter((p) => p !== undefined).join(" ");
  return person === "" ? undefined : person;
}

/** `null` and `""` are both "absent" here, never an empty-looking value. */
function str(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  return undefined;
}

/** `paidAmount` is the one figure sevDesk sends as a number. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `total` arrives as a string; a non-numeric one is absent, never NaN. */
function countFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

interface RawList<T> {
  objects?: T[];
  total?: unknown;
}

interface RawContactRef {
  id?: unknown;
  objectName?: unknown;
  name?: unknown;
  surename?: unknown;
  familyname?: unknown;
}

interface RawCheckAccount {
  name?: unknown;
  sevClient?: { id?: unknown } | null;
}

interface RawInvoice {
  id?: unknown;
  invoiceNumber?: unknown;
  status?: unknown;
  invoiceDate?: unknown;
  timeToPay?: unknown;
  payDate?: unknown;
  sendDate?: unknown;
  invoiceType?: unknown;
  currency?: unknown;
  sumNet?: unknown;
  sumGross?: unknown;
  sumTax?: unknown;
  paidAmount?: unknown;
  dunningLevel?: unknown;
  contact?: RawContactRef | null;
}

interface RawVoucher {
  id?: unknown;
  description?: unknown;
  status?: unknown;
  voucherDate?: unknown;
  paymentDeadline?: unknown;
  payDate?: unknown;
  creditDebit?: unknown;
  voucherType?: unknown;
  currency?: unknown;
  sumNet?: unknown;
  sumGross?: unknown;
  sumTax?: unknown;
  paidAmount?: unknown;
  supplier?: RawContactRef | null;
  supplierName?: unknown;
}
