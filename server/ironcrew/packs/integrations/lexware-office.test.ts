import { describe, it, expect, vi } from "vitest";
import { LexwareOfficeAdapter, LEXWARE_OFFICE_BASE_URL } from "./lexware-office.ts";
import { PackIntegrationError } from "../pack-integration.ts";

/**
 * The key used throughout. Distinctive on purpose: every assertion that a
 * message stays clean greps for this exact string, so a leak anywhere — a
 * status message, a thrown error, an echoed response body — is visible.
 */
const API_KEY = "lxo_TOP_SECRET_KEY_2f4a9c";

/** A fetch that answers once and records the request it was handed. */
function fakeFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    const status = init.status ?? 200;
    return {
      ok: status < 400,
      status,
      // The adapter reads bodies through `integrationJson`, which uses text().
      text: async () => (init.text !== undefined ? init.text : JSON.stringify(body)),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function adapter(body: unknown, init?: { status?: number; text?: string }) {
  const { impl, calls } = fakeFetch(body, init);
  return { client: new LexwareOfficeAdapter({ apiKey: API_KEY, fetchImpl: impl }), calls };
}

/** Sample response from https://developers.lexware.io/docs/#profile-endpoint. */
const PROFILE = {
  organizationId: "aa93e8a8-2aa3-470b-b914-caad8a255dd8",
  companyName: "Testfirma GmbH",
  created: {
    userId: "1aea5501-3f3e-403d-8492-2dad03016289",
    userName: "Frau Erika Musterfrau",
    userEmail: "erika.musterfrau@testfirma.de",
    date: "2017-01-03T13:15:45.000+01:00",
  },
  connectionId: "3dea098a-fae5-4458-a85c-f97965966c25",
  businessFeatures: ["INVOICING", "INVOICING_PRO", "BOOKKEEPING"],
  taxType: "net",
  smallBusiness: false,
};

/** Sample response from https://developers.lexware.io/docs/#voucherlist-endpoint. */
const VOUCHERLIST = {
  content: [
    {
      id: "57b8d457-1fb6-4ae9-944a-9fe763da2aff",
      voucherType: "purchaseinvoice",
      voucherStatus: "open",
      voucherNumber: "2010096",
      voucherDate: "2023-06-14T00:00:00.000+02:00",
      createdDate: "2023-03-22T12:36:22.000+01:00",
      updatedDate: "2023-03-22T12:36:22.000+01:00",
      dueDate: "2023-06-21T00:00:00.000+02:00",
      contactId: null,
      contactName: "Sammellieferant",
      totalAmount: 80.04,
      openAmount: 80.04,
      currency: "EUR",
      archived: false,
    },
    {
      id: "55aa6de8-d32d-47bd-9c3c-d541ab65a8e8",
      voucherType: "invoice",
      voucherStatus: "overdue",
      voucherNumber: "RE1011",
      voucherDate: "2023-03-02T00:00:00.000+01:00",
      dueDate: "2023-10-06T00:00:00.000+02:00",
      contactId: "b08a1ac7-10fc-4214-b875-8491f91479dd",
      contactName: "Test GmbH",
      totalAmount: 498.8,
      openAmount: 498.8,
      currency: "EUR",
      archived: false,
    },
  ],
  first: true,
  last: true,
  totalPages: 1,
  totalElements: 2,
  numberOfElements: 2,
  size: 25,
  number: 0,
};

/** Trimmed from the invoice sample in the same documentation. */
const INVOICE = {
  id: "e9066f04-8cc7-4616-93f8-ac9ecc8479c8",
  organizationId: "aa93e8a8-2aa3-470b-b914-caad8a255dd8",
  createdDate: "2023-04-24T08:20:22.528+02:00",
  updatedDate: "2023-04-24T08:20:22.528+02:00",
  archived: false,
  voucherStatus: "draft",
  voucherNumber: "RE1019",
  voucherDate: "2023-02-22T00:00:00.000+01:00",
  address: {
    contactId: "97c5794f-8ab2-43ad-b459-c5980b055e4d",
    name: "Bike & Ride GmbH & Co. KG",
    street: "Musterstraße 42",
    city: "Freiburg",
    zip: "79112",
    countryCode: "DE",
  },
  lineItems: [
    {
      id: "97b98491",
      type: "material",
      name: "Abus Kabelschloss",
      quantity: 2,
      unitName: "Stück",
      lineItemAmount: 13.4,
    },
    { type: "custom", name: "Energieriegel Testpaket", quantity: 1, unitName: "Stück", lineItemAmount: 5 },
  ],
  totalPrice: { currency: "EUR", totalNetAmount: 26.72, totalGrossAmount: 29.85, totalTaxAmount: 3.13 },
  taxConditions: { taxType: "net" },
  paymentConditions: { paymentTermLabel: "10 Tage - 3 %, 30 Tage netto", paymentTermDuration: 30 },
  title: "Rechnung",
  remark: "Vielen Dank für Ihren Einkauf",
};

describe("LexwareOfficeAdapter — request shape", () => {
  it("calls the documented profile URL with a Bearer token and asks for JSON", async () => {
    const { client, calls } = adapter(PROFILE);
    await client.getProfile();

    expect(calls[0].url).toBe("https://api.lexware.io/v1/profile");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers.Accept).toBe("application/json");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("defaults to the current api.lexware.io gateway, not the retired lexoffice one", () => {
    // The gateway moved with the rebranding and the old host was switched off
    // in December 2025; defaulting to it would be an adapter that never works.
    expect(LEXWARE_OFFICE_BASE_URL).toBe("https://api.lexware.io");
  });

  it("trims a trailing slash off an overridden base URL", async () => {
    const { impl, calls } = fakeFetch(PROFILE);
    const client = new LexwareOfficeAdapter({ apiKey: API_KEY, baseUrl: "https://sandbox.example/", fetchImpl: impl });
    await client.getProfile();

    expect(calls[0].url).toBe("https://sandbox.example/v1/profile");
  });

  it("sends both mandatory voucherlist filters, defaulting to every open voucher", async () => {
    const { client, calls } = adapter(VOUCHERLIST);
    await client.listVouchers();

    // voucherType and voucherStatus are mandatory on this endpoint; omitting
    // either is an HTTP 400.
    expect(calls[0].url).toBe("https://api.lexware.io/v1/voucherlist?voucherType=any&voucherStatus=open&size=25");
  });

  it("builds the filter, paging and sorting query it was asked for", async () => {
    const { client, calls } = adapter(VOUCHERLIST);
    await client.listVouchers({
      types: ["invoice", "purchaseinvoice"],
      status: ["open", "sepadebit"],
      archived: false,
      voucherDateFrom: "2026-01-01",
      voucherDateTo: "2026-03-31",
      page: 2,
      size: 100,
      sort: "voucherDate,DESC",
    });

    const url = calls[0].url;
    // Commas are percent-encoded: the docs require query values to be URL
    // encoded, and %2C decodes back to the comma-separated list they specify.
    expect(url).toContain("voucherType=invoice%2Cpurchaseinvoice");
    expect(url).toContain("voucherStatus=open%2Csepadebit");
    expect(url).toContain("archived=false");
    expect(url).toContain("voucherDateFrom=2026-01-01");
    expect(url).toContain("voucherDateTo=2026-03-31");
    expect(url).toContain("page=2");
    expect(url).toContain("size=100");
    expect(url).toContain("sort=voucherDate%2CDESC");
  });

  it("clamps the page size to the documented maximum of 250", async () => {
    const { client, calls } = adapter(VOUCHERLIST);
    await client.listVouchers({ size: 5000 });
    expect(calls[0].url).toContain("size=250");
  });

  it("refuses to combine overdue with another status instead of earning a 400", async () => {
    const { client, calls } = adapter(VOUCHERLIST);
    // Documented rule: overdue cannot be filtered together with other status.
    await expect(client.listVouchers({ status: ["open", "overdue"] })).rejects.toThrow(/overdue/);
    expect(calls).toHaveLength(0);
  });

  it("escapes the invoice id into the path", async () => {
    const { client, calls } = adapter(INVOICE);
    await client.getInvoice("e9066f04/../../profile");
    expect(calls[0].url).toBe("https://api.lexware.io/v1/invoices/e9066f04%2F..%2F..%2Fprofile");
  });

  it("rejects an empty invoice id without a request", async () => {
    const { client, calls } = adapter(INVOICE);
    await expect(client.getInvoice("  ")).rejects.toBeInstanceOf(PackIntegrationError);
    expect(calls).toHaveLength(0);
  });
});

describe("LexwareOfficeAdapter — mapping", () => {
  it("parses the profile", async () => {
    const { client } = adapter(PROFILE);
    expect(await client.getProfile()).toEqual({
      organizationId: "aa93e8a8-2aa3-470b-b914-caad8a255dd8",
      companyName: "Testfirma GmbH",
      taxType: "net",
      smallBusiness: false,
      connectedUser: "Frau Erika Musterfrau",
      businessFeatures: ["INVOICING", "INVOICING_PRO", "BOOKKEEPING"],
    });
  });

  it("survives a profile with nothing in it", async () => {
    const { client } = adapter({});
    expect(await client.getProfile()).toEqual({
      organizationId: undefined,
      companyName: undefined,
      taxType: undefined,
      smallBusiness: undefined,
      connectedUser: undefined,
      businessFeatures: [],
    });
  });

  it("maps vouchers, money and currency", async () => {
    const { client } = adapter(VOUCHERLIST);
    const page = await client.listVouchers();

    expect(page.vouchers).toHaveLength(2);
    expect(page.vouchers[0]).toEqual({
      id: "57b8d457-1fb6-4ae9-944a-9fe763da2aff",
      type: "purchaseinvoice",
      status: "open",
      number: "2010096",
      date: "2023-06-14T00:00:00.000+02:00",
      dueDate: "2023-06-21T00:00:00.000+02:00",
      totalAmount: 80.04,
      openAmount: 80.04,
      currency: "EUR",
      // Documented as null for the collective contact, and null is "absent".
      contactId: undefined,
      contactName: "Sammellieferant",
      archived: false,
      overdue: false,
    });
    // The amount stays the number the API sent — no rounding, no float games.
    expect(page.vouchers[1].totalAmount).toBe(498.8);
    expect(page.vouchers[1].currency).toBe("EUR");
  });

  it("flags a voucher Lexware itself calls overdue", async () => {
    const { client } = adapter(VOUCHERLIST);
    const page = await client.listVouchers();
    // A query for `open` returns overdue vouchers too — that transient status
    // is the whole answer to "welche Rechnung ist zu spät?".
    expect(page.vouchers[1]).toMatchObject({ status: "overdue", overdue: true, dueDate: expect.any(String) });
  });

  it("keeps dates as the strings Lexware sent, offset included", async () => {
    const { client } = adapter(VOUCHERLIST);
    const [voucher] = (await client.listVouchers()).vouchers;
    // Re-parsing into a Date would move a midnight+02:00 Beleg into the
    // previous day for a UTC reader — a wrong VAT period, not a cosmetic bug.
    expect(voucher.date).toBe("2023-06-14T00:00:00.000+02:00");
  });

  it("fills in missing optional fields as undefined rather than crashing", async () => {
    const { client } = adapter({ content: [{ id: "only-an-id" }] });
    const [voucher] = (await client.listVouchers()).vouchers;

    expect(voucher).toEqual({
      id: "only-an-id",
      type: undefined,
      status: undefined,
      number: undefined,
      date: undefined,
      dueDate: undefined,
      totalAmount: undefined,
      openAmount: undefined,
      currency: undefined,
      contactId: undefined,
      contactName: undefined,
      archived: undefined,
      overdue: false,
    });
  });

  it("treats a null openAmount as absent, not as zero", async () => {
    // A draft has no open amount; reporting 0,00 € would read as "paid".
    const { client } = adapter({ content: [{ id: "x", voucherStatus: "draft", totalAmount: 10, openAmount: null }] });
    const [voucher] = (await client.listVouchers()).vouchers;
    expect(voucher.openAmount).toBeUndefined();
    expect(voucher.totalAmount).toBe(10);
  });

  it("reports paging so a caller knows there is more to fetch", async () => {
    const { client } = adapter(VOUCHERLIST);
    expect(await client.listVouchers()).toMatchObject({
      page: 0,
      totalPages: 1,
      totalElements: 2,
      hasMore: false,
    });

    const { client: more } = adapter({ ...VOUCHERLIST, last: false, totalPages: 4, totalElements: 87, number: 0 });
    expect((await more.listVouchers()).hasMore).toBe(true);
  });

  it("survives a voucherlist page with no content at all", async () => {
    const { client } = adapter({});
    expect(await client.listVouchers()).toEqual({
      vouchers: [],
      page: 0,
      totalPages: 0,
      totalElements: 0,
      hasMore: false,
    });
  });

  it("maps an invoice", async () => {
    const { client } = adapter(INVOICE);
    const invoice = await client.getInvoice("e9066f04-8cc7-4616-93f8-ac9ecc8479c8");

    expect(invoice).toMatchObject({
      id: "e9066f04-8cc7-4616-93f8-ac9ecc8479c8",
      number: "RE1019",
      status: "draft",
      date: "2023-02-22T00:00:00.000+01:00",
      archived: false,
      contactId: "97c5794f-8ab2-43ad-b459-c5980b055e4d",
      contactName: "Bike & Ride GmbH & Co. KG",
      currency: "EUR",
      totalNetAmount: 26.72,
      totalGrossAmount: 29.85,
      totalTaxAmount: 3.13,
      taxType: "net",
      paymentTermLabel: "10 Tage - 3 %, 30 Tage netto",
      title: "Rechnung",
      remark: "Vielen Dank für Ihren Einkauf",
    });
    expect(invoice.lineItems).toEqual([
      { name: "Abus Kabelschloss", quantity: 2, unitName: "Stück", amount: 13.4 },
      { name: "Energieriegel Testpaket", quantity: 1, unitName: "Stück", amount: 5 },
    ]);
  });

  it("maps an invoice that carries only an id", async () => {
    const { client } = adapter({ id: "bare" });
    const invoice = await client.getInvoice("bare");
    expect(invoice.lineItems).toEqual([]);
    expect(invoice.totalGrossAmount).toBeUndefined();
    expect(invoice.contactName).toBeUndefined();
  });
});

describe("LexwareOfficeAdapter — failures an owner has to read", () => {
  it("says the key is wrong on 401, and where to get a new one", async () => {
    const { client } = adapter(null, { status: 401, text: JSON.stringify({ message: "Unauthorized" }) });
    await expect(client.getProfile()).rejects.toThrow(/API-Schlüssel/);
    await expect(client.getProfile()).rejects.toThrow(/app\.lexware\.de\/addons\/public-api/);

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/401/);
  });

  it("names the rate limit on 429", async () => {
    const { client } = adapter(null, { status: 429 });
    // "Rate limited" alone tells an owner nothing about whether one routine or
    // twenty caused it; the documented number does.
    await expect(client.listVouchers()).rejects.toThrow(/Rate-Limit/);
    await expect(client.listVouchers()).rejects.toThrow(/2 Anfragen pro Sekunde/);
    await expect(client.listVouchers()).rejects.toThrow(/429/);
  });

  it("carries the status code on the error object", async () => {
    const { client } = adapter(null, { status: 429 });
    const err = await client.listVouchers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackIntegrationError);
    expect((err as PackIntegrationError).status).toBe(429);
  });

  it("explains a 402 contract problem and a 403 scope problem separately", async () => {
    const { client: paid } = adapter(null, { status: 402 });
    await expect(paid.getProfile()).rejects.toThrow(/Vertrag/);

    const { client: scope } = adapter(null, { status: 403 });
    await expect(scope.getProfile()).rejects.toThrow(/Berechtigung/);
  });

  it("reports a body that is not JSON rather than crashing on it", async () => {
    const { client } = adapter(null, { text: "<html>Gateway Error</html>" });
    await expect(client.listVouchers()).rejects.toThrow(/kein JSON/);
    await expect(client.listVouchers()).rejects.toBeInstanceOf(PackIntegrationError);
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

    const client = new LexwareOfficeAdapter({ apiKey: API_KEY, fetchImpl: hanging, timeoutMs: 20 });
    await expect(client.getProfile()).rejects.toThrow(/Zeitüberschreitung nach 20 ms/);

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/Zeitüberschreitung/);
  });

  it("reports an unreachable host without throwing out of testConnection", async () => {
    const client = new LexwareOfficeAdapter({
      apiKey: API_KEY,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/ECONNREFUSED/);
  });

  it("answers 'no key configured' instead of firing a request without one", async () => {
    const { impl, calls } = fakeFetch(PROFILE);
    const client = new LexwareOfficeAdapter({ apiKey: "   ", fetchImpl: impl });

    const status = await client.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/API-Schlüssel/);
    expect(calls).toHaveLength(0);
  });
});

describe("LexwareOfficeAdapter — the credential never leaves", () => {
  const cases: Array<[string, { status?: number; text?: string }]> = [
    ["401 with the documented body", { status: 401, text: JSON.stringify({ message: "Unauthorized" }) }],
    // Lexware's own documented 403 body echoes the Authorization header back
    // verbatim — the single best reason never to build a message from a body.
    [
      "403 echoing the Authorization header",
      {
        status: 403,
        text: JSON.stringify({
          message: `'${API_KEY}' not a valid key=value pair (missing equal-sign) in Authorization header: 'Bearer ${API_KEY}'.`,
        }),
      },
    ],
    ["429", { status: 429 }],
    ["500 mentioning the rate limit", { status: 500, text: `{"message":"rate limit exceeded ${API_KEY}"}` }],
    ["504", { status: 504 }],
    ["a non-JSON body containing the key", { text: `<html>token=${API_KEY}</html>` }],
  ];

  for (const [name, init] of cases) {
    it(`keeps the API key out of the error for ${name}`, async () => {
      const { client } = adapter(null, init);
      const err = await client.listVouchers().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(API_KEY);
      // Not even a fragment: a truncated key is still a key in a log file.
      expect((err as Error).message).not.toContain("lxo_");
      expect((err as Error).message).not.toContain("Bearer");
    });
  }

  it("keeps the API key out of every testConnection message", async () => {
    for (const [, init] of cases) {
      const { client } = adapter(null, init);
      const status = await client.testConnection();
      expect(status.ok).toBe(false);
      expect(status.message).not.toContain(API_KEY);
    }

    const { client: happy } = adapter(PROFILE);
    const ok = await happy.testConnection();
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("Testfirma GmbH");
    expect(ok.message).not.toContain(API_KEY);
  });
});

describe("LexwareOfficeAdapter — read-only by construction", () => {
  it("exposes no method that could write to the books", () => {
    const client = new LexwareOfficeAdapter({ apiKey: API_KEY });
    // The callable surface, i.e. the prototype — instance fields are state,
    // not capability.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client));

    // An adapter that can create a voucher can create a *legal* document in
    // the company's books. Phase 4's finance work reaches the owner as an
    // approval, so this capability must not exist to be reached by accident.
    for (const forbidden of ["createInvoice", "bookPayment", "updateVoucher", "deleteVoucher", "post", "put"]) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.sort()).toEqual(
      ["constructor", "get", "getInvoice", "getProfile", "listVouchers", "testConnection"].sort(),
    );
  });

  it("only ever issues GET requests", async () => {
    const { client, calls } = adapter(VOUCHERLIST);
    await client.listVouchers();
    const { client: one, calls: oneCalls } = adapter(INVOICE);
    await one.getInvoice("e9066f04");

    for (const call of [...calls, ...oneCalls]) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.body).toBeUndefined();
    }
  });

  it("identifies itself with the pack's integration key", () => {
    const client = new LexwareOfficeAdapter({ apiKey: API_KEY });
    expect(client.key).toBe("lexware-office");
    expect(client.label).toBe("Lexware Office");
  });
});
