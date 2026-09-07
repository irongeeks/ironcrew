import { spawn } from "node:child_process";
import path from "node:path";
import type { Repository } from "../../persistence/src/index.ts";
import { OperationError } from "./common.ts";
/** Fixed RPC port: privileged updater never opens a service-user-controlled SQLite/WAL pathname. */
export function openOwnerRepository(options: {
  bootstrapDirectory: string;
  dataDirectory: string;
  uid: number;
  gid: number;
}): Repository {
  const child = spawn(
    path.join(options.bootstrapDirectory, "runtime/node"),
    [path.join(options.bootstrapDirectory, "dist/apps/updater/database.js"), options.dataDirectory],
    {
      cwd: options.bootstrapDirectory,
      uid: options.uid,
      gid: options.gid,
      env: { LANG: "C", TZ: "UTC" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let sequence = 0,
    buffer = "",
    closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const fail = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new OperationError("owner_database_unknown", "Datenbankhelfer wurde unterbrochen; Zustand bleibt ungeklärt."),
      );
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => {
    closed = true;
    fail();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 2_000_000) {
      child.kill();
      fail();
      return;
    }
    for (;;) {
      const position = buffer.indexOf("\n");
      if (position < 0) break;
      const line = buffer.slice(0, position);
      buffer = buffer.slice(position + 1);
      try {
        const response = JSON.parse(line),
          item = pending.get(response.id);
        if (!item) continue;
        pending.delete(response.id);
        clearTimeout(item.timer);
        if (response.error)
          item.reject(
            new OperationError(response.error.code, "Datenbankoperation unter Dienstidentität wurde abgelehnt."),
          );
        else item.resolve(response.result);
      } catch {
        child.kill();
        fail();
      }
    }
  });
  const methods = ["snapshot", "getDocument", "listDocuments", "transact", "putDocument", "setupState"];
  const call = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new OperationError("owner_database_closed", "Datenbankhelfer ist beendet."));
      const id = ++sequence,
        timer = setTimeout(() => {
          child.kill();
          fail();
        }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n", (error) => {
        if (error) {
          child.kill();
          fail();
        }
      });
    });
  const port: Record<string, unknown> = {};
  for (const method of methods) port[method] = (...args: unknown[]) => call(method, args);
  port.close = async () => {
    if (closed) return;
    await call("close", []);
    child.stdin.end();
  };
  return port as unknown as Repository;
}
