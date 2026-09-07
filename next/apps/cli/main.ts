import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { issueSetupToken } from "../control/auth.ts";
import {
  createBackup,
  restoreBackup,
  verifyRelease,
  writeServiceBundle,
  PLATFORM_MATRIX,
  OperationError,
  acquireInstanceLock,
} from "../../packages/operations/src/index.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    age: { type: "string" },
    recipient: { type: "string" },
    identity: { type: "string" },
    archive: { type: "string" },
    output: { type: "string" },
    release: { type: "string" },
    "trusted-key": { type: "string" },
    platform: { type: "string" },
    role: { type: "string" },
    "program-dir": { type: "string" },
    help: { type: "boolean" },
  },
});
const command = positionals[0] ?? "help";
const dataDirectory = path.resolve(values["data-dir"] ?? ".var");
const required = (value: string | undefined, name: string) => {
  if (!value) throw new OperationError("argument", `--${name} ist erforderlich.`);
  return value;
};
async function main() {
  switch (command) {
    case "setup": {
      const lease = await acquireInstanceLock(dataDirectory, "setup");
      try {
        const token = await issueSetupToken(lease.directory);
        console.info(`Einmaliges Setup-Token (15 Minuten): ${token}`);
      } finally {
        await lease.release();
      }
      break;
    }
    case "backup": {
      const lease = await acquireInstanceLock(dataDirectory, "offline-backup");
      try {
        await mkdir(path.join(lease.directory, "blobs"), { recursive: true, mode: 0o700 });
        let configuration: Record<string, unknown> = {};
        try {
          configuration = JSON.parse(await readFile(path.join(lease.directory, "configuration.json"), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const result = await createBackup({
          databasePath: path.join(lease.directory, "company.sqlite"),
          blobDirectory: path.join(lease.directory, "blobs"),
          outputDirectory: path.resolve(required(values.output, "output")),
          ageExecutable: path.resolve(required(values.age, "age")),
          recipient: required(values.recipient, "recipient"),
          appVersion: "0.4.0-dev.0",
          configuration,
          quiesce: async () => async () => {}, // The outer shared instance lease already freezes the offline operation.
        });
        console.info(
          JSON.stringify(
            { archivePath: result.archivePath, sha256: result.sha256, files: result.manifest.files.length },
            null,
            2,
          ),
        );
      } finally {
        await lease.release();
      }
      break;
    }
    case "restore": {
      const lease = await acquireInstanceLock(dataDirectory, "offline-restore");
      let replacement: Awaited<ReturnType<typeof lease.prepareReplacement>> | undefined;
      let previous: string | undefined;
      try {
        const result = await restoreBackup({
          archivePath: path.resolve(required(values.archive, "archive")),
          identityPath: path.resolve(required(values.identity, "identity")),
          ageExecutable: path.resolve(required(values.age, "age")),
          targetDirectory: lease.directory,
          beforeActivate: async (stagedDirectory) => {
            replacement = await lease.prepareReplacement(stagedDirectory);
          },
        });
        previous = result.previousDirectory;
        console.info(JSON.stringify(result, null, 2));
      } finally {
        await replacement?.finish(previous);
        await lease.release();
      }
      break;
    }
    case "verify-release": {
      const result = await verifyRelease(
        path.resolve(required(values.release, "release")),
        await readFile(path.resolve(required(values["trusted-key"], "trusted-key")), "utf8"),
      );
      console.info(JSON.stringify(result, null, 2));
      break;
    }
    case "service-bundle": {
      const platform = values.platform ?? process.platform;
      const role = values.role ?? "control";
      if (!["linux", "darwin", "win32"].includes(platform) || !["control", "worker"].includes(role))
        throw new OperationError("platform", "Dienstplattform oder Rolle wird nicht unterstützt.");
      const bundle = await writeServiceBundle(path.resolve(required(values.output, "output")), {
        platform: platform as "linux" | "darwin" | "win32",
        role: role as "control" | "worker",
        programDirectory: values["program-dir"],
        dataDirectory: values["data-dir"],
      });
      console.info(
        JSON.stringify(
          { definition: bundle.name, registration: bundle.scriptName, output: values.output, installed: false },
          null,
          2,
        ),
      );
      break;
    }
    case "platforms":
      console.info(JSON.stringify(PLATFORM_MATRIX, null, 2));
      break;
    default:
      console.info(
        "IronCrew CLI\n  setup [--data-dir PATH]\n  backup --age PATH --recipient PUBLIC_KEY --output PATH [--data-dir PATH]\n  restore --age PATH --identity PATH --archive PATH [--data-dir PATH]\n  verify-release --release PATH --trusted-key PATH\n  service-bundle --output PATH [--platform linux|darwin|win32] [--role control|worker] [--program-dir PATH] [--data-dir PATH]\n  platforms\nOffline-Wartung benötigt eine beendete Zentrale. Wiederherstellung startet mit pausierten Routinen und Dispatch.",
      );
  }
}
await main().catch((error) => {
  console.error(
    error instanceof OperationError
      ? `${error.code}: ${error.message}`
      : "Betriebsaktion fehlgeschlagen. Eingaben und Dienstzustand prüfen.",
  );
  process.exitCode = 1;
});
