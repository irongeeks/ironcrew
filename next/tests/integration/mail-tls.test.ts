import { it, expect } from "vitest";
import { createServer, type TLSSocket } from "node:tls";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
import { managedMailPort, mailConnectionSchema, mailRuntimeTools } from "../../apps/control/mail-broker.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
import type { ApprovalBinding } from "../../packages/contracts/src/index.ts";
const tlsCaFile = fileURLToPath(new URL("./worker-fixtures/cert.pem", import.meta.url));
const tlsOptions = {
  key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)),
  cert: await readFile(new URL("./worker-fixtures/cert.pem", import.meta.url)),
};
async function server(handler: (socket: TLSSocket) => void) {
  const sockets = new Set<TLSSocket>(),
    app = createServer(tlsOptions, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      handler(socket);
    });
  app.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  return {
    port: (app.address() as { port: number }).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
}
it("delivers to a local TLS SMTP sink only after concrete CEO approval and never replays the send", async () => {
  const received: string[] = [],
    sink = await server((socket) => {
      socket.write("220 localhost SMTP fixture\r\n");
      let buffer = "",
        inData = false,
        message = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let cut: number;
        while ((cut = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (inData) {
            if (line === ".") {
              received.push(message);
              inData = false;
              socket.write("250 2.0.0 accepted\r\n");
            } else message += line + "\r\n";
            continue;
          }
          if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN "))
            socket.write(
              Buffer.from(line.slice(11), "base64").toString().endsWith("\0fixture-password")
                ? "235 authenticated\r\n"
                : "535 denied\r\n",
            );
          else if (/^MAIL FROM:|^RCPT TO:/.test(line)) socket.write("250 OK\r\n");
          else if (line === "DATA") {
            inData = true;
            message = "";
            socket.write("354 end with dot\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
  const directory = await mkdtemp(path.join(tmpdir(), "mail-tls-")),
    repo = await Repository.open(path.join(directory, "company.sqlite"));
  try {
    const setup = await repo.setup({
        companyName: "Mail fixture",
        ceoName: "CEO",
        passwordHash: "fixture",
        timezone: "UTC",
        budgetLimitUsdMicros: "0",
      }),
      scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const target = mailConnectionSchema.parse({
      id: randomUUID(),
      scope,
      host: "127.0.0.1",
      port: sink.port,
      username: "fixture",
      secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
      from: "crew@example.invalid",
      tlsMode: "implicit",
      tlsCaFile,
      enabledTools: ["mail.send"],
    });
    const order = await repo.createOrder(scope, {
        kind: "incident",
        goal: "Approved fixture notification",
        budgetLimitUsdMicros: "0",
      }),
      mandate = {
        id: randomUUID(),
        version: 1,
        scope,
        allowedToolIds: ["mail.send"],
        targetIds: [target.id],
        parameterConstraints: {},
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        maxAttempts: 1,
        maxDurationSeconds: 30,
        maxCostUsdMicros: "0",
      };
    await repo.createMandate(mandate);
    const secrets = { resolve: async () => "fixture-password" },
      port = managedMailPort(
        repo,
        directory,
        { mailConnections: [target] },
        { orderId: order.id, mandateId: mandate.id, mandateVersion: 1 },
        secrets,
      ),
      action = {
        id: randomUUID(),
        scope,
        targetId: target.id,
        toolId: "mail.send",
        args: {
          to: ["fixture-recipient@example.invalid"],
          subject: "Restoration fixture",
          text: "The independent health check passed.",
        },
      };
    await expect(port.execute(action)).rejects.toMatchObject({ code: "approval_required" });
    expect(received).toHaveLength(0);
    const approval = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", action.id);
    const approved = await repo.approve(scope, approval!.data.binding);
    const stored = (await repo.getDocument<Record<string, unknown>>(scope, "action", action.id))!;
    await repo.putDocument(
      scope,
      "action",
      action.id,
      { ...stored.data, approvalId: approved.id, status: "authorized" },
      { expectedRevision: stored.revision },
    );
    const result = await port.execute(action);
    expect(result.effectStatus).toBe("accepted");
    expect((result.data as { delivered: boolean }).delivered).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("The independent health check passed.");
    await port.execute(action);
    expect(received).toHaveLength(1);
    await expect(
      managedMailPort(
        repo,
        directory,
        { mailConnections: [{ ...target, from: "other@example.invalid" }] },
        { orderId: order.id, mandateId: mandate.id, mandateVersion: 1 },
        secrets,
      ).execute(action),
    ).rejects.toMatchObject({ code: "action_binding_conflict" });
    const tools = mailRuntimeTools(repo, { mailConnections: [target] }, secrets);
    expect(tools[0]?.forScope?.({ ...scope, areaId: setup.areas[1]!.id })).toBeUndefined();
    const connector = new MailConnector({ ...target, tlsCaFile: undefined }, secrets, async () => {});
    await expect(connector.send({ ...action, id: randomUUID() })).rejects.toMatchObject({ code: "transport" });
    expect(received).toHaveLength(1);
  } finally {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
    await sink.close();
  }
});
it.each([0, 1])("reads %i messages over TLS IMAP preserving dates in JSON evidence", async (count) => {
  let authenticated = false,
    selected = false;
  const seen: string[] = [];
  let pendingAuthTag: string | undefined;
  const sink = await server((socket) => {
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] IMAP fixture\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let cut: number;
      while ((cut = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (pendingAuthTag) {
          authenticated = Buffer.from(line, "base64").toString().endsWith("\0fixture-password");
          socket.write(pendingAuthTag + (authenticated ? " OK authenticated\r\n" : " NO denied\r\n"));
          pendingAuthTag = undefined;
          continue;
        }
        const match = /^(\S+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        seen.push(command!.split(" ").slice(0, 2).join(" "));
        if (command!.startsWith("CAPABILITY"))
          socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n" + tag + " OK capability\r\n");
        else if (command === "AUTHENTICATE PLAIN") {
          pendingAuthTag = tag;
          socket.write("+ \r\n");
        } else if (command!.startsWith("AUTHENTICATE PLAIN ")) {
          authenticated = Buffer.from(command!.slice(19), "base64").toString().endsWith("\0fixture-password");
          socket.write(tag + (authenticated ? " OK authenticated\r\n" : " NO denied\r\n"));
        } else if (command!.startsWith("LOGIN ")) {
          authenticated = true;
          socket.write(tag + " OK authenticated\r\n");
        } else if (command!.startsWith("SELECT ")) {
          selected = true;
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${count} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 2] next\r\n` +
              tag +
              " OK [READ-WRITE] selected\r\n",
          );
        } else if (command!.startsWith("FETCH ")) {
          socket.write(
            '* 1 FETCH (UID 1 INTERNALDATE "08-Sep-2026 07:01:12 +0000" ENVELOPE ("Tue, 8 Sep 2026 07:00:00 +0000" "fixture-password subject" NIL NIL NIL NIL NIL NIL NIL "<fixture@example.invalid>"))\r\n' +
              tag +
              " OK fetched\r\n",
          );
        } else if (command!.startsWith("LIST ")) socket.write('* LIST () "/" "INBOX"\r\n' + tag + " OK list\r\n");
        else if (command!.startsWith("LOGOUT")) socket.end("* BYE logout\r\n" + tag + " OK logout\r\n");
        else socket.write(tag + " OK complete\r\n");
      }
    });
  });
  try {
    const scope = { companyId: randomUUID(), areaId: randomUUID() },
      id = randomUUID(),
      connector = new MailConnector(
        {
          id,
          scope,
          host: "127.0.0.1",
          port: sink.port,
          username: "fixture",
          secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
          from: "crew@example.invalid",
          tlsCaFile,
        },
        { resolve: async () => "fixture-password" },
        async () => {},
      );
    const result = await connector.read({
      id: randomUUID(),
      scope,
      targetId: id,
      toolId: "mail.read",
      args: { limit: 10 },
    });
    expect(authenticated, seen.join(" | ")).toBe(true);
    expect(selected).toBe(true);
    expect(result.effectStatus).toBe("succeeded");
    const evidence = JSON.parse(JSON.stringify(result.data));
    expect(evidence.messages).toHaveLength(count);
    if (count)
      expect(evidence.messages[0]).toMatchObject({
        receivedAt: "2026-09-08T07:01:12.000Z",
        envelope: { date: "2026-09-08T07:00:00.000Z", subject: "[REDACTED] subject" },
      });
  } finally {
    await sink.close();
  }
});
