import { it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/control/app.ts";
import { hashPassword } from "../../apps/control/auth.ts";
import { saveConfiguration } from "../../apps/control/configuration.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { MailInboxService } from "../../apps/control/mail-inbox-service.ts";
import { registerMailInboxRoutes } from "../../apps/control/mail-inbox-routes.ts";
import { mailConnectionSchema } from "../../apps/control/mail-broker.ts";
import { tlsMailbox, mailboxCaFile, multipartMail } from "../fixtures/mailbox.ts";
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "mail-inbox-control-")),
    repo = await Repository.open(path.join(directory, "company.sqlite")),
    sink = await tlsMailbox([{ uid: 1, source: multipartMail }]);
  const setup = await repo.setup({
    companyName: "Inbox fixture",
    ceoName: "Owner",
    passwordHash: await hashPassword("mail-fixture-password-1234"),
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id },
    ceoId = setup.ceo.id;
  const target = mailConnectionSchema.parse({
    id: randomUUID(),
    scope,
    host: "127.0.0.1",
    port: sink.port,
    username: "fixture",
    secretRef: { provider: "proton-pass", shareId: "test", itemId: "test", field: "password" },
    from: "crew@example.invalid",
    tlsCaFile: mailboxCaFile,
    enabledTools: ["mail.read"],
  });
  const config = { mailConnections: [target] },
    service = new MailInboxService({
      repo,
      directory,
      configuration: async () => config,
      secrets: { resolve: async () => "fixture-password" },
    });
  const body = {
    targetId: target.id,
    targetConfigSha256: sha256(target),
    enabled: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    kind: "finance",
    budgetLimitUsdMicros: "0",
  };
  const app = express();
  app.use(express.json());
  registerMailInboxRoutes(app, {
    service,
    context: () => ({ companyId: scope.companyId, ceoId }),
    mutate: (handler) => async (req, res, next) => {
      try {
        res.json(await handler(req, res));
      } catch (e) {
        next(e);
      }
    },
  });
  app.use(
    (
      error: Error & { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.status ?? 400).json({ code: error.code ?? error.name });
    },
  );
  return {
    repo,
    scope,
    ceoId,
    directory,
    sink,
    service,
    body,
    target,
    config,
    app,
    close: async () => {
      await sink.close();
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("persists actual MIME originals and attachments, creates exactly one external order, exposes safe downloads and imports a sourced voucher", async () => {
  const f = await fixture();
  try {
    const policy = await request(f.app).post("/api/v1/mail-inbox/policies").send(f.body).expect(200);
    await request(f.app).post(`/api/v1/mail-inbox/policies/${policy.body.id}/poll`).send({}).expect(200);
    const listing = await request(f.app).get("/api/v1/mail-inbox").expect(200),
      mail = listing.body.messages[0];
    expect(mail).toMatchObject({
      identityVerified: false,
      authority: "untrusted_external_content",
      importState: "complete",
    });
    expect(mail.text).toBeUndefined();
    expect(mail.original.content).toBeUndefined();
    expect(mail.attachments[0].content).toBeUndefined();
    const full = await request(f.app).get(`/api/v1/mail-inbox/messages/${mail.id}`).expect(200);
    expect(full.body.text).toContain("Rechnung prüfen");
    const original = await request(f.app)
      .get(`/api/v1/mail-inbox/messages/${mail.id}/blobs/${mail.original.sha256}`)
      .expect(200);
    expect(original.headers["content-disposition"]).toContain("attachment");
    expect(original.body.equals(multipartMail)).toBe(true);
    expect((await readFile(path.join(f.directory, "blobs", mail.original.sha256))).equals(multipartMail)).toBe(true);
    const channel = (
      await f.repo.listDocuments<{ role: string; approvalAllowed: boolean }>(f.scope, "channel-inbox")
    )[0]!;
    expect(channel.data).toMatchObject({ role: "external", approvalAllowed: false });
    expect(await f.repo.listDocuments(f.scope, "approval")).toEqual([]);
    const invoice = {
      id: "invoice-test",
      supplierId: "supplier-test",
      reference: "REF-381",
      currency: "EUR",
      totalMinor: "8137",
      paidMinor: "0",
      dueAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      source: "user-entered metadata",
      disputed: false,
      paymentPause: false,
    };
    const imported = await request(f.app)
      .post(`/api/v1/mail-inbox/messages/${mail.id}/finance`)
      .send({ attachmentSha256: mail.attachments[0].sha256, invoice })
      .expect(200);
    expect(imported.body.duplicate).toBe(false);
    const voucher = (await f.repo.getDocument<{ invoice: { source: string }; originalSha256: string }>(
      f.scope,
      "voucher",
      imported.body.voucherId,
    ))!;
    expect(voucher.data.originalSha256).toBe(mail.attachments[0].sha256);
    expect(voucher.data.invoice.source).toContain(`mail:${mail.id}:attachment:`);
    await request(f.app).post(`/api/v1/mail-inbox/policies/${policy.body.id}/poll`).send({}).expect(200);
    expect(await f.repo.listDocuments(f.scope, "channel-inbox")).toHaveLength(1);
    expect(f.sink.state.sourceReads).toBe(1);
    await expect(f.service.message(randomUUID(), f.ceoId, mail.id)).rejects.toMatchObject({ code: "ceo_required" });
    await expect(f.service.blob(f.scope.companyId, f.ceoId, mail.id, "a".repeat(64))).rejects.toMatchObject({
      code: "mail_blob_denied",
    });
  } finally {
    await f.close();
  }
});
it("recovers a crash after channel-order creation without duplicate orders or acknowledging an incomplete import", async () => {
  const f = await fixture();
  try {
    const policy = await f.service.configure(f.scope.companyId, f.ceoId, f.body),
      put = f.repo.putDocument.bind(f.repo);
    let fail = true;
    f.repo.putDocument = async <T>(
      scope: typeof f.scope,
      kind: string,
      id: string,
      data: T,
      options?: Parameters<typeof f.repo.putDocument>[4],
    ) => {
      if (kind === "mail-message" && (data as { importState?: string }).importState === "complete" && fail) {
        fail = false;
        throw Error("simulated crash before inbox acknowledgement");
      }
      return put(scope, kind, id, data, options);
    };
    await expect(f.service.poll(f.scope.companyId, f.ceoId, policy.id)).rejects.toThrow("simulated crash");
    expect(await f.repo.listDocuments(f.scope, "mail-inbox-cursor")).toHaveLength(0);
    expect(await f.repo.listDocuments(f.scope, "channel-inbox")).toHaveLength(1);
    await f.service.poll(f.scope.companyId, f.ceoId, policy.id);
    expect(await f.repo.listDocuments(f.scope, "channel-inbox")).toHaveLength(1);
    expect((await f.service.messages(f.scope.companyId, f.ceoId))[0]!.importState).toBe("complete");
  } finally {
    await f.close();
  }
});
it("rejects a changed target, expired policy and restore generation before connecting", async () => {
  const f = await fixture();
  try {
    const policy = await f.service.configure(f.scope.companyId, f.ceoId, f.body);
    f.config.mailConnections[0] = { ...f.target, username: "changed" };
    await expect(f.service.poll(f.scope.companyId, f.ceoId, policy.id)).rejects.toMatchObject({
      code: "mail_poll_authorization_changed",
    });
    f.config.mailConnections[0] = f.target;
    await f.repo.putDocument(f.scope, "recovery-state", f.scope.companyId, {
      generation: randomUUID(),
      dispatchPaused: false,
    });
    await expect(f.service.poll(f.scope.companyId, f.ceoId, policy.id)).rejects.toMatchObject({
      code: "mail_poll_authorization_changed",
    });
    expect(f.sink.state.authentications).toBe(0);
    await expect(
      f.service.configure(
        f.scope.companyId,
        f.ceoId,
        { ...f.body, expiresAt: "2000-01-01T00:00:00.000Z" },
        { id: policy.id, expectedRevision: policy.revision },
      ),
    ).rejects.toMatchObject({ code: "mail_policy_expired" });
  } finally {
    await f.close();
  }
});

it("uses the real control session, CSRF, idempotency and configured secret broker before actual TLS inbox delivery", async () => {
  const f = await fixture();
  try {
    const executable = path.join(f.directory, "fixture-pass-cli.mjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version')?'2.3.3\\n':'fixture-password\\n');\n`,
      { mode: 0o700 },
    );
    await saveConfiguration(f.directory, {
      liveExecutionEnabled: true,
      proton: { executable },
      mailConnections: [f.target],
    });
    const app = createApp({ repo: f.repo, directory: f.directory, publicOrigin: "http://127.0.0.1:8790" }),
      agent = request.agent(app);
    await agent.get("/api/v1/mail-inbox").expect(401);
    const session = await agent.post("/api/v1/session").send({ password: "mail-fixture-password-1234" }).expect(200);
    const headers = () => ({ "X-CSRF-Token": session.body.csrfToken as string, "Idempotency-Key": randomUUID() });
    await agent.post("/api/v1/mail-inbox/policies").send(f.body).expect(403);
    await agent
      .post("/api/v1/mail-inbox/policies")
      .set("X-CSRF-Token", session.body.csrfToken)
      .send(f.body)
      .expect(400);
    const policy = await agent.post("/api/v1/mail-inbox/policies").set(headers()).send(f.body).expect(200);
    await agent.post(`/api/v1/mail-inbox/policies/${policy.body.id}/poll`).send({}).expect(403);
    expect(f.sink.state.authentications).toBe(0);
    const replayHeaders = headers();
    await agent.post(`/api/v1/mail-inbox/policies/${policy.body.id}/poll`).set(replayHeaders).send({}).expect(200);
    await agent.post(`/api/v1/mail-inbox/policies/${policy.body.id}/poll`).set(replayHeaders).send({}).expect(200);
    expect(f.sink.state.authentications).toBe(1);
    const listing = await agent.get("/api/v1/mail-inbox").expect(200),
      mail = listing.body.messages[0];
    expect(mail.importState).toBe("complete");
    const downloaded = await agent
      .get(`/api/v1/mail-inbox/messages/${mail.id}/blobs/${mail.original.sha256}`)
      .expect(200);
    expect(downloaded.body.equals(multipartMail)).toBe(true);
    await request(app).get(`/api/v1/mail-inbox/messages/${mail.id}/blobs/${mail.original.sha256}`).expect(401);
  } finally {
    await f.close();
  }
});
