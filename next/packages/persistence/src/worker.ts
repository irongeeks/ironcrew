import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./store.ts";
import { DomainError } from "../../domain/src/index.ts";
const store = new Store((workerData as { path: string }).path);
const allowed = new Set([
  "commitPlan",
  "listCompanyDocuments",
  "eventsForCompany",
  "decideApproval",
  "assertDispatchAllowed",
  "authorizeAndTransact",
  "reserveAndTransact",
  "settleAndTransact",
  "listAllOrders",
  "setBudget",
  "health",
  "close",
  "setup",
  "setupState",
  "snapshot",
  "getIdentity",
  "createArea",
  "createOrder",
  "createOrderAndTransact",
  "getOrder",
  "listOrders",
  "updateOrder",
  "changeLead",
  "getDocument",
  "listDocuments",
  "putDocument",
  "transact",
  "createMandate",
  "revokeMandate",
  "approve",
  "assertAuthorized",
  "reserve",
  "settle",
  "markUnreconciled",
  "releaseReservation",
  "budget",
  "events",
  "verifyAudit",
  "pendingOutbox",
  "acknowledgeOutbox",
  "backup",
]);
parentPort!.on("message", (message: { id: number; method: string; args: unknown[] }) => {
  try {
    if (!allowed.has(message.method)) throw new DomainError("unknown_repository_operation");
    const method = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[message.method]!;
    const result = method.apply(store, message.args);
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) {
    const known = error instanceof DomainError;
    const invalid = error instanceof Error && error.name === "ZodError";
    parentPort!.postMessage({
      id: message.id,
      error: {
        code: known ? error.code : invalid ? "validation_error" : "persistence_error",
        message: known ? error.message : invalid ? "Invalid request" : "Database operation failed",
        status: known ? error.status : invalid ? 400 : 500,
      },
    });
  }
});
