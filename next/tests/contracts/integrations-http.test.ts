import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import {
  IntegrationService,
  type AuthorizedIntegrationAction,
  type IntegrationConnection,
  IntegrationError,
  createHttpTransport,
} from "../../packages/integrations/src/index.ts";

let server: Server;
let baseUrl: string;
const scope = { companyId: "company-test", areaId: "area-test", customerId: "customer-test" };
const ref = { provider: "proton-pass" as const, shareId: "share", itemId: "item", field: "password" };
const requests: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
let respond: (request: (typeof requests)[number]) => {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
} = () => ({ status: 200, body: {} });
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    requests.push(entry);
    const response = respond(entry);
    res.writeHead(response.status, response.headers);
    res.end(response.raw ?? (response.body === undefined ? "" : JSON.stringify(response.body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
function client(
  provider: IntegrationConnection["provider"],
  tools: string[],
  extra: Partial<IntegrationConnection> = {},
) {
  return new IntegrationService({
    connections: [
      {
        id: "target",
        provider,
        scope,
        baseUrl,
        allowHttp: true,
        secretRef: ref,
        enabledTools: tools,
        schemaTag: "local-contract-2026-09-07",
        pricing: {
          id: "b4eaa7ba-5a5c-4d36-82a1-c2309b185f5d",
          version: 1,
          toolId: "research.search",
          currency: "USD",
          requestUsdMicros: "1",
          validFrom: "2020-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          sourceUrl: "https://example.invalid/fixture-price",
        },
        ...extra,
      },
    ],
    // HTTP shape-only fixture: accounting is exercised with a real Repository in integration-costs.test.ts.
    meteredRequest: async ({ execute }) => execute(),
    secrets: { resolve: async () => "fixture-secret" },
    authorize: async () => {},
    sleep: async () => {},
  });
}
const action = (toolId: string, args: unknown = {}): AuthorizedIntegrationAction => ({
  id: "action-test",
  toolId,
  targetId: "target",
  scope,
  args,
});

describe("real HTTP adapter contracts (local fixtures, not live validation)", () => {
  it("builds Brave queries and redacts provider echoes", async () => {
    respond = () => ({
      status: 200,
      body: {
        web: {
          results: [
            { title: "Source fixture-secret", url: "https://example.org/article", description: "supported fact" },
          ],
        },
      },
    });
    const result = await client("brave", ["research.search"]).execute(
      action("research.search", { query: "ä & b", limit: 3 }),
    );
    const request = requests.at(-1)!;
    expect(request.headers["x-subscription-token"]).toBe("fixture-secret");
    expect(new URL(request.url, baseUrl).searchParams.get("q")).toBe("ä & b");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(result.effectStatus).toBe("succeeded");
  });
  it("sends bare sevdesk token and preserves pagination and partial payments", async () => {
    respond = () => ({
      status: 200,
      body: {
        objects: [{ id: "41", status: "750", sumGross: "100.00", sumPaid: "20.00", currency: "EUR" }],
        total: 1000,
      },
    });
    const result = await client("sevdesk", ["sevdesk.invoices.read"]).execute(
      action("sevdesk.invoices.read", { limit: 2, offset: 20 }),
    );
    expect(requests.at(-1)?.headers.authorization).toBe("fixture-secret");
    expect(requests.at(-1)?.url).toContain("offset=20");
    expect(result.data).toMatchObject({ objects: [{ sumPaid: "20.00" }], total: 1000 });
  });
  it("creates a real sevdesk draft with uploaded filename and top-level voucher reference", async () => {
    respond = () => ({
      status: 201,
      body: {
        voucher: { id: "501", objectName: "Voucher", status: "50" },
        voucherPos: [{ id: "601" }],
        filename: "upload-hash.pdf",
      },
    });
    const result = await client("sevdesk", ["sevdesk.voucher.stage"]).execute(
      action("sevdesk.voucher.stage", {
        filename: "upload-hash.pdf",
        voucherDate: "07.09.2026",
        supplierId: 12,
        description: "SUP-123",
        creditDebit: "D",
        currency: "EUR",
        taxRuleId: "1",
        positions: [{ accountDatevId: 4400, taxRate: 19, net: true, amount: "100.00" }],
      }),
    );
    expect(result.externalId).toBe("501");
    const body = JSON.parse(requests.at(-1)!.body);
    expect(body.voucher.status).toBe(50);
    expect(body.voucherPosSave[0].sumNet).toBe(100);
    expect(Object.keys(body).slice(-2)).toEqual(["voucherPosDelete", "filename"]);
    expect(body.filename).toBe("upload-hash.pdf");
  });
  it("books against an explicit account and existing transaction and preserves voucher log evidence", async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 88,
        objectName: "VoucherLog",
        voucher: { id: 501, objectName: "Voucher" },
        fromStatus: 100,
        toStatus: 750,
        amountPayed: "20",
      },
    });
    const result = await client("sevdesk", ["sevdesk.voucher.book"], { resourceIds: ["checkAccount:10"] }).execute(
      action("sevdesk.voucher.book", {
        voucherId: 501,
        amount: "20.00",
        date: "2026-09-07T10:00:00+02:00",
        type: "N",
        checkAccountId: 10,
        checkAccountTransactionId: 44,
      }),
    );
    expect(result.externalId).toBe("88");
    expect(requests.at(-1)?.method).toBe("PUT");
    expect(requests.at(-1)?.url).toBe("/Voucher/501/bookAmount");
    expect(result.data).toMatchObject({ toStatus: 750 });
    expect(JSON.parse(requests.at(-1)!.body).checkAccountTransaction).toEqual({
      id: 44,
      objectName: "CheckAccountTransaction",
    });
  });
  it("requires explicit account scope for bookkeeping", async () => {
    const before = requests.length;
    await expect(
      client("sevdesk", ["sevdesk.voucher.book"], { resourceIds: ["checkAccount:10"] }).execute(
        action("sevdesk.voucher.book", {
          voucherId: 501,
          amount: "20.00",
          date: "2026-09-07T10:00:00+02:00",
          type: "N",
          checkAccountId: 11,
          checkAccountTransactionId: 44,
        }),
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(requests.length).toBe(before);
  });
  it("validates the documented top-level Invoice and Email reminder responses", async () => {
    respond = () => ({ status: 200, body: { id: "700", objectName: "Invoice", invoiceType: "MA" } });
    const created = await client("sevdesk", ["sevdesk.reminder.create"]).execute(
      action("sevdesk.reminder.create", { invoiceId: "500" }),
    );
    expect(created.externalId).toBe("700");
    expect(new URL(requests.at(-1)!.url, baseUrl).searchParams.get("invoice[id]")).toBe("500");
    respond = () => ({
      status: 201,
      body: { id: 800, objectName: "Email", to: "test@example.org", subject: "Reminder" },
    });
    const sent = await client("sevdesk", ["sevdesk.reminder.send"]).execute(
      action("sevdesk.reminder.send", {
        invoiceId: "700",
        to: "test@example.org",
        subject: "Reminder",
        text: "Fixture",
      }),
    );
    expect(sent.effectStatus).toBe("accepted");
    expect(sent.externalId).toBe("800");
  });
  it("uses Nextcloud If-Match and surfaces conflicts without a retry", async () => {
    let count = 0;
    respond = () => {
      count++;
      return { status: 412 };
    };
    await expect(
      client("nextcloud", ["nextcloud.write"], { username: "operator", rootPath: "Kunden/A" }).execute(
        action("nextcloud.write", { path: "report.md", content: "text", expectedEtag: '"v1"' }),
      ),
    ).rejects.toMatchObject({ code: "conflict", effectStatus: "failed" });
    expect(count).toBe(1);
    expect(requests.at(-1)?.headers["if-match"]).toBe('"v1"');
    expect(requests.at(-1)?.url).toBe("/remote.php/dav/files/operator/Kunden/A/report.md");
  });
  it("creates Drive copies with action correlation instead of overwriting a predecessor", async () => {
    respond = (request) =>
      request.method === "GET"
        ? { status: 200, body: { id: "old", version: "7", parents: ["folder"] } }
        : { status: 200, body: { id: "new", version: "1", parents: ["folder"] } };
    const service = client("gdrive", ["gdrive.create"], { resourceIds: ["folder"] });
    const result = await service.execute(
      action("gdrive.create", {
        folderId: "folder",
        name: "report.md",
        content: "report",
        predecessorId: "old",
        expectedVersion: "7",
      }),
    );
    expect(result.externalId).toBe("new");
    expect(requests.at(-1)?.method).toBe("POST");
    expect(requests.at(-1)?.body).toContain("ironcrewActionId");
    expect(requests.at(-1)?.body).toContain('"predecessorId":"old"');
  });
  it("refuses stale Drive revisions before creating content", async () => {
    let count = 0;
    respond = () => {
      count++;
      return { status: 200, body: { id: "old", version: "8", parents: ["folder"] } };
    };
    await expect(
      client("gdrive", ["gdrive.create"], { resourceIds: ["folder"] }).execute(
        action("gdrive.create", {
          folderId: "folder",
          name: "x",
          content: "y",
          predecessorId: "old",
          expectedVersion: "7",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(count).toBe(1);
  });
  it("tracks a Proxmox UPID as accepted, not repaired", async () => {
    respond = () => ({ status: 200, body: { data: "UPID:node:task:" } });
    const result = await client("proxmox", ["proxmox.guest.action"], {
      tokenId: "svc@pve!worker",
      resourceIds: ["node/101"],
    }).execute(action("proxmox.guest.action", { node: "node", vmid: 101, kind: "qemu", operation: "reboot" }));
    expect(result.effectStatus).toBe("accepted");
    expect(result.externalId).toBe("UPID:node:task:");
    expect(requests.at(-1)?.headers.authorization).toBe("PVEAPIToken=svc@pve!worker=fixture-secret");
  });
  it("Graph mail acceptance never claims delivery", async () => {
    respond = () => ({ status: 202 });
    const result = await client("graph", ["graph.mail.send"], { resourceIds: ["sender"] }).execute(
      action("graph.mail.send", { userId: "sender", to: ["test@example.org"], subject: "Fixture", text: "body" }),
    );
    expect(result).toMatchObject({ effectStatus: "accepted", data: { accepted: true, delivered: false } });
  });
  it("does not equate HTTP 200 with Telegram acceptance", async () => {
    respond = () => ({ status: 200, body: { ok: false, description: "fixture-secret" } });
    await expect(
      client("telegram", ["telegram.send"], { resourceIds: ["42"] }).execute(
        action("telegram.send", { chatId: "42", text: "message" }),
      ),
    ).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  });
  it("preserves resource restrictions and scope before any external request", async () => {
    const count = requests.length;
    const service = client("graph", ["graph.mail.send"], { resourceIds: ["sender"] });
    await expect(
      service.execute(action("graph.mail.send", { userId: "foreign", to: ["x@example.org"], subject: "s", text: "t" })),
    ).rejects.toMatchObject({ code: "authorization" });
    await expect(
      service.execute({ ...action("graph.mail.send", {}), scope: { ...scope, customerId: "foreign" } }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(requests.length).toBe(count);
  });
  it("writing connection failures produce unknown effect without retries or secret leakage", async () => {
    let calls = 0;
    const service = new IntegrationService({
      connections: [
        {
          id: "target",
          provider: "discord",
          scope,
          secretRef: ref,
          enabledTools: ["discord.send"],
          resourceIds: ["42"],
          schemaTag: "fixture",
        },
      ],
      // HTTP shape-only fixture: accounting is exercised with a real Repository in integration-costs.test.ts.
      meteredRequest: async ({ execute }) => execute(),
      secrets: { resolve: async () => "fixture-secret" },
      authorize: async () => {},
      transport: async () => {
        calls++;
        throw new Error("fixture-secret");
      },
    });
    try {
      await service.execute(action("discord.send", { channelId: "42", text: "test" }));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationError);
      expect(error).toMatchObject({ effectStatus: "effect_unknown" });
      expect(String(error)).not.toContain("fixture-secret");
    }
    expect(calls).toBe(1);
  });
  it("native HTTP transport bounds bodies and classifies a real write timeout", async () => {
    const hanging = createServer((req, res) => {
      req.resume();
      res.writeHead(200);
      res.write("not finished");
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    try {
      await expect(
        createHttpTransport()({ url, method: "POST", trustedEndpoint: true, timeoutMs: 30 }),
      ).rejects.toMatchObject({ code: "timeout", effectStatus: "effect_unknown" });
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
  it("read retries are bounded at three while auth errors are not retried", async () => {
    let calls = 0;
    respond = () => {
      calls++;
      return { status: 503 };
    };
    await expect(
      client("sevdesk", ["sevdesk.invoices.read"]).execute(action("sevdesk.invoices.read")),
    ).rejects.toMatchObject({ code: "provider" });
    expect(calls).toBe(3);
    calls = 0;
    respond = () => {
      calls++;
      return { status: 401 };
    };
    await expect(
      client("sevdesk", ["sevdesk.invoices.read"]).execute(action("sevdesk.invoices.read")),
    ).rejects.toMatchObject({ code: "auth" });
    expect(calls).toBe(1);
  });
});
