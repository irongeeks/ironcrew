import { describe, it, expect, vi } from "vitest";
import { SevdeskAdapter, SEVDESK_BASE_URL, SEVDESK_INVOICE_STATUS, SEVDESK_VOUCHER_STATUS } from "./sevdesk.ts";
import { PackIntegrationError } from "../pack-integration.ts";

/**
 * The token used throughout. A real sevDesk token is 32 hex characters; this
 * one is deliberately not, so every assertion that a message stays clean can
 * grep for this exact string and a leak anywhere — a status message, a thrown
 * error, an echoed response body — is visible.
 */
const API_KEY = "sevdesk_TOP_SECRET_TOKEN_9c1f4a";

interface Reply {
  body?: unknown;
  status?: number;
  text?: string;
}

/**
 * A fetch that answers from a queue and records every request.
 *
 * A queue rather than a single answer because `testConnection()` makes two
 * calls: the version probe and the best-effort tenant lookup. The last entry
 * repeats, so a single-entry queue behaves like a constant server.
 */
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      // The adapter reads bodies through `integrationJson`, which uses text().
      text: async () => (reply.text !== undefined ? reply.text : JSON.stringify(reply.body ?? null)),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function adapter(...replies: Reply[]) {
  const { impl, calls } = fakeFetch(replies.length > 0 ? replies : [{}]);
  return { client: new SevdeskAdapter({ apiKey: API_KEY, fetchImpl: impl }), calls };
}

/** Envelope from https://api.sevdesk.de/#tag/Basics/operation/bookkeepingSystemVersion */
const SYSTEM_VERSION = { objects: { version: "2.0" } };

/** Shaped after Model_CheckAccountResponse in https://api.sevdesk.de/openapi.yaml */
const CHECK_ACCOUNTS = {
  objects: [
    {
      id: "2",
      objectName: "CheckAccount",
      name: "Iron Bank",
      iban: "DE02100500000054540402",
      currency: "EUR",
      sevClient: { id: "84321", objectName: "SevClient" },
    },
  ],
};

/** Shaped after Model_InvoiceResponse, with `embed=contact` applied. */
const INVOICES = {
  // Two rows and a total of two: a fixture that says "three exist" while
  // sending two is describing a server mid-page, and every test that reuses
  // it would then be reasoning about pagination it did not mean to test.
  total: "2",
  objects: [
    {
      id: "1001",
      objectName: "Invoice",
      invoiceNumber: "RE-1000",
      status: "200",
      invoiceDate: "2024-04-08T00:00:00+02:00",
      timeToPay: "14",
      sendDate: "2024-04-08T00:00:00+02:00",
      invoiceType: "RE",
      currency: "EUR",
      sumNet: "1000.50",
      sumTax: "190.10",
      sumGross: "1190.60",
      paidAmount: 0,
      dunningLevel: "1",
      contact: {
        id: "77",
        objectName: "Contact",
        name: "Bike & Ride GmbH & Co. KG",
      },
    },
    {
      id: "1002",
      objectName: "Invoice",
      invoiceNumber: "RE-1001",
      status: "750",
      invoiceDate: "2024-05-02T00:00:00+02:00",
      currency: "CHF",
      sumNet: "80",
      sumTax: "0",
      sumGross: "80",
      paidAmount: 40,
      contact: { id: "78", objectName: "Contact", surename: "Erika", familyname: "Musterfrau" },
    },
  ],
};

/** Shaped after Model_VoucherResponse. */
const VOUCHERS = {
  objects: [
    {
      id: "5001",
      objectName: "Voucher",
      description: "Voucher-1000",
      status: "100",
      voucherDate: "2024-03-01T00:00:00+01:00",
      paymentDeadline: "2024-03-31T00:00:00+02:00",
      creditDebit: "C",
      voucherType: "VOU",
      currency: "EUR",
      sumNet: "210.08",
      sumTax: "39.92",
      sumGross: "250.00",
      paidAmount: 0,
      supplierName: "Baustoffe Meier",
      supplier: null,
    },
    {
      id: "5002",
      objectName: "Voucher",
      status: "1000",
      voucherDate: "2024-03-04T00:00:00+01:00",
      creditDebit: "C",
      currency: "EUR",
      sumGross: "19.99",
      // Embedded supplier: the contact object wins over the plain string.
      supplier: { id: "91", objectName: "Contact", name: "Werkzeug Nord GmbH" },
      supplierName: "irgendein Freitext",
    },
  ],
};

describe("SevdeskAdapter — request shape", () => {
  it("sends the API token as a bare Authorization header, without a Bearer prefix", async () => {
    const { client, calls } = adapter({ body: SYSTEM_VERSION }, { body: CHECK_ACCOUNTS });
    await client.getBookkeepingSystemVersion();

    const headers = calls[0].init?.headers as Record<string, string>;
    // sevDesk's documented example is the raw token as the header value. This
    // assertion is the whole reason the adapter looks different from its
    // siblings, and it fails the moment someone "fixes" it into a Bearer token.
    expect(headers.Authorization).toBe(API_KEY);
    expect(headers.Authorization).not.toMatch(/^Bearer /);
    expect(headers.Authorization).not.toContain("Bearer");
    expect(headers.Accept).toBe("application/json");
    // sevDesk asks integrators to identify themselves so their support can
    // trace a customer's calls.
    expect(headers["User-Agent"]).toBe("IronCrew");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("calls the documented base URL and version endpoint", async () => {
    const { client, calls } = adapter({ body: SYSTEM_VERSION });
    await client.getBookkeepingSystemVersion();

    expect(SEVDESK_BASE_URL).toBe("https://my.sevdesk.de/api/v1");
    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Tools/bookkeepingSystemVersion");
  });

  it("trims a trailing slash off an overridden base URL", async () => {
    const { impl, calls } = fakeFetch([{ body: SYSTEM_VERSION }]);
    const client = new SevdeskAdapter({ apiKey: API_KEY, baseUrl: "https://sevdesk.test/api/v1/", fetchImpl: impl });
    await client.getBookkeepingSystemVersion();

    expect(calls[0].url).toBe("https://sevdesk.test/api/v1/Tools/bookkeepingSystemVersion");
  });

  it("asks for open invoices with the contact embedded by default", async () => {
    const { client, calls } = adapter({ body: INVOICES });
    await client.listInvoices();

    // status=200 is "Open / Due" — the answer to "welche Rechnungen sind
    // offen?". embed=contact is what turns a contact id into a customer name.
    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Invoice?status=200&limit=100&offset=0&embed=contact");
  });

  it("builds the documented filter, paging and embed query it was asked for", async () => {
    const { client, calls } = adapter({ body: INVOICES });
    await client.listInvoices({
      status: 1000,
      overdueOnly: true,
      invoiceNumber: "RE-1000",
      contactId: "77",
      startDate: 1704067200,
      endDate: 1711843200,
      limit: 25,
      offset: 50,
      countAll: true,
      embed: ["contact", "contactPerson"],
    });

    const url = calls[0].url;
    expect(url).toContain("status=1000");
    // sevDesk has no "overdue" status — an unpaid invoice past its pay date is
    // still 200 — so overdue is its own documented filter.
    expect(url).toContain("delinquent=true");
    expect(url).toContain("invoiceNumber=RE-1000");
    // The documented pair: an id without its objectName is ignored.
    expect(url).toContain("contact%5Bid%5D=77");
    expect(url).toContain("contact%5BobjectName%5D=Contact");
    expect(url).toContain("startDate=1704067200");
    expect(url).toContain("endDate=1711843200");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=50");
    expect(url).toContain("countAll=true");
    expect(url).toContain("embed=contact%2CcontactPerson");
  });

  it("drops the status filter when asked for every invoice", async () => {
    const { client, calls } = adapter({ body: INVOICES });
    await client.listInvoices({ status: "any" });
    expect(calls[0].url).not.toContain("status=");
  });

  it("clamps the limit into the documented 1…1000 range and refuses a negative offset", async () => {
    const { client, calls } = adapter({ body: INVOICES }, { body: INVOICES }, { body: INVOICES });
    await client.listInvoices({ limit: 99999 });
    await client.listInvoices({ limit: 0 });
    await client.listInvoices({ limit: 10, offset: -5 });

    expect(calls[0].url).toContain("limit=1000");
    expect(calls[1].url).toContain("limit=1");
    expect(calls[2].url).toContain("offset=0");
  });

  it("asks for unpaid incoming receipts by default", async () => {
    const { client, calls } = adapter({ body: VOUCHERS });
    await client.listVouchers();

    // creditDebit=C is sevDesk's "you bought something" — the receipts the
    // company still has to pay, which is what the Finance pack asks about.
    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Voucher?status=100&creditDebit=C&limit=100&offset=0");
  });

  it("builds the documented voucher filters", async () => {
    const { client, calls } = adapter({ body: VOUCHERS });
    await client.listVouchers({
      status: 1000,
      creditDebit: "D",
      descriptionLike: "Baustoffe",
      contactId: "91",
      startDate: 1704067200,
      limit: 5,
      embed: ["document"],
    });

    const url = calls[0].url;
    expect(url).toContain("status=1000");
    expect(url).toContain("creditDebit=D");
    expect(url).toContain("descriptionLike=Baustoffe");
    expect(url).toContain("contact%5Bid%5D=91");
    expect(url).toContain("startDate=1704067200");
    expect(url).toContain("limit=5");
    expect(url).toContain("embed=document");
  });

  it("drops both voucher filters when asked for everything", async () => {
    const { client, calls } = adapter({ body: VOUCHERS });
    await client.listVouchers({ status: "any", creditDebit: "any" });
    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Voucher?limit=100&offset=0");
  });

  it("escapes the invoice id into the path", async () => {
    const { client, calls } = adapter({ body: { objects: [{ id: "1001" }] } });
    await client.getInvoice("1001/../../Contact");
    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Invoice/1001%2F..%2F..%2FContact?embed=contact");
  });

  it("rejects an empty invoice id without a request", async () => {
    const { client, calls } = adapter({ body: INVOICES });
    await expect(client.getInvoice("  ")).rejects.toBeInstanceOf(PackIntegrationError);
    expect(calls).toHaveLength(0);
  });
});

describe("SevdeskAdapter — the response envelope", () => {
  it("reads the version out of the one endpoint whose objects is not an array", async () => {
    const { client } = adapter({ body: SYSTEM_VERSION });
    expect(await client.getBookkeepingSystemVersion()).toBe("2.0");
  });

  it("unwraps the objects array of a list", async () => {
    const { client } = adapter({ body: INVOICES });
    const page = await client.listInvoices();
    expect(page.items).toHaveLength(2);
  });

  it("unwraps the objects array of a by-id lookup, which is an array of one", async () => {
    const { client } = adapter({ body: { objects: [{ id: "1001", invoiceNumber: "RE-1000" }] } });
    const invoice = await client.getInvoice("1001");
    expect(invoice.number).toBe("RE-1000");
  });

  it("reports a by-id lookup that came back empty as not found", async () => {
    const { client } = adapter({ body: { objects: [] } });
    const err = await client.getInvoice("1001").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackIntegrationError);
    expect((err as PackIntegrationError).status).toBe(404);
    expect((err as Error).message).toMatch(/keine Rechnung gefunden/);
  });

  it("survives a response with no objects at all", async () => {
    const { client } = adapter({ body: {} });
    expect(await client.listInvoices()).toEqual({
      items: [],
      limit: 100,
      offset: 0,
      total: undefined,
      hasMore: false,
    });
  });
});

describe("SevdeskAdapter — invoice mapping", () => {
  it("maps an invoice and turns the numeric status into a German word", async () => {
    const { client } = adapter({ body: INVOICES });
    const [invoice] = (await client.listInvoices()).items;

    expect(invoice).toEqual({
      id: "1001",
      number: "RE-1000",
      statusCode: "200",
      status: "offen",
      invoiceDate: "2024-04-08T00:00:00+02:00",
      timeToPay: "14",
      payDate: undefined,
      sendDate: "2024-04-08T00:00:00+02:00",
      invoiceType: "RE",
      currency: "EUR",
      sumNet: "1000.50",
      sumGross: "1190.60",
      sumTax: "190.10",
      paidAmount: 0,
      dunningLevel: "1",
      contactId: "77",
      contactName: "Bike & Ride GmbH & Co. KG",
    });
  });

  it("maps every documented invoice status code to a readable word", () => {
    // From https://api.sevdesk.de/#tag/Invoice/Types-and-status-of-invoices —
    // a model that is handed "200" writes a riddle; "offen" writes an answer.
    expect(SEVDESK_INVOICE_STATUS).toEqual({
      "50": "deaktivierte Wiederholungsrechnung",
      "100": "Entwurf",
      "200": "offen",
      "750": "teilweise bezahlt",
      "1000": "bezahlt",
    });
  });

  it("maps the partially-paid status introduced in June 2024", async () => {
    const { client } = adapter({ body: INVOICES });
    const [, second] = (await client.listInvoices()).items;
    expect(second).toMatchObject({ statusCode: "750", status: "teilweise bezahlt", paidAmount: 40 });
  });

  it("keeps an unknown status code instead of dropping the invoice", async () => {
    // A status sevDesk adds tomorrow must not make an invoice disappear from a
    // dunning list; the raw code survives, only the German word is absent.
    const { client } = adapter({ body: { objects: [{ id: "9", status: "1234" }] } });
    const [invoice] = (await client.listInvoices()).items;
    expect(invoice.statusCode).toBe("1234");
    expect(invoice.status).toBeUndefined();
  });

  it("leaves money and currency exactly as sevDesk sent them", async () => {
    const { client } = adapter({ body: INVOICES });
    const [first, second] = (await client.listInvoices()).items;

    // Strings, not numbers: sevDesk sends amounts as JSON strings, and a round
    // trip through a float is a lossy one on a figure that ends up on a
    // Rechnung. No rounding, no reformatting, no separator of our own.
    expect(first.sumNet).toBe("1000.50");
    expect(first.sumGross).toBe("1190.60");
    expect(first.sumTax).toBe("190.10");
    expect(typeof first.sumGross).toBe("string");
    expect(first.currency).toBe("EUR");
    // A foreign currency is carried through, not normalised to EUR.
    expect(second.currency).toBe("CHF");
    expect(second.sumGross).toBe("80");
  });

  it("passes dates through as strings rather than re-parsing them", async () => {
    const { client } = adapter({ body: INVOICES });
    const [invoice] = (await client.listInvoices()).items;
    // Re-parsing into a Date would push a midnight+02:00 invoice into the
    // previous day for a UTC reader — a wrong VAT period, not a cosmetic bug.
    expect(invoice.invoiceDate).toBe("2024-04-08T00:00:00+02:00");
  });

  it("builds a person's name from surename and familyname", async () => {
    // sevDesk models organisation and person in one object: `name` is the
    // company, `surename`/`familyname` the private customer.
    const { client } = adapter({ body: INVOICES });
    const [, second] = (await client.listInvoices()).items;
    expect(second.contactName).toBe("Erika Musterfrau");
  });

  it("fills in missing optional fields as undefined rather than crashing", async () => {
    const { client } = adapter({ body: { objects: [{ id: "only-an-id" }] } });
    const [invoice] = (await client.listInvoices()).items;

    expect(invoice).toEqual({
      id: "only-an-id",
      number: undefined,
      statusCode: undefined,
      status: undefined,
      invoiceDate: undefined,
      timeToPay: undefined,
      payDate: undefined,
      sendDate: undefined,
      invoiceType: undefined,
      currency: undefined,
      sumNet: undefined,
      sumGross: undefined,
      sumTax: undefined,
      paidAmount: undefined,
      dunningLevel: undefined,
      contactId: undefined,
      contactName: undefined,
    });
  });

  it("reports no contact name when the contact was not embedded", async () => {
    const { client } = adapter({ body: { objects: [{ id: "1", contact: { id: "77", objectName: "Contact" } }] } });
    const [invoice] = (await client.listInvoices({ embed: [] })).items;
    expect(invoice.contactId).toBe("77");
    // An id without an embedded contact is an id, not a placeholder name.
    expect(invoice.contactName).toBeUndefined();
  });
});

describe("SevdeskAdapter — voucher mapping", () => {
  it("maps a voucher with its supplier, deadline and status word", async () => {
    const { client } = adapter({ body: VOUCHERS });
    const [voucher] = (await client.listVouchers()).items;

    expect(voucher).toEqual({
      id: "5001",
      description: "Voucher-1000",
      statusCode: "100",
      status: "offen",
      voucherDate: "2024-03-01T00:00:00+01:00",
      // Vouchers, unlike invoices, do carry a documented payment deadline.
      paymentDeadline: "2024-03-31T00:00:00+02:00",
      payDate: undefined,
      creditDebit: "C",
      voucherType: "VOU",
      currency: "EUR",
      sumNet: "210.08",
      sumGross: "250.00",
      sumTax: "39.92",
      paidAmount: 0,
      supplierId: undefined,
      supplierName: "Baustoffe Meier",
    });
  });

  it("maps every documented voucher status code to a readable word", () => {
    // From https://api.sevdesk.de/#tag/Voucher/Types-and-status-of-vouchers —
    // note these are NOT the invoice codes: 100 means "offen" here and
    // "Entwurf" there.
    expect(SEVDESK_VOUCHER_STATUS).toEqual({
      "50": "Entwurf",
      "100": "offen",
      "150": "überwiesen",
      "750": "teilweise bezahlt",
      "1000": "bezahlt",
    });
    expect(SEVDESK_VOUCHER_STATUS["100"]).not.toBe(SEVDESK_INVOICE_STATUS["100"]);
  });

  it("prefers an embedded supplier contact over the free-text supplier name", async () => {
    const { client } = adapter({ body: VOUCHERS });
    const [, second] = (await client.listVouchers()).items;
    // sevDesk documents supplierName as what is shown "in case you did not
    // provide a supplier", so the real contact wins when it is there.
    expect(second.supplierId).toBe("91");
    expect(second.supplierName).toBe("Werkzeug Nord GmbH");
    expect(second.status).toBe("bezahlt");
  });

  it("fills in missing optional voucher fields as undefined", async () => {
    const { client } = adapter({ body: { objects: [{ id: "bare" }] } });
    const [voucher] = (await client.listVouchers()).items;

    expect(voucher).toEqual({
      id: "bare",
      description: undefined,
      statusCode: undefined,
      status: undefined,
      voucherDate: undefined,
      paymentDeadline: undefined,
      payDate: undefined,
      creditDebit: undefined,
      voucherType: undefined,
      currency: undefined,
      sumNet: undefined,
      sumGross: undefined,
      sumTax: undefined,
      paidAmount: undefined,
      supplierId: undefined,
      supplierName: undefined,
    });
  });

  it("treats a null supplier as absent rather than crashing on it", async () => {
    const { client } = adapter({ body: { objects: [{ id: "x", supplier: null, supplierName: null }] } });
    const [voucher] = (await client.listVouchers()).items;
    expect(voucher.supplierId).toBeUndefined();
    expect(voucher.supplierName).toBeUndefined();
  });
});

describe("SevdeskAdapter — paging", () => {
  it("reports the total sevDesk sent as a string, parsed once", async () => {
    const { client } = adapter({ body: INVOICES });
    expect(await client.listInvoices({ countAll: true })).toMatchObject({
      limit: 100,
      offset: 0,
      // Parsed from the string sevDesk actually sends, not read as one.
      total: 2,
      hasMore: false,
    });
  });

  it("knows there is more when the total says so", async () => {
    const { client } = adapter({ body: { total: "157", objects: INVOICES.objects } });
    expect((await client.listInvoices({ countAll: true, limit: 2 })).hasMore).toBe(true);
  });

  it("assumes there is more when a page came back full and no total was asked for", async () => {
    // Being wrong here costs one extra request; being wrong the other way
    // silently truncates a dunning list.
    const { client } = adapter({ body: { objects: INVOICES.objects } });
    expect((await client.listInvoices({ limit: 2 })).hasMore).toBe(true);

    const { client: short } = adapter({ body: { objects: INVOICES.objects } });
    expect((await short.listInvoices({ limit: 50 })).hasMore).toBe(false);
  });

  it("ignores a total that is not a number", async () => {
    const { client } = adapter({ body: { total: "viele", objects: [] } });
    const page = await client.listInvoices();
    expect(page.total).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });
});

describe("SevdeskAdapter — testConnection", () => {
  it("names the bookkeeping system version and the tenant it reached", async () => {
    const { client, calls } = adapter({ body: SYSTEM_VERSION }, { body: CHECK_ACCOUNTS });
    const status = await client.testConnection();

    expect(status.ok).toBe(true);
    expect(status.version).toBe("v1");
    expect(status.message).toContain("Buchhaltungssystem 2.0");
    // The Mandanten number is the closest thing sevDesk documents to "you
    // connected YOUR account, not the tenant you copied a token from".
    expect(status.message).toContain("Mandant-Nr. 84321");
    expect(status.message).toContain("Iron Bank");

    expect(calls[0].url).toBe("https://my.sevdesk.de/api/v1/Tools/bookkeepingSystemVersion");
    expect(calls[1].url).toBe("https://my.sevdesk.de/api/v1/CheckAccount?limit=1");
  });

  it("still reports success when only the tenant lookup fails", async () => {
    // Auth is already proven by the first call; a hiccup fetching a nicety must
    // not turn a working connection into a red cross in the Settings panel.
    const { client } = adapter({ body: SYSTEM_VERSION }, { status: 403 });
    const status = await client.testConnection();

    expect(status.ok).toBe(true);
    expect(status.message).toContain("Buchhaltungssystem 2.0");
    expect(status.message).not.toContain("Mandant-Nr.");
  });

  it("answers 'no token configured' instead of firing a request without one", async () => {
    const { impl, calls } = fakeFetch([{ body: SYSTEM_VERSION }]);
    const client = new SevdeskAdapter({ apiKey: "   ", fetchImpl: impl });

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/API-Token/);
    expect(calls).toHaveLength(0);
  });
});

describe("SevdeskAdapter — failures an owner has to read", () => {
  it("says the token is wrong on 401, and where to find the right one", async () => {
    const { client } = adapter({ status: 401, text: JSON.stringify({ error: { message: "Unauthorized" } }) });
    await expect(client.listInvoices()).rejects.toThrow(/API-Token/);
    await expect(client.listInvoices()).rejects.toThrow(/Einstellungen → Benutzer/);
    await expect(client.listInvoices()).rejects.toThrow(/401/);
  });

  it("distinguishes a missing permission on 403 from a wrong token on 401", async () => {
    const { client } = adapter({ status: 403 });
    const err = await client.listVouchers().catch((e: unknown) => e);
    // A 403 means the token is fine and the *user* is not allowed — telling
    // the owner to generate a new token would send them the wrong way.
    expect((err as Error).message).toMatch(/Berechtigung/);
    expect((err as Error).message).toMatch(/gültig/);
    expect((err as Error).message).not.toMatch(/falsch/);
  });

  it("admits on 429 that sevDesk publishes no rate limit", async () => {
    const { client } = adapter({ status: 429 });
    // Unlike Lexware, sevDesk documents no request budget. Inventing a number
    // here would be worse than saying we do not have one.
    await expect(client.listInvoices()).rejects.toThrow(/429/);
    await expect(client.listInvoices()).rejects.toThrow(/kein Limit/);
  });

  it("carries the status code on the error object", async () => {
    const { client } = adapter({ status: 429 });
    const err = await client.listInvoices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackIntegrationError);
    expect((err as PackIntegrationError).status).toBe(429);
  });

  it("reports 400, 404 and 500 in words rather than as bare numbers", async () => {
    const { client: bad } = adapter({ status: 400 });
    await expect(bad.listInvoices()).rejects.toThrow(/abgelehnt/);

    const { client: missing } = adapter({ status: 404 });
    await expect(missing.listInvoices()).rejects.toThrow(/Nicht gefunden/);

    const { client: broken } = adapter({ status: 500 });
    await expect(broken.listInvoices()).rejects.toThrow(/Serverfehler/);
  });

  it("reports a body that is not JSON rather than crashing on it", async () => {
    const { client } = adapter({ text: "<html>502 Bad Gateway</html>" });
    await expect(client.listInvoices()).rejects.toThrow(/kein JSON/);
    await expect(client.listInvoices()).rejects.toBeInstanceOf(PackIntegrationError);
  });

  it("times out instead of hanging the settings page", async () => {
    // Drives the real AbortController path: this fetch never resolves on its
    // own and only rejects when the adapter's own timer aborts it.
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;

    const client = new SevdeskAdapter({ apiKey: API_KEY, fetchImpl: hanging, timeoutMs: 20 });
    await expect(client.listInvoices()).rejects.toThrow(/Zeitüberschreitung nach 20 ms/);

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/Zeitüberschreitung/);
  });

  it("reports an unreachable host without throwing out of testConnection", async () => {
    const client = new SevdeskAdapter({
      apiKey: API_KEY,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED my.sevdesk.de:443");
      }) as unknown as typeof fetch,
    });

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/Nicht erreichbar/);
    expect(status.message).toMatch(/ECONNREFUSED/);
  });
});

describe("SevdeskAdapter — the credential never leaves", () => {
  const cases: Array<[string, Reply]> = [
    ["401 whose body quotes the token", { status: 401, text: `{"error":{"message":"token ${API_KEY} invalid"}}` }],
    ["403 echoing the Authorization header", { status: 403, text: `{"header":"Authorization: ${API_KEY}"}` }],
    ["429", { status: 429 }],
    ["500 mentioning the token", { status: 500, text: `{"message":"${API_KEY}"}` }],
    ["a non-JSON body containing the token", { text: `<html>Authorization=${API_KEY}</html>` }],
  ];

  for (const [name, reply] of cases) {
    it(`keeps the token out of the error for ${name}`, async () => {
      const { client } = adapter(reply);
      const err = await client.listInvoices().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(API_KEY);
      // Not even a fragment: a truncated token is still a token in a log file.
      expect((err as Error).message).not.toContain("sevdesk_TOP_SECRET");
    });
  }

  it("scrubs the token out of a transport error that carried it", async () => {
    // Some HTTP clients put the outgoing request, headers included, into the
    // text of a connection error. That is the failure this guard exists for.
    const leaky = (async () => {
      throw new Error(`connect ECONNREFUSED (headers: {"Authorization":"${API_KEY}"})`);
    }) as unknown as typeof fetch;

    const client = new SevdeskAdapter({ apiKey: API_KEY, fetchImpl: leaky });
    const err = await client.listInvoices().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PackIntegrationError);
    expect((err as Error).message).not.toContain(API_KEY);
    // The marker is the shared helper's, because redaction now lives there
    // for every adapter rather than in each of them (pack-integration.ts).
    expect((err as Error).message).toContain("«entfernt»");

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).not.toContain(API_KEY);
  });

  it("keeps the token out of every testConnection message, success included", async () => {
    for (const [, reply] of cases) {
      const { client } = adapter(reply);
      const status = await client.testConnection();
      expect(status.ok).toBe(false);
      expect(status.message).not.toContain(API_KEY);
    }

    const { client: happy } = adapter({ body: SYSTEM_VERSION }, { body: CHECK_ACCOUNTS });
    const ok = await happy.testConnection();
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("Iron Bank");
    expect(ok.message).not.toContain(API_KEY);
  });

  it("never puts the token in the query string, the way the retired auth did", async () => {
    // Passing the token as a URL parameter was switched off on 29 April 2025,
    // and a token in a URL is a token in every proxy log on the way.
    const { client, calls } = adapter({ body: INVOICES }, { body: VOUCHERS });
    await client.listInvoices();
    await client.listVouchers();

    for (const call of calls) {
      expect(call.url).not.toContain(API_KEY);
      expect(call.url).not.toContain("token=");
    }
  });
});

describe("SevdeskAdapter — read-only by construction", () => {
  it("exposes no method that could write to the books", () => {
    const client = new SevdeskAdapter({ apiKey: API_KEY });
    // The callable surface, i.e. the prototype — instance fields are state,
    // not capability.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client));

    // An adapter that can save or enshrine an invoice creates a *legal*
    // document in the company's books — gap-free number, tax statement, a place
    // in the GoBD audit trail the owner is liable for, and sevDesk's own docs
    // say enshrining "cannot be undone". Phase 4's finance work reaches the
    // owner as an approval, so this capability must not exist to be reached by
    // accident.
    for (const forbidden of [
      "saveInvoice",
      "createInvoice",
      "bookAmount",
      "enshrine",
      "sendViaEmail",
      "cancelInvoice",
      "saveVoucher",
      "post",
      "put",
      "delete",
    ]) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.sort()).toEqual(
      [
        "constructor",
        "get",
        "getBookkeepingSystemVersion",
        "getInvoice",
        "listInvoices",
        "listVouchers",
        "testConnection",
      ].sort(),
    );
  });

  it("only ever issues GET requests, and never with a body", async () => {
    const { client, calls } = adapter({ body: SYSTEM_VERSION }, { body: CHECK_ACCOUNTS });
    await client.testConnection();
    const { client: list, calls: listCalls } = adapter({ body: INVOICES }, { body: VOUCHERS });
    await list.listInvoices();
    await list.listVouchers();
    const { client: one, calls: oneCalls } = adapter({ body: { objects: [{ id: "1001" }] } });
    await one.getInvoice("1001");

    const all = [...calls, ...listCalls, ...oneCalls];
    expect(all.length).toBeGreaterThan(0);
    for (const call of all) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.body).toBeUndefined();
    }
  });

  it("identifies itself with the pack's integration key", () => {
    const client = new SevdeskAdapter({ apiKey: API_KEY });
    expect(client.key).toBe("sevdesk");
    expect(client.label).toBe("sevDesk");
  });
});
