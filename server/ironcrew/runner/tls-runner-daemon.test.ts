/** Local test CA only. No credentials, network services or production accounts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TlsRunnerDaemon } from "./tls-runner-daemon.ts";
import { runnerTransportFromEnv } from "./transport.ts";
import { RunnerRuntime } from "./runner-client.ts";
import { RUNNER_PROTOCOL_VERSION } from "./protocol.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import type { RunEvent } from "../runtime/run-events.ts";

let dir: string;
const file = (name: string) => path.join(dir, name);
const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mtls-"));
  fs.writeFileSync(
    file("ca.conf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=IronCrew Test CA",
    "-config",
    file("ca.conf"),
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.crt"),
  );
  for (const name of ["server", "client"]) {
    openssl(
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      `/CN=IronCrew Test ${name}`,
      "-keyout",
      file(`${name}.key`),
      "-out",
      file(`${name}.csr`),
    );
    fs.writeFileSync(
      file(`${name}.ext`),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}\n${name === "server" ? "subjectAltName=IP:127.0.0.1\n" : ""}`,
    );
    openssl(
      "x509",
      "-req",
      "-days",
      "1",
      "-in",
      file(`${name}.csr`),
      "-CA",
      file("ca.crt"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-extfile",
      file(`${name}.ext`),
      "-out",
      file(`${name}.crt`),
    );
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function start() {
  const daemon = new TlsRunnerDaemon({
    token: "test-application-token",
    workspaceRoot: dir,
    runtimes: [new MockRuntime({ responseText: "Remote geprüft." })],
    tls: {
      host: "127.0.0.1",
      port: 0,
      certFile: file("server.crt"),
      keyFile: file("server.key"),
      clientCaFile: file("ca.crt"),
    },
  });
  await daemon.listen();
  const address = daemon.address;
  if (!address || typeof address === "string") throw new Error("Missing TLS listener address.");
  const env = {
    IRONCREW_RUNNER_URL: `tls://127.0.0.1:${address.port}`,
    IRONCREW_RUNNER_TOKEN: "test-application-token",
    IRONCREW_RUNNER_CA_FILE: file("ca.crt"),
    IRONCREW_RUNNER_CERT_FILE: file("client.crt"),
    IRONCREW_RUNNER_KEY_FILE: file("client.key"),
  };
  return { daemon, address, env };
}

describe("remote run protocol over real mutual TLS", () => {
  it("rejects a trusted certificate for the wrong hostname and an untrusted server CA", async () => {
    const { daemon, env, address } = await start();
    try {
      const dnsToLoopback = ((options: tls.ConnectionOptions) =>
        tls.connect({ ...options, host: "127.0.0.1" })) as typeof tls.connect;
      const wrongHost = runnerTransportFromEnv(
        { ...env, IRONCREW_RUNNER_URL: `tls://wrong.example.test:${address.port}` },
        { tlsConnect: dnsToLoopback },
      )!;
      await expect(wrongHost.connect()).rejects.toThrow(/Hostname|IP|altnames/i);
      const wrongCa = runnerTransportFromEnv({ ...env, IRONCREW_RUNNER_CA_FILE: file("client.crt") })!;
      await expect(wrongCa.connect()).rejects.toThrow();
    } finally {
      await daemon.close();
    }
  });

  it("dispatches and streams a complete run with a trusted client certificate", async () => {
    const { daemon, env } = await start();
    try {
      const transport = runnerTransportFromEnv(env)!;
      const client = new RunnerRuntime({ runtimeType: "mock", ...transport, requestTimeoutMs: 2000 });
      const events: RunEvent[] = [];
      for await (const event of client.startRun(
        { prompt: "Prüfen" },
        {
          companyId: "company",
          projectId: "project",
          taskId: "task",
          runId: "run",
          agentId: "agent",
          correlationId: "corr",
          workspacePath: dir,
          permissionMode: "restricted",
        },
      ))
        events.push(event);
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(events.some((event) => event.payload.text === "Remote geprüft.")).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it("requires the application token even after successful mutual TLS", async () => {
    const { daemon, env } = await start();
    try {
      const client = new RunnerRuntime({
        runtimeType: "mock",
        ...runnerTransportFromEnv({ ...env, IRONCREW_RUNNER_TOKEN: "wrong-token" })!,
        requestTimeoutMs: 2000,
      });
      await expect(client.capabilities()).rejects.toThrow(/authentifiziert/);
    } finally {
      await daemon.close();
    }
  });

  it("rejects a TLS client which supplies no certificate", async () => {
    const { daemon, address } = await start();
    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = tls.connect({
            host: "127.0.0.1",
            port: address.port,
            ca: fs.readFileSync(file("ca.crt")),
            rejectUnauthorized: true,
            minVersion: "TLSv1.3",
          });
          socket.on("secureConnect", () =>
            socket.write(
              `${JSON.stringify({ v: RUNNER_PROTOCOL_VERSION, kind: "hello", token: "test-application-token" })}\n`,
            ),
          );
          socket.on("data", () => {
            socket.destroy();
            resolve();
          });
          socket.on("error", (err) => {
            socket.destroy();
            reject(err);
          });
          socket.setTimeout(2000, () =>
            socket.destroy(new Error("TLS peer failed to reject an unauthenticated client.")),
          );
        }),
      ).rejects.toThrow();
    } finally {
      await daemon.close();
    }
  });
});
