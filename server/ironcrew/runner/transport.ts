/** Explicit runner transports. Never downgrade a failed TLS connection to Unix
 * or plaintext TCP, and never disable certificate/hostname verification.
 */
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import type { RunnerConnection } from "./runner-session.ts";

export interface RunnerTransport {
  mode: "unix" | "tls";
  label: string;
  socketPath?: string;
  token: string;
  connect(): Promise<RunnerConnection>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the configured runner transport.`);
  return value;
}

export interface RunnerTlsListenerOptions {
  host: string;
  port: number;
  certFile: string;
  keyFile: string;
  clientCaFile: string;
}

export function runnerTlsListenerFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerTlsListenerOptions | null {
  if (!env.IRONCREW_RUNNER_TLS_PORT) return null;
  const port = Number(env.IRONCREW_RUNNER_TLS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IRONCREW_RUNNER_TLS_PORT must be 1–65535.");
  return {
    host: env.IRONCREW_RUNNER_TLS_HOST?.trim() || "127.0.0.1",
    port,
    certFile: required(env, "IRONCREW_RUNNER_TLS_CERT_FILE"),
    keyFile: required(env, "IRONCREW_RUNNER_TLS_KEY_FILE"),
    clientCaFile: required(env, "IRONCREW_RUNNER_TLS_CLIENT_CA_FILE"),
  };
}

export function runnerTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  adapters: { tlsConnect?: typeof tls.connect; netConnect?: typeof net.connect } = {},
): RunnerTransport | null {
  const socketPath = env.IRONCREW_RUNNER_SOCKET?.trim();
  const endpoint = env.IRONCREW_RUNNER_URL?.trim();
  if (!socketPath && !endpoint) return null;
  if (socketPath && endpoint)
    throw new Error("Configure one runner transport: IRONCREW_RUNNER_SOCKET or IRONCREW_RUNNER_URL.");
  const token = required(env, "IRONCREW_RUNNER_TOKEN");
  if (socketPath)
    return {
      mode: "unix",
      label: socketPath,
      socketPath,
      token,
      connect: () =>
        new Promise((resolve, reject) => {
          const socket = (adapters.netConnect ?? net.connect)(socketPath);
          socket.setEncoding("utf-8");
          socket.setTimeout(15_000, () => socket.destroy(new Error("Runner connection timed out.")));
          socket.once("connect", () => {
            socket.setTimeout(0);
            resolve(socket);
          });
          socket.once("error", (err) => {
            socket.destroy();
            reject(err);
          });
        }),
    };
  let url: URL;
  try {
    url = new URL(endpoint!);
  } catch {
    throw new Error("IRONCREW_RUNNER_URL must be tls://hostname:port.");
  }
  if (
    url.protocol !== "tls:" ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw new Error("IRONCREW_RUNNER_URL must be tls://hostname:port without credentials or paths.");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Runner TLS port must be 1–65535.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const caFile = required(env, "IRONCREW_RUNNER_CA_FILE");
  const certFile = required(env, "IRONCREW_RUNNER_CERT_FILE");
  const keyFile = required(env, "IRONCREW_RUNNER_KEY_FILE");
  return {
    mode: "tls",
    label: `${hostname}:${port}`,
    token,
    connect: () =>
      new Promise((resolve, reject) => {
        // Read files per connection: rotated certificates apply to new jobs.
        const socket = (adapters.tlsConnect ?? tls.connect)({
          host: hostname,
          port,
          ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
          ca: fs.readFileSync(caFile),
          cert: fs.readFileSync(certFile),
          key: fs.readFileSync(keyFile),
          rejectUnauthorized: true,
          checkServerIdentity: tls.checkServerIdentity,
          minVersion: "TLSv1.3",
        });
        socket.setEncoding("utf-8");
        socket.setTimeout(15_000, () => socket.destroy(new Error("Runner TLS handshake timed out.")));
        socket.once("secureConnect", () => {
          if (!socket.authorized) {
            socket.destroy();
            reject(new Error("Runner TLS certificate was not authenticated."));
            return;
          }
          socket.setTimeout(0);
          resolve(socket);
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      }),
  };
}
