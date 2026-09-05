import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { runnerTransportFromEnv, runnerTlsListenerFromEnv } from "./transport.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-transport-"));
  for (const file of ["ca", "cert", "key"]) fs.writeFileSync(path.join(dir, file), `test-${file}`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function env(): NodeJS.ProcessEnv {
  return {
    IRONCREW_RUNNER_URL: "tls://runner.example.test:7443",
    IRONCREW_RUNNER_TOKEN: "shared-token",
    IRONCREW_RUNNER_CA_FILE: path.join(dir, "ca"),
    IRONCREW_RUNNER_CERT_FILE: path.join(dir, "cert"),
    IRONCREW_RUNNER_KEY_FILE: path.join(dir, "key"),
  };
}
class FakeSocket extends EventEmitter {
  authorized = true;
  setEncoding = vi.fn();
  setTimeout = vi.fn();
  destroy = vi.fn();
}

describe("explicit runner transports", () => {
  it("is disabled without explicit configuration and rejects insecure/incomplete endpoints", () => {
    expect(runnerTransportFromEnv({})).toBeNull();
    expect(() => runnerTransportFromEnv({ ...env(), IRONCREW_RUNNER_SOCKET: "/run/runner.sock" })).toThrow(
      /one runner/,
    );
    expect(() => runnerTransportFromEnv({ ...env(), IRONCREW_RUNNER_URL: "tcp://runner.example:7443" })).toThrow(/tls/);
    expect(() =>
      runnerTransportFromEnv({ ...env(), IRONCREW_RUNNER_URL: "tls://user:secret@runner.example:7443" }),
    ).toThrow(/credentials/);
    expect(() => runnerTransportFromEnv({ ...env(), IRONCREW_RUNNER_CA_FILE: "" })).toThrow(/CA_FILE/);
    expect(() => runnerTransportFromEnv({ ...env(), IRONCREW_RUNNER_TOKEN: "" })).toThrow(/TOKEN/);
  });

  it("pins CA, hostname validation, client certificate and TLS 1.3, and rereads rotated files", async () => {
    const options: tls.ConnectionOptions[] = [];
    const sockets: FakeSocket[] = [];
    const tlsConnect = ((opts: tls.ConnectionOptions) => {
      options.push(opts);
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }) as unknown as typeof tls.connect;
    const transport = runnerTransportFromEnv(env(), { tlsConnect })!;
    await transport.connect();
    expect(options[0]).toMatchObject({
      host: "runner.example.test",
      servername: "runner.example.test",
      port: 7443,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      checkServerIdentity: tls.checkServerIdentity,
    });
    expect(options[0].ca).toEqual(Buffer.from("test-ca"));
    expect(options[0].cert).toEqual(Buffer.from("test-cert"));
    expect(options[0].key).toEqual(Buffer.from("test-key"));
    fs.writeFileSync(path.join(dir, "cert"), "rotated-cert");
    await transport.connect();
    expect(options[1].cert).toEqual(Buffer.from("rotated-cert"));
    expect(sockets[0].setTimeout).toHaveBeenCalledWith(0);
  });

  it("refuses an unauthorized TLS connection even if secureConnect fires", async () => {
    const socket = new FakeSocket();
    socket.authorized = false;
    const tlsConnect = (() => {
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }) as unknown as typeof tls.connect;
    await expect(runnerTransportFromEnv(env(), { tlsConnect })!.connect()).rejects.toThrow(/not authenticated/);
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("requires all listener certificate inputs and defaults to loopback", () => {
    expect(runnerTlsListenerFromEnv({})).toBeNull();
    expect(() => runnerTlsListenerFromEnv({ IRONCREW_RUNNER_TLS_PORT: "0" })).toThrow(/1–65535/);
    expect(() => runnerTlsListenerFromEnv({ IRONCREW_RUNNER_TLS_PORT: "7443" })).toThrow(/CERT_FILE/);
    expect(
      runnerTlsListenerFromEnv({
        IRONCREW_RUNNER_TLS_PORT: "7443",
        IRONCREW_RUNNER_TLS_CERT_FILE: "cert",
        IRONCREW_RUNNER_TLS_KEY_FILE: "key",
        IRONCREW_RUNNER_TLS_CLIENT_CA_FILE: "ca",
      }),
    ).toMatchObject({ host: "127.0.0.1", port: 7443 });
  });
});
