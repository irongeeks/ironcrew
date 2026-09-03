import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessengerTokenKey } from "./token-hint.ts";

const ORIGINAL_ENV = { ...process.env };

function createTestDb(options?: { messengerChannels?: unknown; offset?: number }): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octooffice-telegram-receiver-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
    if (options && Object.prototype.hasOwnProperty.call(options, "messengerChannels")) {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("messengerChannels", JSON.stringify(options.messengerChannels ?? {}));
    }
    if (typeof options?.offset === "number") {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("telegramReceiverOffset", JSON.stringify(options.offset));
    }
  } finally {
    db.close();
  }
  return dbPath;
}

async function importReceiverModule(env: Record<string, string | undefined>) {
  vi.resetModules();

  process.env = {
    ...ORIGINAL_ENV,
    DB_PATH: env.DB_PATH,
    INBOX_WEBHOOK_SECRET: env.INBOX_WEBHOOK_SECRET,
  };

  return import("./telegram-receiver.ts");
}

describe("telegram receiver", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("허용된 텔레그램 chat 메시지를 /api/inbox로 포워딩하고 offset을 저장한다", async () => {
    const dbPath = createTestDb({
      messengerChannels: {
        telegram: {
          token: "tg-db-token",
          receiveEnabled: true,
          sessions: [{ id: "ops", name: "Ops", targetId: "1001", enabled: true }],
        },
      },
      offset: 0,
    });
    const db = new DatabaseSync(dbPath);

    try {
      const receiver = await importReceiverModule({
        DB_PATH: dbPath,
        INBOX_WEBHOOK_SECRET: "inbox-secret",
      });
      const status: import("./telegram-receiver.ts").TelegramReceiverStatus = {
        running: true,
        configured: false,
        receiveEnabled: true,
        enabled: false,
        allowedChatCount: 0,
        nextOffset: 0,
        lastPollAt: null,
        lastForwardAt: null,
        lastUpdateId: null,
        lastError: null,
      };

      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.telegram.org")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 10,
                  message: {
                    message_id: 77,
                    text: "hello from telegram",
                    chat: { id: 1001 },
                    from: { id: 9, is_bot: false, username: "testuser", first_name: "TestUser" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.includes("/api/inbox")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          expect(body.source).toBe("telegram");
          expect(body.chat).toBe("telegram:1001");
          expect(body.text).toBe("hello from telegram");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      });

      await receiver.pollTelegramReceiverOnce({
        db,
        status,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(status.enabled).toBe(true);
      expect(status.lastUpdateId).toBe(10);
      expect(status.nextOffset).toBe(11);
      expect(status.lastError).toBeNull();
      expect(typeof status.lastForwardAt).toBe("number");

      const row = db.prepare("SELECT value FROM settings WHERE key = 'telegramReceiverOffset'").get() as
        | { value: string }
        | undefined;
      const parsed = JSON.parse(row?.value || "{}") as { legacy?: number; byToken?: Record<string, number> };
      const key = buildMessengerTokenKey("telegram", "tg-db-token");
      expect(parsed.legacy).toBe(11);
      expect(parsed.byToken?.[key]).toBe(11);
    } finally {
      db.close();
    }
  });

  it("봇이 보낸 메시지는 무시하고 offset만 갱신한다", async () => {
    const dbPath = createTestDb({
      messengerChannels: {
        telegram: {
          token: "tg-db-token",
          receiveEnabled: true,
          sessions: [{ id: "ops", name: "Ops", targetId: "1001", enabled: true }],
        },
      },
      offset: 0,
    });
    const db = new DatabaseSync(dbPath);

    try {
      const receiver = await importReceiverModule({
        DB_PATH: dbPath,
        INBOX_WEBHOOK_SECRET: "inbox-secret",
      });
      const status: import("./telegram-receiver.ts").TelegramReceiverStatus = {
        running: true,
        configured: false,
        receiveEnabled: true,
        enabled: false,
        allowedChatCount: 0,
        nextOffset: 0,
        lastPollAt: null,
        lastForwardAt: null,
        lastUpdateId: null,
        lastError: null,
      };

      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("api.telegram.org")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 3,
                  message: {
                    message_id: 5,
                    text: "bot echo",
                    chat: { id: 1001 },
                    from: { id: 111, is_bot: true, username: "mybot" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      await receiver.pollTelegramReceiverOnce({
        db,
        status,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(status.lastUpdateId).toBe(3);
      expect(status.nextOffset).toBe(4);
      expect(status.lastForwardAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("토큰이 여러 개인 경우 토큰별로 polling하고 source 힌트로 포워딩한다", async () => {
    const dbPath = createTestDb({
      messengerChannels: {
        telegram: {
          receiveEnabled: true,
          sessions: [
            { id: "tg-a", name: "A", targetId: "1001", enabled: true, token: "token-a" },
            { id: "tg-b", name: "B", targetId: "1001", enabled: true, token: "token-b" },
          ],
        },
      },
      offset: 0,
    });
    const db = new DatabaseSync(dbPath);

    try {
      const receiver = await importReceiverModule({
        DB_PATH: dbPath,
        INBOX_WEBHOOK_SECRET: "inbox-secret",
      });
      const status: import("./telegram-receiver.ts").TelegramReceiverStatus = {
        running: true,
        configured: false,
        receiveEnabled: true,
        enabled: false,
        allowedChatCount: 0,
        nextOffset: 0,
        lastPollAt: null,
        lastForwardAt: null,
        lastUpdateId: null,
        lastError: null,
      };

      const inboxSources: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("bottoken-a/getUpdates")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 20,
                  message: {
                    message_id: 201,
                    text: "from-a",
                    chat: { id: 1001 },
                    from: { id: 9, is_bot: false, username: "testuser", first_name: "TestUser" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("bottoken-b/getUpdates")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 30,
                  message: {
                    message_id: 301,
                    text: "from-b",
                    chat: { id: 1001 },
                    from: { id: 10, is_bot: false, username: "testuser2", first_name: "TestUser2" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/inbox")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          inboxSources.push(String(body.source || ""));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      });

      await receiver.pollTelegramReceiverOnce({
        db,
        status,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(status.enabled).toBe(true);
      expect(status.lastUpdateId).toBe(30);
      expect(status.nextOffset).toBe(31);
      expect(status.lastError).toBeNull();
      expect(inboxSources.length).toBe(2);
      expect(inboxSources[0]).toMatch(/^telegram#[0-9a-f]+$/);
      expect(inboxSources[1]).toMatch(/^telegram#[0-9a-f]+$/);
      expect(inboxSources[0]).not.toBe(inboxSources[1]);
    } finally {
      db.close();
    }
  });
});
