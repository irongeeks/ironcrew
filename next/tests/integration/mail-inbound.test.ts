import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
import type { InboundMail } from "../../packages/integrations/src/mail-inbound.ts";
import { tlsMailbox, mailboxCaFile, multipartMail } from "../fixtures/mailbox.ts";
const scope = { companyId: randomUUID(), areaId: randomUUID() },
  targetId = randomUUID();
const action = { id: randomUUID(), scope, targetId, toolId: "mail.read", args: { limit: 20 } };
function connector(port: number, authorize = async () => {}) {
  return new MailConnector(
    {
      id: targetId,
      scope,
      host: "127.0.0.1",
      port,
      username: "fixture",
      secretRef: { provider: "proton-pass", shareId: "test", itemId: "test", field: "password" },
      from: "crew@example.invalid",
      tlsCaFile: mailboxCaFile,
    },
    { resolve: async () => "fixture-password" },
    authorize,
  );
}
it("reads full TLS IMAP originals and decoded attachment bytes with stable UID identity and no sender authority", async () => {
  const f = await tlsMailbox([
      { uid: 1, source: multipartMail },
      { uid: 3, source: multipartMail },
    ]),
    messages: InboundMail[] = [];
  try {
    const c = connector(f.port),
      result = await c.pollInbound(action, { limit: 20 }, async (m) => {
        messages.push(m);
      });
    expect(result.cursor).toEqual({ uidValidity: "1", lastUid: 3 });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.original!.content.equals(multipartMail)).toBe(true);
    expect(messages[0]!.text).toContain("Rechnung prüfen");
    expect(messages[0]!.subject).toBe("Prüfung");
    expect(messages[0]!.attachments[0]!.content.toString()).toContain("fixture invoice original");
    expect(messages[0]!.identityVerified).toBe(false);
    expect(messages[0]!.authority).toBe("untrusted_external_content");
    expect(messages[0]!.id).not.toBe(messages[1]!.id);
    await c.pollInbound(action, { cursor: result.cursor }, async () => {
      throw Error("should not replay");
    });
    expect(f.state.sourceReads).toBe(2);
    expect(f.state.commands.some((c) => c.startsWith("EXAMINE "))).toBe(true);
    expect(f.state.commands.some((c) => /STORE|EXPUNGE|SELECT /.test(c))).toBe(false);
    f.state.uidValidity = 2;
    const replay = await c.pollInbound(action, { cursor: result.cursor }, async (m) => {
      messages.push(m);
    });
    expect(replay.uidValidityChanged).toBe(true);
    expect(messages[2]!.id).not.toBe(messages[0]!.id);
  } finally {
    await f.close();
  }
});
it("does not acknowledge unpersisted mail and explicitly records oversized messages without fetching their content", async () => {
  const f = await tlsMailbox([
    { uid: 1, source: multipartMail },
    { uid: 2, source: multipartMail, size: 20 * 1024 * 1024 },
  ]);
  try {
    const c = connector(f.port),
      persisted: InboundMail[] = [];
    await expect(
      c.pollInbound(action, {}, async () => {
        throw Error("disk unavailable");
      }),
    ).rejects.toThrow("disk unavailable");
    const result = await c.pollInbound(action, {}, async (m) => {
      persisted.push(m);
    });
    expect(persisted).toHaveLength(2);
    expect(result.rejected).toBe(1);
    expect(persisted[1]).toMatchObject({ state: "rejected", rejection: "message_too_large" });
    expect(f.state.sourceReads).toBe(2);
  } finally {
    await f.close();
  }
});
it("fails closed before exposing bytes when authority is revoked during IMAP read", async () => {
  const f = await tlsMailbox([{ uid: 1, source: multipartMail }]);
  try {
    const c = connector(f.port, async () => {
      if (f.state.sourceReads) throw Error("revoked");
    });
    let callbacks = 0;
    await expect(
      c.pollInbound(action, {}, async () => {
        callbacks++;
      }),
    ).rejects.toThrow();
    expect(callbacks).toBe(0);
  } finally {
    await f.close();
  }
});
it("bounds a batch without skipping the next unprocessed UID and rejects incomplete originals", async () => {
  const source = Buffer.concat([multipartMail, Buffer.alloc(1300, 32)]),
    f = await tlsMailbox([
      { uid: 1, source },
      { uid: 2, source },
    ]);
  try {
    const messages: InboundMail[] = [],
      c = connector(f.port);
    const first = await c.pollInbound(
      action,
      { maxMessageBytes: source.length, maxBatchBytes: source.length + 50 },
      async (m) => {
        messages.push(m);
      },
    );
    expect(first.cursor.lastUid).toBe(1);
    expect(first.more).toBe(true);
    const second = await c.pollInbound(
      action,
      { cursor: first.cursor, maxMessageBytes: source.length, maxBatchBytes: source.length + 50 },
      async (m) => {
        messages.push(m);
      },
    );
    expect(second.cursor.lastUid).toBe(2);
    expect(messages).toHaveLength(2);
    f.state.messages = [{ uid: 3, source, size: source.length + 1 }];
    await expect(
      c.pollInbound(action, { cursor: second.cursor }, async () => {
        throw Error("must not persist partial source");
      }),
    ).rejects.toMatchObject({ code: "provider" });
  } finally {
    await f.close();
  }
});
