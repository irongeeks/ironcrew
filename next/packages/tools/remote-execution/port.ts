import type { ExecutionPort, ExecutionRequest } from "../isolation/types.ts";
import { RemoteExecutionServer } from "./server.ts";
const remotePorts = new WeakSet<object>();
/** Trust is delegated to an enrolled worker; each execution checks its live attestation and streams. */
export function createRemotePort(server: RemoteExecutionServer, workerId: string): ExecutionPort {
  if (!RemoteExecutionServer.isCoordinator(server)) throw new Error("remote_coordinator_required");
  const port = Object.freeze({ execute: (request: ExecutionRequest) => server.execute(workerId, request) });
  remotePorts.add(port);
  return port;
}
export const isVerifiedRemotePort = (port: object) => remotePorts.has(port);
