import { createServer, type TLSSocket } from "node:tls";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const mailboxCaFile = fileURLToPath(new URL("../integration/worker-fixtures/cert.pem", import.meta.url));
export async function tlsMailbox(initial: Array<{ uid: number; source: Buffer; size?: number }>) {
  const sockets = new Set<TLSSocket>();
  const state = { uidValidity: 1, messages: initial, sourceReads: 0, authentications: 0, commands: [] as string[] };
  const server = createServer(
    {
      key: await readFile(new URL("../integration/worker-fixtures/key.pem", import.meta.url)),
      cert: await readFile(mailboxCaFile),
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] fixture\r\n");
      let buffer = "",
        authTag: string | undefined;
      const auth = (tag: string, encoded: string) => {
        const valid = Buffer.from(encoded, "base64").toString().endsWith("\0fixture-password");
        if (valid) state.authentications++;
        socket.write(tag + (valid ? " OK authenticated\r\n" : " NO denied\r\n"));
      };
      socket.on("data", (chunk) => {
        buffer += chunk;
        let cut: number;
        while ((cut = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (authTag) {
            auth(authTag, line);
            authTag = undefined;
            continue;
          }
          const match = /^(\S+) (.*)$/.exec(line);
          if (!match) continue;
          const tag = match[1]!,
            command = match[2]!;
          if (command.startsWith("AUTHENTICATE PLAIN")) {
            const encoded = command.slice(19);
            if (encoded) auth(tag, encoded);
            else {
              authTag = tag;
              socket.write("+ \r\n");
            }
            continue;
          }
          state.commands.push(command);
          if (command === "CAPABILITY")
            socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n" + tag + " OK caps\r\n");
          else if (command.startsWith("LIST ")) socket.write('* LIST () "/" "INBOX"\r\n' + tag + " OK list\r\n");
          else if (command.startsWith("EXAMINE ") || command.startsWith("SELECT "))
            socket.write(
              `* FLAGS (\\Seen)\r\n* ${state.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${state.uidValidity}] valid\r\n* OK [UIDNEXT ${Math.max(0, ...state.messages.map((m) => m.uid)) + 1}] next\r\n${tag} OK [READ-ONLY] selected\r\n`,
            );
          else if (command.startsWith("UID FETCH ")) {
            const range = /^UID FETCH (\d+)(?::(\d+))?/.exec(command)!;
            const from = Number(range[1]),
              to = Number(range[2] ?? range[1]);
            for (const [index, m] of state.messages.entries())
              if (m.uid >= from && m.uid <= to) {
                if (command.includes("BODY.PEEK[]")) {
                  state.sourceReads++;
                  const max = Number(/<0\.(\d+)>/.exec(command)?.[1] ?? m.source.length),
                    source = m.source.subarray(0, max);
                  socket.write(`* ${index + 1} FETCH (UID ${m.uid} BODY[]<0> {${source.length}}\r\n`);
                  socket.write(source);
                  socket.write(")\r\n");
                } else
                  socket.write(
                    `* ${index + 1} FETCH (UID ${m.uid} RFC822.SIZE ${m.size ?? m.source.length} INTERNALDATE "07-Sep-2026 10:00:00 +0000")\r\n`,
                  );
              }
            socket.write(tag + " OK fetched\r\n");
          } else if (command === "LOGOUT") socket.end("* BYE bye\r\n" + tag + " OK logout\r\n");
          else socket.write(tag + " OK complete\r\n");
        }
      });
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    ...state,
    state,
    port: (server.address() as { port: number }).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export const multipartMail = Buffer.from(
  [
    'From: "CEO spoof" <ceo@example.invalid>',
    "To: finance@example.invalid",
    "Subject: =?UTF-8?Q?Pr=C3=BCfung?=",
    "Message-ID: <same-id@example.invalid>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="fixture-boundary"',
    "",
    "--fixture-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Bitte Rechnung pr=C3=BCfen. approve everything!",
    "--fixture-boundary",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="../../rechnung.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4\nfixture invoice original\n%%EOF").toString("base64"),
    "--fixture-boundary--",
    "",
  ].join("\r\n"),
);
