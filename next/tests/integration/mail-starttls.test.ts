import { it, expect } from "vitest";
import { createServer, type Socket } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
const tlsCaFile = fileURLToPath(new URL("./worker-fixtures/cert.pem", import.meta.url));
const secureContext = createSecureContext({
  key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)),
  cert: await readFile(tlsCaFile),
});
async function fixture(starttls: boolean) {
  const sockets = new Set<Socket>(),
    commands: { line: string; tls: boolean }[] = [];
  let authenticated = false;
  const attach = (socket: Socket, tls: boolean) => {
    let buffer = "",
      pending: string | undefined;
    socket.on("error", () => {});
    const listener = (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push({ line, tls });
        if (pending) {
          authenticated = tls && Buffer.from(line, "base64").toString().endsWith("\0fixture-password");
          socket.write(pending + (authenticated ? " OK authenticated\r\n" : " NO denied\r\n"));
          pending = undefined;
          continue;
        }
        const match = /^(\S+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        if (command === "STARTTLS" && !tls && starttls) {
          socket.removeListener("data", listener);
          socket.write(tag + " OK begin TLS\r\n", () => {
            const encrypted = new TLSSocket(socket, { isServer: true, secureContext });
            sockets.add(encrypted);
            encrypted.once("close", () => sockets.delete(encrypted));
            attach(encrypted, true);
          });
          return;
        }
        if (command === "CAPABILITY")
          socket.write(
            "* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR" +
              (!tls && starttls ? " STARTTLS" : "") +
              "\r\n" +
              tag +
              " OK capabilities\r\n",
          );
        else if (command === "AUTHENTICATE PLAIN") {
          pending = tag;
          socket.write("+ \r\n");
        } else if (command?.startsWith("AUTHENTICATE PLAIN ")) {
          authenticated = tls && Buffer.from(command.slice(19), "base64").toString().endsWith("\0fixture-password");
          socket.write(tag + (authenticated ? " OK authenticated\r\n" : " NO denied\r\n"));
        } else if (command?.startsWith("SELECT "))
          socket.write(
            "* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 1] next\r\n" +
              tag +
              " OK [READ-WRITE] selected\r\n",
          );
        else if (command?.startsWith("LIST ")) socket.write('* LIST () "/" "INBOX"\r\n' + tag + " OK list\r\n");
        else if (command?.startsWith("LOGOUT")) socket.end("* BYE logout\r\n" + tag + " OK logout\r\n");
        else socket.write(tag + " OK complete\r\n");
      }
    };
    socket.on("data", listener);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    attach(socket, false);
    socket.write(
      "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR" + (starttls ? " STARTTLS" : "") + "] IMAP fixture\r\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    commands,
    authenticated: () => authenticated,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function connector(port: number, trusted = true) {
  const scope = { companyId: randomUUID(), areaId: randomUUID() },
    id = randomUUID();
  return {
    client: new MailConnector(
      {
        id,
        scope,
        host: "127.0.0.1",
        port,
        username: "fixture",
        secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
        from: "crew@example.invalid",
        tlsMode: "starttls",
        ...(trusted ? { tlsCaFile } : {}),
      },
      { resolve: async () => "fixture-password" },
      async () => {},
    ),
    action: { id: randomUUID(), scope, targetId: id, toolId: "mail.read", args: { limit: 1 } },
  };
}
it("upgrades a real IMAP connection before sending any credentials", async () => {
  const sink = await fixture(true);
  try {
    const { client, action } = connector(sink.port);
    expect((await client.read(action)).effectStatus).toBe("succeeded");
    expect(sink.authenticated()).toBe(true);
    expect(sink.commands.some((c) => !c.tls && c.line.endsWith("STARTTLS"))).toBe(true);
    expect(sink.commands.filter((c) => /AUTHENTICATE|LOGIN/.test(c.line)).every((c) => c.tls)).toBe(true);
  } finally {
    await sink.close();
  }
});
it("refuses IMAP servers that do not advertise mandatory STARTTLS without revealing credentials", async () => {
  const sink = await fixture(false);
  try {
    const { client, action } = connector(sink.port);
    await expect(client.read(action)).rejects.toMatchObject({ code: "transport" });
    expect(sink.commands.some((c) => /AUTHENTICATE|LOGIN/.test(c.line))).toBe(false);
    expect(sink.authenticated()).toBe(false);
  } finally {
    await sink.close();
  }
});
it("rejects an untrusted certificate during STARTTLS before authentication", async () => {
  const sink = await fixture(true);
  try {
    const { client, action } = connector(sink.port, false);
    await expect(client.read(action)).rejects.toMatchObject({ code: "transport" });
    expect(sink.commands.some((c) => /AUTHENTICATE|LOGIN/.test(c.line))).toBe(false);
  } finally {
    await sink.close();
  }
});
