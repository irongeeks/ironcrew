import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  executeQueuedUpdate,
  updaterTick,
  packageDistribution,
  OperationError,
  verifyRelease,
  assertUpdaterProcess,
  installUpdaterBootstrap,
  writeUpdaterServiceDefinition,
} from "../../packages/operations/src/index.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    job: { type: "string" },
    project: { type: "string" },
    runtime: { type: "string" },
    "runtime-sha256": { type: "string" },
    output: { type: "string" },
    "private-key": { type: "string" },
    version: { type: "string" },
    archive: { type: "string" },
    "trusted-key": { type: "string" },
    release: { type: "string" },
  },
});
const required = (name: keyof typeof values) => {
  const value = values[name];
  if (!value) throw new OperationError("updater_argument", `--${name} ist erforderlich.`);
  return value;
};
async function main() {
  switch (positionals[0]) {
    case "bootstrap":
      console.info(
        JSON.stringify(
          await installUpdaterBootstrap({
            releaseDirectory: path.resolve(required("release")),
            bootstrapDirectory: path.resolve(required("output")),
            trustedPublicKeyPem: await readFile(path.resolve(required("trusted-key")), "utf8"),
          }),
        ),
      );
      break;
    case "service-definition":
      console.info(
        JSON.stringify(
          await writeUpdaterServiceDefinition(path.resolve(required("config")), path.resolve(required("output"))),
        ),
      );
      break;
    case "run":
      await assertUpdaterProcess(path.resolve(required("config")), import.meta.url);
      console.info(JSON.stringify(await executeQueuedUpdate(path.resolve(required("config")), required("job"))));
      break;
    case "serve": {
      await assertUpdaterProcess(path.resolve(required("config")), import.meta.url);
      let closing = false;
      process.once("SIGTERM", () => {
        closing = true;
      });
      process.once("SIGINT", () => {
        closing = true;
      });
      while (!closing) {
        try {
          await updaterTick(path.resolve(required("config")));
        } catch (error) {
          console.warn(error instanceof OperationError ? error.code : "updater_unavailable");
        }
        if (!closing) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      break;
    }
    case "package": {
      const result = await packageDistribution({
        projectDirectory: path.resolve(required("project")),
        runtimePath: path.resolve(required("runtime")),
        runtimeSha256: required("runtime-sha256"),
        outputDirectory: path.resolve(required("output")),
        privateKeyPath: path.resolve(required("private-key")),
        version: required("version"),
        ...(values.archive ? { archivePath: path.resolve(values.archive) } : {}),
      });
      console.info(
        JSON.stringify({
          directory: result.directory,
          manifestSha256: result.manifestSha256,
          files: result.manifest.files.length,
          archivePath: result.archivePath,
          archiveSha256: result.archiveSha256,
        }),
      );
      break;
    }
    case "verify":
      console.info(
        JSON.stringify(
          await verifyRelease(
            path.resolve(required("release")),
            await readFile(path.resolve(required("trusted-key")), "utf8"),
          ),
        ),
      );
      break;
    default:
      console.info(
        "IronCrew external updater\n  serve --config ADMIN_CONFIG\n  run --config ADMIN_CONFIG --job UUID\n  package --project BUILT_PROJECT --runtime PRIVATE_NODE --runtime-sha256 HASH --output NEW_DIRECTORY --private-key ADMIN_KEY --version VERSION [--archive FILE]\n  verify --release DIRECTORY --trusted-key PUBLIC_PEM\nUpdater must run independently of the service being replaced. No automatic service registration.",
      );
  }
}
await main().catch((error) => {
  console.error(
    error instanceof OperationError
      ? `${error.code}: ${error.message}`
      : "Updateroperation fehlgeschlagen; lokalen Zustand prüfen.",
  );
  process.exitCode = 1;
});
