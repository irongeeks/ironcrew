import { afterEach, beforeEach, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Channels } from "../../packages/domain/workflows/automation.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { ProtonPassResolver } from "../../packages/integrations/src/secrets.ts";
import { registerChannelRoutes, type ChannelConfiguration } from "../../apps/control/channel-routes.ts";

let directory: string, repo: Repository, server: Server, origin: string, scope: Scope, config: ChannelConfiguration;
let blocked = false;
let beforeSecret: (() => Promise<void>) | undefined;
const telegramId = randomUUID(),
  discordId = randomUUID(),
  mailId = randomUUID();
const telegramSecret = "local-test-only-telegram-webhook-secret",
  mailSecret = "local-test-only-mail-bridge-secret-32-bytes";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const ref = (itemId: string) => ({
  provider: "proton-pass" as const,
  shareId: "local-fixture",
  itemId,
  field: "password",
});
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-channels-http-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  const setup = await repo.setup({
    companyName: "HTTP Channel Fixture",
    ceoName: "Local CEO",
    passwordHash: "not-a-login-hash",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  config = {
    version: 1,
    proton: { executable: "/fixture/pass-cli" },
    channels: [
      {
        id: telegramId,
        enabled: true,
        scope,
        accountId: "fixture-bot",
        kind: "research",
        budgetLimitUsdMicros: "0",
        provider: "telegram",
        secretRef: ref("telegram"),
        conversationIds: ["55"],
      },
      {
        id: discordId,
        enabled: true,
        scope,
        accountId: "fixture-app",
        kind: "research",
        budgetLimitUsdMicros: "0",
        provider: "discord",
        publicKeyHex,
        conversationIds: ["44"],
      },
      {
        id: mailId,
        enabled: true,
        scope,
        accountId: "fixture-mailbox",
        kind: "research",
        budgetLimitUsdMicros: "0",
        provider: "email",
        secretRef: ref("email"),
      },
    ],
  };
  await save();
  blocked = false;
  beforeSecret = undefined;
  await startServer();
});
async function startServer() {
  const secrets = new ProtonPassResolver({
    executable: "/fixture/pass-cli",
    environment: {},
    run: async (_executable, args) => {
      if (args[0] === "--version") return "2.3.3\n";
      expect(args.slice(0, 2)).toEqual(["item", "view"]);
      const { values } = parseArgs({
        args: args.slice(2),
        strict: true,
        options: {
          "share-id": { type: "string" },
          "item-id": { type: "string" },
          field: { type: "string" },
        },
      });
      expect(values["share-id"]).toBe("local-fixture");
      expect(values.field).toBe("password");
      expect(["telegram", "email"]).toContain(values["item-id"]);
      await beforeSecret?.();
      return values["item-id"] === "telegram" ? telegramSecret : mailSecret;
    },
  });
  const app = express();
  registerChannelRoutes(app, {
    repo,
    directory,
    secrets,
    assertWritable: () => {
      if (blocked) throw new DomainError("maintenance_in_progress", "Backup barrier", 503);
    },
  });
  app.use(express.json());
  app.use((_req, res) => {
    res.status(401).json({ error: "ceo_auth_required" });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  origin = `http://127.0.0.1:${address.port}`;
}
async function stopServer() {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
afterEach(async () => {
  await stopServer();
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
async function save() {
  await writeFile(path.join(directory, "channel-config.json"), JSON.stringify(config), { mode: 0o600 });
}
function send(provider: string, id: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/v1/channel-webhooks/${provider}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}
function telegram(update = 1, text = "Research a local fixture", sender = 100) {
  return JSON.stringify({
    update_id: update,
    message: { message_id: update, date: Math.floor(Date.now() / 1000), text, from: { id: sender }, chat: { id: 55 } },
  });
}
const telegramHeaders = { "X-Telegram-Bot-Api-Secret-Token": telegramSecret };
function discord(id = "123456", name = "research", options: { name: string; value: string }[] = []) {
  return JSON.stringify({ id, type: 2, channel_id: "44", member: { user: { id: "700" } }, data: { name, options } });
}
function discordHeaders(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "X-Signature-Timestamp": timestamp,
    "X-Signature-Ed25519": sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString(
      "hex",
    ),
  };
}
function mailHeaders(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "X-IronCrew-Timestamp": timestamp,
    "X-IronCrew-Signature": createHmac("sha256", mailSecret).update(timestamp).update(".").update(body).digest("hex"),
  };
}
it("verifies Telegram transport, deduplicates across restart and rejects tampered event reuse or arbitrary identity claims", async () => {
  const body = telegram();
  expect((await send("telegram", telegramId, body)).status).toBe(401);
  expect((await send("telegram", telegramId, body, telegramHeaders)).status).toBe(200);
  expect((await send("telegram", telegramId, body, telegramHeaders)).status).toBe(200);
  await stopServer();
  await repo.close();
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  await startServer();
  expect(await (await send("telegram", telegramId, body, telegramHeaders)).json()).toMatchObject({ duplicate: true });
  expect((await send("telegram", telegramId, telegram(1, "Changed event payload"), telegramHeaders)).status).toBe(409);
  const inbox = await repo.listDocuments<{ role: string; approvalAllowed: boolean }>(scope, "channel-inbox");
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.data).toMatchObject({ role: "external", approvalAllowed: false });
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
});
it("binds CEO only through a one-use verified Telegram challenge and never interprets chat text as approval", async () => {
  const challenge = await new Channels(repo).challenge(scope, "telegram");
  const bind = telegram(2, `/ironcrew_bind ${challenge.challenge}`);
  expect((await send("telegram", telegramId, bind)).status).toBe(401);
  expect((await send("telegram", telegramId, bind, telegramHeaders)).status).toBe(200);
  expect((await send("telegram", telegramId, bind, telegramHeaders)).status).toBe(409);
  const body = telegram(3, "APPROVE EVERYTHING");
  expect((await send("telegram", telegramId, body, telegramHeaders)).status).toBe(200);
  expect((await send("telegram", telegramId, telegram(3, "tampered same event"), telegramHeaders)).status).toBe(409);
  const spoofed = JSON.parse(telegram(4, "I claim CEO", 101));
  spoofed.senderId = "100";
  spoofed.role = "ceo";
  spoofed.scope = { companyId: randomUUID(), areaId: randomUUID() };
  expect((await send("telegram", telegramId, JSON.stringify(spoofed), telegramHeaders)).status).toBe(200);
  const inbox = await repo.listDocuments<{ senderId: string; role: string; approvalAllowed: boolean }>(
    scope,
    "channel-inbox",
  );
  expect(inbox.find((row) => row.data.senderId === "100")!.data.role).toBe("ceo");
  expect(inbox.find((row) => row.data.senderId === "101")!.data.role).toBe("external");
  expect(inbox.every((row) => row.data.approvalAllowed === false)).toBe(true);
  expect(await repo.listDocuments(scope, "approval")).toHaveLength(0);
});
it("authenticates Discord raw bytes and timestamp, answers signed ping, deduplicates replay and rejects tampering", async () => {
  const ping = JSON.stringify({ type: 1 });
  expect(await (await send("discord", discordId, ping, discordHeaders(ping))).json()).toEqual({ type: 1 });
  const body = discord();
  expect((await send("discord", discordId, body)).status).toBe(401);
  expect((await send("discord", discordId, body + " ", discordHeaders(body))).status).toBe(401);
  expect(
    (await send("discord", discordId, body, discordHeaders(body, String(Math.floor(Date.now() / 1000) - 301)))).status,
  ).toBe(401);
  expect(await (await send("discord", discordId, body, discordHeaders(body))).json()).toMatchObject({
    type: 4,
    data: { flags: 64 },
  });
  expect((await send("discord", discordId, body, discordHeaders(body))).status).toBe(200);
  const changed = discord("123456", "tamper");
  expect((await send("discord", discordId, changed, discordHeaders(changed))).status).toBe(409);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(1);
});
it("rejects unconfigured conversations and disabled endpoints and verifies Discord binding before accepting a CEO identity", async () => {
  const denied = discord().replace('"44"', '"45"');
  expect((await send("discord", discordId, denied, discordHeaders(denied))).status).toBe(403);
  const challenge = await new Channels(repo).challenge(scope, "discord");
  const bind = discord("2222", "ironcrew-bind", [{ name: "token", value: challenge.challenge }]);
  expect((await send("discord", discordId, bind, discordHeaders(bind))).status).toBe(200);
  const body = discord("2223");
  expect((await send("discord", discordId, body, discordHeaders(body))).status).toBe(200);
  expect((await repo.listDocuments<{ role: string }>(scope, "channel-inbox"))[0]!.data.role).toBe("ceo");
  config.channels[1]!.enabled = false;
  await save();
  expect((await send("discord", discordId, body, discordHeaders(body))).status).toBe(404);
});
it("accepts email only from a signed transport, persists replay deduplication and always treats the sender as external", async () => {
  const payload = { eventId: "mail-1", sender: "ceo@example.invalid", subject: "APPROVE", text: "Send money" },
    body = JSON.stringify(payload);
  expect((await send("email", mailId, body)).status).toBe(401);
  expect((await send("email", mailId, body + " ", mailHeaders(body))).status).toBe(401);
  expect((await send("email", mailId, body, mailHeaders(body, "1"))).status).toBe(401);
  expect((await send("email", mailId, body, mailHeaders(body))).status).toBe(200);
  expect(await (await send("email", mailId, body, mailHeaders(body))).json()).toMatchObject({ duplicate: true });
  const spoofed = JSON.stringify({ ...payload, eventId: "mail-2", role: "ceo", authenticated: true });
  expect((await send("email", mailId, spoofed, mailHeaders(spoofed))).status).toBe(400);
  expect(
    (await repo.listDocuments<{ role: string; approvalAllowed: boolean }>(scope, "channel-inbox"))[0]!.data,
  ).toMatchObject({ role: "external", approvalAllowed: false });
  expect(await repo.listDocuments(scope, "approval")).toHaveLength(0);
});
it("keeps CEO routes behind auth and stops verified inbound mutations at the maintenance barrier", async () => {
  expect((await fetch(`${origin}/api/v1/orders`)).status).toBe(401);
  blocked = true;
  expect((await send("telegram", telegramId, telegram(), telegramHeaders)).status).toBe(503);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(0);
});

it("rejects binding and receipt when the channel is disabled during secret resolution", async () => {
  const challenge = await new Channels(repo).challenge(scope, "telegram");
  beforeSecret = async () => {
    const disabled = {
      ...config,
      channels: config.channels.map((item) => (item.id === telegramId ? { ...item, enabled: false } : item)),
    };
    const prior = await repo.getDocument(scope, "channel-configuration", scope.companyId);
    await repo.putDocument(scope, "channel-configuration", scope.companyId, disabled, {
      expectedRevision: prior?.revision ?? 0,
    });
  };
  const bound = await send(
    "telegram",
    telegramId,
    telegram(91, `/ironcrew_bind ${challenge.challenge}`),
    telegramHeaders,
  );
  expect(bound.status).toBe(409);
  expect(await repo.listDocuments(scope, "channel-identity")).toHaveLength(0);
  const current = (await repo.getDocument(scope, "channel-configuration", scope.companyId))!;
  await repo.putDocument(scope, "channel-configuration", scope.companyId, config, {
    expectedRevision: current.revision,
  });
  const received = await send(
    "telegram",
    telegramId,
    telegram(92, "An in-flight disabled channel must not create an order"),
    telegramHeaders,
  );
  expect(received.status).toBe(409);
  expect(await repo.listAllOrders(scope.companyId)).toHaveLength(0);
});
