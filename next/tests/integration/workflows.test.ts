import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import type { Scope, ApprovalBinding, ToolAction } from "../../packages/contracts/src/index.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import { FinanceWorkflow, type Invoice } from "../../packages/domain/workflows/finance.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { Channels, Scheduler } from "../../packages/domain/workflows/automation.ts";
import { digest } from "../../packages/tools/workspace.ts";
let repo: Repository, directory: string, setup: SetupResult, scope: Scope;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-flows-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  setup = await repo.setup({
    companyName: "Fixture",
    ceoName: "CEO",
    passwordHash: "test-only",
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "1000000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
it("real static delivery, selected concept, pins, independent review and distinct publish approval", async () => {
  const order = await repo.createOrder(scope, { kind: "website", goal: "Fixture Site", budgetLimitUsdMicros: "0" });
  const web = new WebsiteWorkflow(repo, directory);
  await web.create(scope, order.id, "Fixture brief");
  const concepts = await web.concepts(
    scope,
    order.id,
    Array.from({ length: 5 }, (_, i) => ({
      name: `Direction ${i}`,
      rationale: `Different layout ${i}`,
      html: `<!doctype html><html lang="de"><meta name="viewport" content="width=device-width"><title>Fixture ${i}</title><h1>Direction ${i}</h1></html>`,
    })),
  );
  await web.select(scope, order.id, concepts.data.concepts[2]!.id);
  const artifact = await web.build(scope, order.id);
  expect((await web.preview(artifact.id)).toString()).toContain("Direction 2");
  expect(await readFile(path.join(directory, "sites", artifact.id, "server.mjs"), "utf8")).toContain("createServer");
  const child = spawn(process.execPath, [path.join(directory, "sites", artifact.id, "server.mjs")], {
    env: { PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    const [ready] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Selfhosting process exited before ready");
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Selfhosting startup timeout")), 5000);
        timer.unref();
      }),
    ]);
    const port = (ready as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Direction 2");
    expect((await fetch(`http://127.0.0.1:${port}/missing`)).status).toBe(404);
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  const pin = await web.pin(scope, order.id, {
    artifactVersionId: artifact.id,
    viewport: { width: 390, height: 844 },
    anchor: "h1",
    comment: "Headline feedback",
  });
  expect(pin.data.artifactVersionId).toBe(artifact.id);
  await expect(web.accept(scope, order.id, artifact.id)).rejects.toThrow("acceptance_checks_required");
  await web.review(scope, order.id, {
    artifactVersionId: artifact.id,
    reviewerId: setup.employees.find((e) => e.seedKey === "quality")!.id,
    checks: ["mobile", "functional", "quality"].map((name) => ({
      name,
      passed: true,
      evidence: "test fixture assertion",
    })),
  });
  await web.resolvePin(scope, order.id, pin.id, {
    artifactVersionId: artifact.id,
    evidence: "CEO reviewed comment and accepted this version",
    reviewerId: setup.ceo.id,
  });
  await web.accept(scope, order.id, artifact.id);
  let deployments = 0;
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["website.publish"],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  const actions = new ManagedActions(repo, path.join(directory, "receipts"));
  const actionRequest = { id: randomUUID(), targetId: order.id, mandateId: mandate.id, mandateVersion: 1 };
  const deploy = async () => {
    deployments++;
    return {
      url: "https://fixture.invalid",
      httpsVerified: true,
      functionalCheckPassed: true,
      rollbackRef: "fixture-previous",
    };
  };
  const pending = await web.publish(scope, order.id, actions, actionRequest, deploy);
  expect(pending.state).toBe("approval");
  expect(deployments).toBe(0);
  const approvalRequest = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", pending.id);
  const approval = await repo.approve(scope, approvalRequest!.data.binding);
  const action = await repo.getDocument<ToolAction>(scope, "action", pending.id);
  await repo.putDocument(
    scope,
    "action",
    pending.id,
    { ...action!.data, approvalId: approval.id, status: "authorized" },
    { expectedRevision: action!.revision },
  );
  await web.select(scope, order.id, concepts.data.concepts[3]!.id);
  await web.build(scope, order.id);
  await expect(web.publish(scope, order.id, actions, actionRequest, deploy)).rejects.toThrow("site_not_accepted");
  expect(deployments).toBe(0);
});
it("deduplicates incident, verifies restoration and observes recurrence separately from cause", async () => {
  let now = new Date("2026-09-07T10:00:00Z");
  const ops = new IncidentWorkflow(repo, () => now);
  const input = {
    provider: "fixture",
    accountId: "fixture",
    eventId: "alarm-1",
    targetId: randomUUID(),
    summary: "Service down",
    budgetLimitUsdMicros: "0",
  };
  const incident = await ops.ingest(scope, input);
  expect((await ops.ingest(scope, input)).data.id).toBe(incident.data.id);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
  await ops.diagnose(scope, incident.id, {
    evidence: "fixture service state stopped",
    causeStatus: "suspected",
    explanation: "Service exited",
  });
  expect(
    (
      await ops.check(scope, incident.id, 30, async () => ({
        ok: true,
        evidence: "Independent HTTP health returned ready",
      }))
    ).data.state,
  ).toBe("observing");
  now = new Date(now.getTime() + 10000);
  expect(
    (await ops.check(scope, incident.id, 30, async () => ({ ok: false, evidence: "HTTP connection refused" }))).data
      .state,
  ).toBe("investigating");
  await ops.check(scope, incident.id, 30, async () => ({ ok: true, evidence: "HTTP ready" }));
  now = new Date(now.getTime() + 31000);
  const resolved = await ops.check(scope, incident.id, 30, async () => ({ ok: true, evidence: "HTTP still ready" }));
  expect(resolved.data.state).toBe("resolved");
  expect(resolved.data.cause.status).toBe("suspected");
  const child = await ops.prevention(scope, incident.id, "Find root cause", "0");
  expect(child.status).toBe("inbox");
});
it("deduplicates vouchers, keeps partial payment and bank changes explicit, never learns implicitly", async () => {
  const finance = new FinanceWorkflow(repo, directory, () => new Date("2026-09-07T10:00:00Z"));
  const order = await repo.createOrder(scope, { kind: "finance", goal: "Fixture voucher", budgetLimitUsdMicros: "0" });
  const invoice: Invoice = {
    id: "invoice-1",
    supplierId: "supplier-1",
    reference: "ref-1",
    currency: "EUR",
    totalMinor: "12000",
    paidMinor: "2000",
    dueAt: "2026-09-01T00:00:00Z",
    observedAt: "2026-09-07T09:59:00Z",
    source: "fixture:sevdesk:invoice-1",
    disputed: false,
    paymentPause: false,
  };
  const receipt = await finance.ingest(scope, order.id, {
    originalSha256: digest("%PDF-1.7\nfixture-pdf\n%%EOF"),
    originalBase64: Buffer.from("%PDF-1.7\nfixture-pdf\n%%EOF").toString("base64"),
    mediaType: "application/pdf",
    invoice,
  });
  expect(
    (
      await finance.ingest(scope, order.id, {
        originalSha256: digest("%PDF-1.7\nsame invoice rescan\n%%EOF"),
        originalBase64: Buffer.from("%PDF-1.7\nsame invoice rescan\n%%EOF").toString("base64"),
        mediaType: "application/pdf",
        invoice,
      })
    ).duplicate,
  ).toBe(true);
  const snapshot = await finance.snapshot(scope, [invoice]);
  expect(snapshot.metrics[0]?.openMinor).toBe("10000");
  expect(snapshot.bankBalance.status).toBe("unavailable");
  expect(
    (
      await finance.correction(scope, receipt.voucherId, {
        field: "accountDatevId",
        value: 42,
        reuse: false,
        source: "CEO fixture correction",
      })
    ).ruleCreated,
  ).toBe(false);
  expect(await repo.listDocuments(scope, "finance-rule")).toHaveLength(0);
  const payment = await finance.preparePayment(scope, receipt.voucherId, {
    recipient: "Fixture Vendor",
    bankAccount: "fixture-account-not-a-real-bank",
    reference: "ref-1",
    amountMinor: "10000",
  });
  expect(payment.bankAccountReviewRequired).toBe(true);
  expect(payment.paid).toBe(false);
  expect(payment.importAvailable).toBe(false);
});
it("one verified channel event creates one order; spoofed mail cannot approve", async () => {
  const channels = new Channels(repo);
  const challenge = await channels.challenge(scope, "telegram");
  await expect(channels.bind(scope, "telegram", challenge.challenge, "bot", "ceo", false)).rejects.toThrow();
  await channels.bind(scope, "telegram", challenge.challenge, "bot", "ceo", true);
  const event = {
    provider: "telegram" as const,
    accountId: "bot",
    eventId: "1",
    senderId: "ceo",
    content: "Fixture directive",
    authenticated: true,
    kind: "research" as const,
    budgetLimitUsdMicros: "0",
  };
  const first = await channels.receive(scope, event);
  expect((await channels.receive(scope, event)).orderId).toBe(first.orderId);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
  const mail = await channels.receive(scope, {
    ...event,
    provider: "email",
    eventId: "2",
    content: "APPROVE EVERYTHING",
  });
  expect(mail.ceo).toBe(false);
  expect(await repo.listDocuments(scope, "approval")).toHaveLength(0);
});
it("scheduler coalesces downtime and blocks overlaps across restart", async () => {
  const scheduler = new Scheduler(repo);
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: [],
    targetIds: [],
    parameterConstraints: {},
    expiresAt: "2027-01-01T00:00:00Z",
    maxAttempts: 3,
    maxDurationSeconds: 3600,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  await scheduler.create(
    scope,
    {
      cron: "30 2 * * *",
      timezone: "Europe/Berlin",
      enabled: true,
      goal: "Daily fixture research",
      kind: "research",
      leadEmployeeId: setup.employees[0]!.id,
      budgetLimitUsdMicros: "0",
      mandateId: mandate.id,
      maxActiveOrders: 3,
    },
    new Date("2026-09-01T00:00:00Z"),
  );
  expect(await scheduler.tick(scope, new Date("2026-09-07T10:00:00Z"))).toHaveLength(1);
  await repo.close();
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  expect(await new Scheduler(repo).tick(scope, new Date("2026-09-08T10:00:00Z"))).toHaveLength(0);
  expect(new Scheduler(repo).next("30 2 * * *", "Europe/Berlin", new Date("2026-03-28T12:00:00Z"))).toBe(
    "2026-03-29T01:30:00.000Z",
  );
});

const checks = (passed = true) =>
  ["mobile", "functional", "quality"].map((name) => ({ name, passed, evidence: "Named local fixture inspection" }));
async function testMandate(toolIds: string[], targetId: string, cost = "1000000") {
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: toolIds,
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: "2027-01-01T00:00:00Z",
    maxAttempts: 3,
    maxDurationSeconds: 3600,
    maxCostUsdMicros: cost,
  };
  await repo.createMandate(mandate);
  return mandate;
}
const testInvoice = (): Invoice => ({
  id: "invoice-1",
  supplierId: "supplier-1",
  reference: "reference-1",
  currency: "EUR",
  totalMinor: "10000",
  paidMinor: "2500",
  dueAt: "2026-09-01T00:00:00Z",
  observedAt: "2026-09-07T09:59:59Z",
  source: "fixture:sevdesk:invoice-1",
  disputed: false,
  paymentPause: false,
});
function voucher(invoice = testInvoice()) {
  const original = "%PDF-1.7\nexplicit local test fixture\n%%EOF";
  return {
    invoice,
    originalSha256: digest(original),
    originalBase64: Buffer.from(original).toString("base64"),
    mediaType: "application/pdf" as const,
  };
}
it("creates exactly one incident, followup and inbox order under simultaneous duplicate deliveries", async () => {
  const ops = new IncidentWorkflow(repo),
    alarm = {
      provider: "fixture",
      accountId: "fixture",
      eventId: "same-alarm",
      targetId: randomUUID(),
      summary: "One alarm",
      budgetLimitUsdMicros: "0",
    };
  const results = await Promise.all(Array.from({ length: 10 }, () => ops.ingest(scope, alarm)));
  expect(new Set(results.map((d) => d.id)).size).toBe(1);
  const followups = await Promise.all(
    Array.from({ length: 10 }, () => ops.prevention(scope, results[0]!.id, "One prevention task", "0")),
  );
  expect(new Set(followups.map((d) => d.id)).size).toBe(1);
  const channels = new Channels(repo),
    event = {
      provider: "email" as const,
      accountId: "account",
      eventId: "same-email",
      senderId: "external",
      content: "One message",
      authenticated: true,
      kind: "research" as const,
      budgetLimitUsdMicros: "0",
    };
  const inbox = await Promise.all(Array.from({ length: 10 }, () => channels.receive(scope, event)));
  expect(inbox.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(3);
  await expect(channels.receive(scope, { ...event, content: "Changed message under same key" })).rejects.toThrow(
    "inbox_event_conflict",
  );
  await expect(ops.ingest(scope, { ...alarm, targetId: randomUUID() })).rejects.toThrow("inbox_event_conflict");
});
it("binds action identity to tool, target, scope and mandate and executes concurrent repeats once", async () => {
  const order = await repo.createOrder(scope, { kind: "incident", goal: "Repair fixture", budgetLimitUsdMicros: "0" }),
    mandate = await testMandate(["fixture.restart"], order.id, "0"),
    actions = new ManagedActions(repo, path.join(directory, "managed-receipts"));
  const request = {
    id: randomUUID(),
    orderId: order.id,
    scope,
    toolId: "fixture.restart",
    targetId: order.id,
    args: { service: "fixture" },
    effect: "external_change" as const,
    mandateId: mandate.id,
    mandateVersion: 1,
  };
  let effects = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      actions.perform(request, async () => {
        effects++;
        return { restarted: true };
      }),
    ),
  );
  expect(results.every((r) => r.state === "succeeded")).toBe(true);
  expect(effects).toBe(1);
  await expect(actions.perform({ ...request, targetId: randomUUID() }, async () => null)).rejects.toThrow(
    "action_binding_conflict",
  );
  await expect(actions.perform({ ...request, toolId: "fixture.other" }, async () => null)).rejects.toThrow(
    "action_binding_conflict",
  );
  const forced = await actions.perform({ ...request, id: randomUUID(), requireApproval: true }, async () => {
    effects++;
    return null;
  });
  expect(forced.state).toBe("approval");
  expect(effects).toBe(1);
});
it("persists actual voucher bytes, denies fake hashes and deduplicates concurrent uploads atomically", async () => {
  const finance = new FinanceWorkflow(repo, directory),
    order = await repo.createOrder(scope, { kind: "finance", goal: "Voucher fixture", budgetLimitUsdMicros: "0" }),
    input = voucher();
  const uploads = await Promise.all(Array.from({ length: 10 }, () => finance.ingest(scope, order.id, input)));
  expect(uploads.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(await repo.listDocuments(scope, "voucher")).toHaveLength(1);
  expect(digest(await readFile(path.join(directory, "blobs", input.originalSha256)))).toBe(input.originalSha256);
  await expect(finance.ingest(scope, order.id, { ...input, originalSha256: digest("lie") })).rejects.toThrow(
    "voucher_hash_mismatch",
  );
  const html = "<script>fake PDF</script>";
  await expect(
    finance.ingest(scope, order.id, {
      ...input,
      originalBase64: Buffer.from(html).toString("base64"),
      originalSha256: digest(html),
    }),
  ).rejects.toThrow("voucher_mime_mismatch");
  await expect(finance.snapshot(scope, [input.invoice, input.invoice])).rejects.toThrow(
    "duplicate_invoice_in_snapshot",
  );
  const before = await repo.getDocument(scope, "voucher", uploads[0]!.voucherId);
  await expect(
    finance.correction(scope, uploads[0]!.voucherId, {
      field: "accountDatevId",
      value: 43,
      reuse: true,
      source: "CEO",
    }),
  ).rejects.toThrow("rule_scope_required");
  expect((await repo.getDocument(scope, "voucher", uploads[0]!.voucherId))?.revision).toBe(before?.revision);
});
it("sends an exact approved reminder routine once and keeps send timeout as unknown without a second send", async () => {
  const finance = new FinanceWorkflow(repo, directory, () => new Date("2026-09-07T10:00:00Z")),
    order = await repo.createOrder(scope, { kind: "finance", goal: "Reminder fixture", budgetLimitUsdMicros: "0" }),
    targetId = randomUUID(),
    mandate = await testMandate(["sevdesk.reminder.send"], targetId, "0"),
    actions = new ManagedActions(repo, path.join(directory, "reminder-receipts"));
  const rule = {
    id: randomUUID(),
    version: 1,
    approvedByCeo: true,
    enabled: true,
    invoiceIds: ["invoice-1"],
    recipients: ["recipient@example.invalid"],
    targetIds: [targetId],
    minOverdueDays: 1,
    maxDataAgeSeconds: 60,
    stage: 1,
    feesMinor: "0" as const,
  };
  await repo.putDocument(scope, "reminder-rule", `${rule.id}:1`, rule, { immutable: true });
  let sends = 0;
  const request = { toolId: "sevdesk.reminder.send", targetId, mandateId: mandate.id, mandateVersion: 1 };
  const send = async () => {
    sends++;
    throw new Error("Lost provider response after sending");
  };
  const first = await finance.reminder(
    scope,
    order.id,
    rule,
    "invoice-1",
    "recipient@example.invalid",
    actions,
    request,
    async () => testInvoice(),
    send,
  );
  expect(first.state).toBe("effect_unknown");
  const repeated = await finance.reminder(
    scope,
    order.id,
    rule,
    "invoice-1",
    "recipient@example.invalid",
    actions,
    request,
    async () => testInvoice(),
    send,
  );
  expect(repeated.state).toBe("already_processed");
  expect(sends).toBe(1);
  expect(await repo.listDocuments(scope, "approval-request")).toHaveLength(0);
  await expect(
    finance.reminder(
      scope,
      order.id,
      { ...rule, version: 2 },
      "invoice-1",
      "recipient@example.invalid",
      actions,
      request,
      async () => testInvoice(),
      send,
    ),
  ).rejects.toThrow("reminder_rule_denied");
});
it("rechecks payment data immediately before reminder send and suppresses newly paid or disputed invoices", async () => {
  const finance = new FinanceWorkflow(repo, directory, () => new Date("2026-09-07T10:00:00Z")),
    order = await repo.createOrder(scope, { kind: "finance", goal: "Reminder freshness", budgetLimitUsdMicros: "0" }),
    targetId = randomUUID(),
    mandate = await testMandate(["sevdesk.reminder.send"], targetId, "0"),
    actions = new ManagedActions(repo, path.join(directory, "freshness-receipts"));
  const rule = {
    id: randomUUID(),
    version: 1,
    approvedByCeo: true,
    enabled: true,
    invoiceIds: ["invoice-1"],
    recipients: ["recipient@example.invalid"],
    targetIds: [targetId],
    minOverdueDays: 1,
    maxDataAgeSeconds: 60,
    stage: 1,
    feesMinor: "0" as const,
  };
  await repo.putDocument(scope, "reminder-rule", `${rule.id}:1`, rule, { immutable: true });
  let reads = 0,
    sends = 0;
  const result = await finance.reminder(
    scope,
    order.id,
    rule,
    "invoice-1",
    "recipient@example.invalid",
    actions,
    { toolId: "sevdesk.reminder.send", targetId, mandateId: mandate.id, mandateVersion: 1 },
    async () => {
      reads++;
      return reads === 1 ? testInvoice() : { ...testInvoice(), paidMinor: "10000" };
    },
    async () => {
      sends++;
      return { id: "never" };
    },
  );
  expect(result.state).toBe("failed");
  expect(reads).toBe(2);
  expect(sends).toBe(0);
});
it("requires real reviewer identity and full evidence, and failed rereview invalidates earlier acceptance", async () => {
  const order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Review boundaries",
      budgetLimitUsdMicros: "0",
    }),
    web = new WebsiteWorkflow(repo, directory);
  await web.create(scope, order.id, "A real briefing");
  const concepts = await web.concepts(scope, order.id, [
    { name: "One", rationale: "First", html: "<h1>One</h1>" },
    { name: "Two", rationale: "Second", html: "<h1>Two</h1>" },
  ]);
  await web.select(scope, order.id, concepts.data.concepts[0]!.id);
  const artifact = await web.build(scope, order.id);
  await expect(
    web.review(scope, order.id, {
      artifactVersionId: artifact.id,
      reviewerId: setup.employees[1]!.id,
      reviewerKind: "ceo",
      checks: checks(),
    }),
  ).rejects.toThrow("ceo_required");
  await expect(
    web.review(scope, order.id, {
      artifactVersionId: artifact.id,
      reviewerId: setup.ceo.id,
      reviewerKind: "ceo",
      checks: [{ name: "anything", passed: true, evidence: "Unrelated claim" }],
    }),
  ).rejects.toThrow("required_site_checks_missing");
  await web.review(scope, order.id, {
    artifactVersionId: artifact.id,
    reviewerId: setup.ceo.id,
    reviewerKind: "ceo",
    checks: checks(),
  });
  await web.accept(scope, order.id, artifact.id);
  await web.review(scope, order.id, {
    artifactVersionId: artifact.id,
    reviewerId: setup.ceo.id,
    reviewerKind: "ceo",
    checks: checks(false),
  });
  await expect(web.accept(scope, order.id, artifact.id)).rejects.toThrow("acceptance_checks_required");
  const site = await repo.getDocument<{ acceptedVersionId?: string }>(scope, "website", order.id);
  expect(site?.data.acceptedVersionId).toBeUndefined();
});
it("atomically schedules one catchup and honors explicit mandate revocation", async () => {
  const scheduler = new Scheduler(repo),
    mandate = await testMandate([], randomUUID(), "0");
  await scheduler.create(
    scope,
    {
      cron: "30 2 * * *",
      timezone: "Europe/Berlin",
      enabled: true,
      goal: "One catchup",
      kind: "research",
      leadEmployeeId: setup.employees[0]!.id,
      budgetLimitUsdMicros: "0",
      mandateId: mandate.id,
      maxActiveOrders: 3,
    },
    new Date("2026-09-01T00:00:00Z"),
  );
  const ticks = await Promise.all(
    Array.from({ length: 10 }, () => scheduler.tick(scope, new Date("2026-09-07T10:00:00Z"))),
  );
  expect(ticks.flat()).toHaveLength(1);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
  const revoked = await testMandate([], randomUUID(), "0");
  await scheduler.create(
    scope,
    {
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      goal: "Must not spawn",
      kind: "research",
      leadEmployeeId: setup.employees[0]!.id,
      budgetLimitUsdMicros: "0",
      mandateId: revoked.id,
      maxActiveOrders: 3,
    },
    new Date("2026-09-01T00:00:00Z"),
  );
  await repo.revokeMandate(scope, revoked.id, 1);
  expect(await scheduler.tick(scope, new Date("2026-09-08T10:00:00Z"))).toHaveLength(0);
});
it("suppresses the repeated autumn local time even when the first order already completed", async () => {
  const scheduler = new Scheduler(repo),
    mandate = await testMandate([], randomUUID(), "0");
  const schedule = await scheduler.create(
    scope,
    {
      cron: "30 2 * * *",
      timezone: "Europe/Berlin",
      enabled: true,
      goal: "DST once",
      kind: "research",
      leadEmployeeId: setup.employees[0]!.id,
      budgetLimitUsdMicros: "0",
      mandateId: mandate.id,
      maxActiveOrders: 3,
    },
    new Date("2026-10-24T12:00:00Z"),
  );
  const first = await scheduler.tick(scope, new Date("2026-10-25T00:30:00Z"));
  expect(first).toHaveLength(1);
  await repo.updateOrder(scope, first[0]!.id, first[0]!.revision, { status: "cancelled" });
  const current = await repo.getDocument(scope, "schedule", schedule.id);
  await repo.putDocument(
    scope,
    "schedule",
    schedule.id,
    { ...(current!.data as object), nextDueAt: "2026-10-25T01:30:00Z" },
    { expectedRevision: current!.revision },
  );
  expect(await scheduler.tick(scope, new Date("2026-10-25T01:30:00Z"))).toHaveLength(0);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
});

it("sends an approved reminder for the exact remaining partial balance with no individual approval", async () => {
  const finance = new FinanceWorkflow(repo, directory, () => new Date("2026-09-07T10:00:00Z")),
    order = await repo.createOrder(scope, { kind: "finance", goal: "Allowed reminder", budgetLimitUsdMicros: "0" }),
    targetId = randomUUID(),
    mandate = await testMandate(["sevdesk.reminder.send"], targetId, "0"),
    actions = new ManagedActions(repo, path.join(directory, "approved-reminder"));
  const rule = {
    id: randomUUID(),
    version: 1,
    approvedByCeo: true,
    enabled: true,
    invoiceIds: ["invoice-1"],
    recipients: ["recipient@example.invalid"],
    targetIds: [targetId],
    minOverdueDays: 1,
    maxDataAgeSeconds: 60,
    stage: 1,
    feesMinor: "0" as const,
  };
  await repo.putDocument(scope, "reminder-rule", `${rule.id}:1`, rule, { immutable: true });
  let sends = 0;
  const request = { toolId: "sevdesk.reminder.send", targetId, mandateId: mandate.id, mandateVersion: 1 };
  const result = await finance.reminder(
    scope,
    order.id,
    rule,
    "invoice-1",
    "recipient@example.invalid",
    actions,
    request,
    async () => testInvoice(),
    async (invoice) => {
      sends++;
      expect(invoice.paidMinor).toBe("2500");
      return { externalId: "fixture-reminder-1" };
    },
  );
  expect(result.state).toBe("succeeded");
  expect(sends).toBe(1);
  const action = await repo.getDocument<ToolAction>(scope, "action", result.id);
  expect((action?.data.args as { outstandingMinor: string }).outstandingMinor).toBe("7500");
  expect(await repo.listDocuments(scope, "approval-request")).toHaveLength(0);
});
it("requires approval for customer messages even when the repair mandate permits automatic changes", async () => {
  const ops = new IncidentWorkflow(repo),
    incident = await ops.ingest(scope, {
      provider: "fixture",
      accountId: "account",
      eventId: "customer-message",
      targetId: randomUUID(),
      summary: "Investigating",
      budgetLimitUsdMicros: "0",
    });
  const mandate = await testMandate(["customer.message"], incident.data.targetId, "0"),
    actions = new ManagedActions(repo, path.join(directory, "customer-message"));
  let sends = 0;
  const result = await ops.customerMessage(
    scope,
    incident.id,
    actions,
    {
      id: randomUUID(),
      toolId: "customer.message",
      targetId: incident.data.targetId,
      mandateId: mandate.id,
      mandateVersion: 1,
      args: { to: "customer@example.invalid", content: "We are investigating", incidentState: "investigating" },
    },
    async () => {
      sends++;
      return {};
    },
  );
  expect(result.state).toBe("approval");
  expect(sends).toBe(0);
});
it("retains explicit invoice direction and refuses to prepare an outgoing payment for a receivable", async () => {
  const finance = new FinanceWorkflow(repo, directory);
  const order = await repo.createOrder(scope, { kind: "finance", goal: "Direction check", budgetLimitUsdMicros: "0" });
  const invoice = { ...testInvoice(), direction: "receivable" as const };
  const result = await finance.ingest(scope, order.id, voucher(invoice));
  expect(
    (await repo.getDocument<{ invoice: Invoice }>(scope, "voucher", result.voucherId))?.data.invoice.direction,
  ).toBe("receivable");
  await expect(
    finance.preparePayment(scope, result.voucherId, {
      recipient: "Fixture",
      bankAccount: "fixture-account",
      reference: invoice.reference,
      amountMinor: "7500",
    }),
  ).rejects.toThrow("payment_direction_invalid");
  expect(await repo.listDocuments(scope, "payment-preparation")).toHaveLength(0);
});
