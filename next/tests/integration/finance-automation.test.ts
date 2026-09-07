import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { FinanceWorkflow } from "../../packages/domain/workflows/finance.ts";
import { FinanceAutomation, normalizeSevdeskInvoice } from "../../packages/domain/workflows/finance-automation.ts";
import { FinanceCorrections } from "../../packages/domain/workflows/finance-corrections.ts";
import { FinanceService } from "../../apps/control/finance-service.ts";
import { configSchema, type Configuration } from "../../apps/control/configuration.ts";
import { digest } from "../../packages/tools/workspace.ts";
let repo: Repository,
  directory: string,
  setup: SetupResult,
  scope: Scope,
  targetId: string,
  config: Configuration,
  server: http.Server,
  port: number;
let requestBodies: Record<string, unknown>[],
  calls: string[],
  counter: number,
  paid: string,
  onSend: (() => void) | undefined;
const clock = () => new Date();
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ic-finance-auto-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  setup = await repo.setup({
    companyName: "Finance lab",
    ceoName: "Lab CEO",
    passwordHash: "fixture",
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "1000000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  targetId = randomUUID();
  calls = [];
  requestBodies = [];
  counter = 0;
  paid = "25.00";
  onSend = undefined;
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("saveVoucher")) requestBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("uploadTempFile"))
      return res.end(JSON.stringify({ objects: { filename: "lab-upload.pdf" } }));
    if (req.url?.endsWith("saveVoucher"))
      return res.end(JSON.stringify({ voucher: { id: 77, objectName: "Voucher", status: 50 } }));
    if (req.url?.endsWith("sendViaEmail")) {
      counter++;
      onSend?.();
      return res.end(JSON.stringify({ id: 88, objectName: "Email" }));
    }
    if (req.url === "/Invoice/123")
      return res.end(
        JSON.stringify({
          objects: [
            {
              id: 123,
              contact: { id: 8 },
              invoiceType: "RE",
              invoiceNumber: "R-123",
              status: 200,
              currency: "EUR",
              sumGross: "119.00",
              paidAmount: paid,
              invoiceDate: "2026-01-01T00:00:00Z",
              timeToPay: 14,
            },
          ],
        }),
      );
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as import("node:net").AddressInfo).port;
  config = configSchema.parse({
    liveExecutionEnabled: true,
    connections: [
      {
        id: targetId,
        scope,
        provider: "sevdesk",
        baseUrl: `http://127.0.0.1:${port}`,
        secretRef: { provider: "proton-pass", shareId: "lab", itemId: "lab", field: "password" },
        enabledTools: [
          "sevdesk.voucher.upload",
          "sevdesk.voucher.stage",
          "sevdesk.invoice.read",
          "sevdesk.reminder.send",
        ],
        schemaTag: "fixture",
      },
    ],
  });
  // Explicit loopback HTTP fixture; the public configuration schema never exposes this escape hatch.
  Object.assign(config.connections[0]!, { allowHttp: true });
});
afterEach(async () => {
  await repo.close();
  server.close();
  await once(server, "close");
  await rm(directory, { recursive: true, force: true });
});
const service = () =>
  new FinanceService({
    repo,
    directory,
    configuration: async () => config,
    secrets: { resolve: async () => "lab-token" },
    now: clock,
  });
async function mandate() {
  const id = randomUUID();
  await repo.createMandate({
    id,
    scope,
    version: 1,
    allowedToolIds: [
      "sevdesk.voucher.upload",
      "sevdesk.voucher.stage",
      "sevdesk.invoice.read",
      "sevdesk.reminder.send",
    ],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  });
  return id;
}
async function voucher(reference = "V-1", totalMinor = "11900") {
  const order = await repo.createOrder(scope, { kind: "finance", goal: "Finance fixture", budgetLimitUsdMicros: "0" });
  const bytes = Buffer.from(`%PDF-1.4\n${reference}\n%%EOF`);
  const result = await new FinanceWorkflow(repo, directory).ingest(scope, order.id, {
    originalSha256: digest(bytes),
    originalBase64: bytes.toString("base64"),
    mediaType: "application/pdf",
    voucherDate: "01.09.2026",
    invoice: {
      id: reference,
      supplierId: "supplier-8",
      direction: "payable",
      reference,
      currency: "EUR",
      totalMinor,
      paidMinor: "0",
      dueAt: "2026-09-30T00:00:00Z",
      observedAt: new Date().toISOString(),
      source: "original-voucher",
      disputed: false,
      paymentPause: false,
    },
  });
  return { ...result, order };
}
async function rule(voucherId: string) {
  return new FinanceAutomation(repo).propose(scope, setup.ceo.id, {
    scope,
    sourceVoucherId: voucherId,
    supplierId: "supplier-8",
    currency: "EUR",
    minTotalMinor: "10000",
    maxTotalMinor: "13000",
    mediaTypes: ["application/pdf"],
    targetId,
    mandateId: await mandate(),
    mandateVersion: 1,
    sevdeskSupplierId: 8,
    accountDatevId: 10,
    taxRuleId: "1",
    taxRate: 19,
    source: "Explicit routine for office supplies",
  });
}
it("requires real finance lead review and explicit activation; exports a matching voucher once through HTTP", async () => {
  const v = await voucher(),
    r = await rule(v.voucherId),
    a = new FinanceAutomation(repo);
  await expect(a.activate(scope, r.id, setup.ceo.id)).rejects.toThrow("finance_review_required");
  await expect(a.review(scope, r.id, setup.ceo.id, "review")).rejects.toThrow("finance_lead_required");
  await a.review(
    scope,
    r.id,
    setup.employees.find((e) => e.seedKey === "finance")!.id,
    "Source, account and amount bounds checked",
  );
  await a.activate(scope, r.id, setup.ceo.id);
  const result = await service().process(scope, v.voucherId);
  expect(result).toMatchObject({ state: "draft_created", externalId: "77" });
  await service().process(scope, v.voucherId);
  expect(calls.filter((x) => x.startsWith("POST"))).toHaveLength(2);
  const exception = await voucher("V-2", "30000");
  expect(await service().process(scope, exception.voucherId)).toEqual({ state: "needs_review" });
  expect(calls).toHaveLength(2);
});
it("rejects overlapping rules and a revoked rule prevents exports", async () => {
  const v = await voucher(),
    r = await rule(v.voucherId),
    a = new FinanceAutomation(repo),
    lead = setup.employees.find((e) => e.seedKey === "finance")!.id;
  await a.review(scope, r.id, lead, "reviewed");
  await a.activate(scope, r.id, setup.ceo.id);
  const other = await rule(v.voucherId);
  await expect(a.review(scope, other.id, lead, "overlap")).rejects.toThrow("processing_rules_overlap");
  await a.disable(scope, "finance-processing-rule", r.id, setup.ceo.id);
  expect(await service().process(scope, v.voucherId)).toEqual({ state: "needs_review" });
  expect(calls).toHaveLength(0);
});
async function reminder() {
  const order = await repo.createOrder(scope, { kind: "finance", goal: "Reminder fixture", budgetLimitUsdMicros: "0" });
  const a = new FinanceAutomation(repo);
  const p = await a.proposeReminder(scope, setup.ceo.id, {
    scope,
    orderId: order.id,
    targetId,
    mandateId: await mandate(),
    mandateVersion: 1,
    invoiceId: "123",
    recipient: "customer@example.invalid",
    stage: 1,
    minOverdueDays: 1,
    maxDataAgeSeconds: 60,
    subject: "Payment reminder",
    text: "Please check invoice R-123.",
    intervalSeconds: 60,
  });
  await a.activateReminder(scope, p.id, setup.ceo.id);
  return p;
}
it("polls fresh partial payment before sending an approved reminder and deduplicates later ticks", async () => {
  const p = await reminder();
  await service().tick(scope.companyId);
  expect(counter).toBe(1);
  expect(calls.filter((x) => x === "GET /Invoice/123").length).toBeGreaterThanOrEqual(2);
  await service().remind(scope, p.id);
  expect(counter).toBe(1);
});
it("full payment and revoked policy suppress actual HTTP send", async () => {
  const p = await reminder();
  paid = "119.00";
  await service().tick(scope.companyId);
  expect(counter).toBe(0);
  await new FinanceAutomation(repo).disable(scope, "finance-reminder-policy", p.id, setup.ceo.id);
  paid = "0";
  await expect(service().remind(scope, p.id)).rejects.toThrow("reminder_rule_denied");
  expect(counter).toBe(0);
});
it("does not guess missing paid amount or null payment terms", () => {
  const input = {
    objects: [
      {
        id: 123,
        contact: { id: 8 },
        invoiceNumber: "R-123",
        invoiceType: "RE",
        status: 200,
        currency: "EUR",
        sumGross: "119",
        paidAmount: null,
        invoiceDate: "2026-01-01T00:00:00Z",
        timeToPay: 14,
      },
    ],
  };
  expect(() =>
    normalizeSevdeskInvoice(input, new Date().toISOString(), targetId, { disputed: false, paymentPause: false }),
  ).toThrow("payment_data_incomplete");
});
it("rechecks payments after delayed secret resolution immediately before HTTP send", async () => {
  const p = await reminder();
  let resolutions = 0;
  const s = new FinanceService({
    repo,
    directory,
    configuration: async () => config,
    secrets: {
      resolve: async () => {
        resolutions++;
        // The third credential resolution belongs to send, after the first two payment reads.
        if (resolutions === 3) paid = "119.00";
        return "lab-token";
      },
    },
  });
  await s.remind(scope, p.id);
  expect(counter).toBe(0);
  expect(
    (await repo.listDocuments(scope, "action")).some((d) => (d.data as { status: string }).status === "effect_unknown"),
  ).toBe(true);
  await s.remind(scope, p.id);
  expect(counter).toBe(0);
});
it("restored financial policies stay disabled after dispatch recovery is released", async () => {
  const v = await voucher(),
    r = await rule(v.voucherId),
    a = new FinanceAutomation(repo);
  await a.review(scope, r.id, setup.employees.find((e) => e.seedKey === "finance")!.id, "reviewed source");
  await a.activate(scope, r.id, setup.ceo.id);
  const p = await reminder();
  const db = path.join(directory, "db.sqlite");
  await repo.close();
  const { prepareRecovery } = await import("../../packages/operations/src/recovery.ts");
  await prepareRecovery(db);
  repo = await Repository.open(db);
  expect((await repo.getDocument<{ state: string }>(scope, "finance-processing-rule", r.id))?.data.state).toBe(
    "disabled",
  );
  expect((await repo.getDocument<{ state: string }>(scope, "finance-reminder-policy", p.id))?.data.state).toBe(
    "disabled",
  );
  expect(await repo.getDocument(scope, "reminder-rule-revocation", `${p.id}:1`)).toBeTruthy();
});
it("atomically rejects competing reminder policies for one invoice and stage, including after restart", async () => {
  const order = await repo.createOrder(scope, {
    kind: "finance",
    goal: "Concurrent reminder",
    budgetLimitUsdMicros: "0",
  });
  const input = {
    scope,
    orderId: order.id,
    targetId,
    mandateId: await mandate(),
    mandateVersion: 1,
    invoiceId: "123",
    recipient: "customer@example.invalid",
    stage: 1,
    minOverdueDays: 1,
    maxDataAgeSeconds: 60,
    subject: "Payment reminder",
    text: "Check R-123",
    intervalSeconds: 60,
  };
  const results = await Promise.allSettled([
    new FinanceAutomation(repo).proposeReminder(scope, setup.ceo.id, input),
    new FinanceAutomation(repo).proposeReminder(scope, setup.ceo.id, input),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "reminder_stage_already_configured" });
  const policies = await repo.listDocuments(scope, "finance-reminder-policy");
  expect(policies).toHaveLength(1);
  await repo.close();
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  await expect(new FinanceAutomation(repo).proposeReminder(scope, setup.ceo.id, input)).rejects.toMatchObject({
    code: "reminder_stage_already_configured",
  });
  await new FinanceAutomation(repo).activateReminder(scope, policies[0]!.id, setup.ceo.id);
  await service().remind(scope, policies[0]!.id);
  expect(counter).toBe(1);
});
it("activates at most one overlapping processing rule under concurrent approval", async () => {
  const v = await voucher(),
    first = await rule(v.voucherId),
    second = await rule(v.voucherId);
  const lead = setup.employees.find((e) => e.seedKey === "finance")!.id;
  await new FinanceAutomation(repo).review(scope, first.id, lead, "checked source");
  await new FinanceAutomation(repo).review(scope, second.id, lead, "checked source");
  const results = await Promise.allSettled([
    new FinanceAutomation(repo).activate(scope, first.id, setup.ceo.id),
    new FinanceAutomation(repo).activate(scope, second.id, setup.ceo.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (await repo.listDocuments<{ state: string }>(scope, "finance-processing-rule")).filter(
      (r) => r.data.state === "active",
    ),
  ).toHaveLength(1);
  await repo.close();
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  expect(await service().process(scope, v.voucherId)).toMatchObject({ state: "draft_created" });
});
it.each(["", " ", false, true, null, undefined, "1.5"])("rejects unreliable payment terms %j", (timeToPay) => {
  expect(() =>
    normalizeSevdeskInvoice(
      {
        objects: [
          {
            id: 123,
            contact: { id: 8 },
            invoiceNumber: "R-123",
            invoiceType: "RE",
            status: 200,
            currency: "EUR",
            sumGross: "119",
            paidAmount: "0",
            invoiceDate: "2026-01-01T00:00:00Z",
            timeToPay,
          },
        ],
      },
      new Date().toISOString(),
      targetId,
      { disputed: false, paymentPause: false },
    ),
  ).toThrow("payment_data_incomplete");
});
it("blocks HTTP effects when connection is disabled during secret resolution", async () => {
  const p = await reminder();
  let resolutions = 0;
  const s = new FinanceService({
    repo,
    directory,
    configuration: async () => config,
    secrets: {
      resolve: async () => {
        if (++resolutions === 3) config = { ...config, liveExecutionEnabled: false };
        return "lab-token";
      },
    },
  });
  await s.remind(scope, p.id);
  expect(counter).toBe(0);
  expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
});

it("applies a typed one-off correction to the actual sevdesk payload and preserves the original/payment data", async () => {
  const v = await voucher(),
    base = await rule(v.voucherId),
    automation = new FinanceAutomation(repo),
    corrections = new FinanceCorrections(repo, directory),
    lead = setup.employees.find((e) => e.seedKey === "finance")!.id;
  await automation.review(scope, base.id, lead, "Original/account bounds checked");
  await automation.activate(scope, base.id, setup.ceo.id);
  const before = (await repo.getDocument(scope, "voucher", v.voucherId))!.data as Record<string, unknown>;
  await corrections.correct(scope, v.voucherId, {
    field: "accountDatevId",
    value: 42,
    source: "CEO original account correction",
    reuse: false,
  });
  await expect(
    corrections.correct(scope, v.voucherId, {
      field: "paidMinor",
      value: "11900",
      source: "No fabricated payment",
      reuse: false,
    }),
  ).rejects.toThrow();
  await expect(
    corrections.correct(scope, v.voucherId, {
      field: "taxRate",
      value: "19",
      source: "Typed values only",
      reuse: false,
    }),
  ).rejects.toThrow();
  const result = await service().process(scope, v.voucherId);
  expect(requestBodies[0]).toMatchObject({ voucherPosSave: [{ accountDatev: { id: 42 }, sumGross: 119 }] });
  expect(result).toMatchObject({
    classification: { accountDatevId: 42 },
    corrections: [{ field: "accountDatevId", value: 42 }],
  });
  const after = (await repo.getDocument(scope, "voucher", v.voucherId))!.data as Record<string, unknown>;
  expect(after.originalSha256).toBe(before.originalSha256);
  expect(after.invoice).toEqual(before.invoice);
  await expect(
    corrections.correct(scope, v.voucherId, {
      field: "accountDatevId",
      value: 43,
      source: "Cannot rewrite already sent draft",
      reuse: false,
    }),
  ).rejects.toThrow("Der Beleg ist bereits");
});
it("reuses only reviewed and CEO-activated scoped corrections, records applications and respects deactivation", async () => {
  const first = await voucher("FIRST"),
    second = await voucher("SECOND"),
    third = await voucher("THIRD"),
    base = await rule(first.voucherId),
    lead = setup.employees.find((e) => e.seedKey === "finance")!.id,
    a = new FinanceAutomation(repo),
    c = new FinanceCorrections(repo, directory);
  await a.review(scope, base.id, lead, "Base reviewed");
  await a.activate(scope, base.id, setup.ceo.id);
  const proposal = await c.correct(scope, first.voucherId, {
    field: "accountDatevId",
    value: 42,
    source: "Confirmed supplier allocation",
    reuse: true,
    scopeDescription: "This supplier / EUR / PDF / exact project scope",
  });
  if (!proposal.id) throw new Error("Expected reusable rule");
  expect((await c.resolve(scope, second.voucherId, base)).classification.accountDatevId).toBe(10);
  await expect(c.activate(scope, proposal.id, setup.ceo.id)).rejects.toThrow("finance_review_required");
  await expect(c.review(scope, proposal.id, setup.ceo.id, "Fake review")).rejects.toThrow("finance_lead_required");
  await c.review(scope, proposal.id, lead, "Original hash, supplier and conflicting rules checked");
  expect((await c.resolve(scope, second.voucherId, base)).classification.accountDatevId).toBe(10);
  await c.activate(scope, proposal.id, setup.ceo.id);
  const output = await service().process(scope, second.voucherId);
  expect(requestBodies[0]).toMatchObject({ voucherPosSave: [{ accountDatev: { id: 42 } }] });
  expect(output).toMatchObject({
    corrections: [{ ruleId: proposal.id, ruleVersion: 1, field: "accountDatevId", value: 42 }],
  });
  const overlap = await c.correct(scope, third.voucherId, {
    field: "accountDatevId",
    value: 44,
    source: "Conflicting proposal",
    reuse: true,
    scopeDescription: "Same supplier",
  });
  await expect(c.review(scope, overlap.id!, lead, "Check conflict")).rejects.toThrow("correction_rules_overlap");
  await c.disable(scope, proposal.id, setup.ceo.id);
  // New matching vouchers use the unchanged base rule after deactivation.
  const fourth = await voucher("FOURTH");
  expect((await c.resolve(scope, fourth.voucherId, base)).classification.accountDatevId).toBe(10);
  await c.review(scope, overlap.id!, lead, "Conflict removed and source checked");
  await c.activate(scope, overlap.id!, setup.ceo.id);
  expect((await c.resolve(scope, fourth.voucherId, base)).classification.accountDatevId).toBe(44);
});
it("rejects changed original bindings and changes after classification sealing", async () => {
  const v = await voucher(),
    base = await rule(v.voucherId),
    c = new FinanceCorrections(repo, directory);
  await c.correct(scope, v.voucherId, { field: "taxRate", value: 7, source: "Verified reduced rate", reuse: false });
  const prior = await c.resolve(scope, v.voucherId, base),
    doc = (await repo.getDocument<Record<string, unknown>>(scope, "voucher", v.voucherId))!;
  await c.seal(scope, v.voucherId, prior.fingerprint, doc.revision);
  await expect(
    c.correct(scope, v.voucherId, { field: "taxRate", value: 19, source: "Late change", reuse: false }),
  ).rejects.toThrow("Der Beleg ist bereits");
  await expect(c.seal(scope, v.voucherId, "changed", doc.revision)).rejects.toThrow("voucher_classification_changed");
  const other = await voucher("OTHER"),
    otherDoc = (await repo.getDocument<Record<string, unknown>>(scope, "voucher", other.voucherId))!;
  await repo.putDocument(
    scope,
    "voucher",
    other.voucherId,
    { ...otherDoc.data, classificationCorrectionIds: doc.data.classificationCorrectionIds },
    { expectedRevision: otherDoc.revision },
  );
  await expect(c.resolve(scope, other.voucherId, base)).rejects.toThrow("correction_source_changed");
});

it("revises an exported source rule through renewed review and atomically replaces its active predecessor", async () => {
  const first = await voucher("REVISION-SOURCE"),
    second = await voucher("REVISION-NEXT"),
    base = await rule(first.voucherId),
    lead = setup.employees.find((e) => e.seedKey === "finance")!.id,
    c = new FinanceCorrections(repo, directory),
    a = new FinanceAutomation(repo);
  await a.review(scope, base.id, lead, "Base reviewed");
  await a.activate(scope, base.id, setup.ceo.id);
  const proposal = await c.correct(scope, first.voucherId, {
    field: "accountDatevId",
    value: 42,
    source: "Initial mapping",
    reuse: true,
    scopeDescription: "Exact supplier scope",
  });
  await c.review(scope, proposal.id!, lead, "Checked source and conflicts");
  await c.activate(scope, proposal.id!, setup.ceo.id);
  await service().process(scope, first.voucherId);
  const exported = await repo.getDocument(scope, "finance-voucher-export", first.voucherId);
  const revision = await c.revise(
    scope,
    proposal.id!,
    { value: 43, source: "Correct future account mapping" },
    setup.ceo.id,
  );
  expect(revision).toMatchObject({ version: 2, supersedesId: proposal.id, state: "proposed" });
  expect((await c.resolve(scope, second.voucherId, base)).classification.accountDatevId).toBe(42);
  await expect(c.activate(scope, revision.id, setup.ceo.id)).rejects.toThrow("finance_review_required");
  await c.review(scope, revision.id, lead, "Rechecked original, corrected classification and conflicts");
  expect((await c.resolve(scope, second.voucherId, base)).classification.accountDatevId).toBe(42);
  await c.activate(scope, revision.id, setup.ceo.id);
  expect((await repo.getDocument(scope, "finance-rule", proposal.id!))?.data).toMatchObject({ state: "disabled" });
  const output = await service().process(scope, second.voucherId);
  expect(requestBodies[1]).toMatchObject({ voucherPosSave: [{ accountDatev: { id: 43 } }] });
  expect(output).toMatchObject({ corrections: [{ ruleId: revision.id, ruleVersion: 2, value: 43 }] });
  expect(await repo.getDocument(scope, "finance-voucher-export", first.voucherId)).toEqual(exported);
  const oldBranch = await c.revise(scope, proposal.id!, { value: 44, source: "Obsolete branch" }, setup.ceo.id);
  await expect(c.review(scope, oldBranch.id, lead, "Conflict check")).rejects.toThrow("correction_rules_overlap");
});

it("serializes a racing one-off correction and export seal with one winner", async () => {
  const v = await voucher("RACE"),
    base = await rule(v.voucherId),
    c = new FinanceCorrections(repo, directory);
  const resolved = await c.resolve(scope, v.voucherId, base),
    doc = (await repo.getDocument(scope, "voucher", v.voucherId))!;
  const results = await Promise.allSettled([
    c.seal(scope, v.voucherId, resolved.fingerprint, doc.revision),
    c.correct(scope, v.voucherId, {
      field: "taxRate",
      value: 7,
      source: "Concurrent verified correction",
      reuse: false,
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
});
