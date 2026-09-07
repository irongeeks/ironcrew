import { sha256 } from "../../packages/domain/src/index.ts";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import {
  readUpdaterConfiguration,
  readInstalledReleaseIdentity,
  queueProductionUpdate,
  consumeUpdateResults,
  OperationError,
} from "../../packages/operations/src/index.ts";

/** Only the signed installed entrypoint may advertise that installed release or queue its replacement. */
export async function productionUpdates(options: {
  repo: Repository;
  directory: string;
  configurationPath: string;
  entrypoint: string;
  executable: string;
  cwd: string;
}) {
  const config = await readUpdaterConfiguration(options.configurationPath);
  const setup = await options.repo.setupState();
  if (
    !setup ||
    setup.company.id !== config.companyId ||
    (await realpath(options.directory)) !== config.dataDirectory ||
    (await realpath(options.cwd)) !== config.installDirectory ||
    (await realpath(options.entrypoint)) !== path.join(config.installDirectory, "dist/apps/control/main.js") ||
    (await realpath(options.executable)) !==
      path.join(config.installDirectory, process.platform === "win32" ? "runtime/node.exe" : "runtime/node")
  )
    throw new OperationError(
      "updater_installation_mismatch",
      "Updater passt nicht zur tatsächlich gestarteten Installation.",
    );
  const releaseIdentity = await readInstalledReleaseIdentity(config.installDirectory, config.trustedPublicKeyPem);
  return {
    releaseIdentity,
    updateConfigurationFingerprint: async () => sha256(await readUpdaterConfiguration(options.configurationPath)),
    updateExecutor: (input: { scope: Scope; ceoId: string; planId: string }) =>
      queueProductionUpdate({ ...input, repo: options.repo, configurationPath: options.configurationPath }),
    consumeResults: () => consumeUpdateResults(options.repo, options.configurationPath),
  };
}
