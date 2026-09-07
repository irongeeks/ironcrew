import { parentPort, workerData } from "node:worker_threads";
import { createBackup, type BackupOptions } from "../../packages/operations/src/backup.ts";
import { OperationError } from "../../packages/operations/src/common.ts";
const data = workerData as Omit<BackupOptions, "quiesce" | "snapshotDatabase">;
try {
  const result = await createBackup({ ...data, quiesce: async () => async () => {} });
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof OperationError ? error.code : "backup_failed" });
}
