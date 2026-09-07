import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { verifyRelease, activateRelease } from "./releases.ts";
import { OperationError } from "./common.ts";
import { readUpdaterConfiguration } from "./updater.ts";
/** Installs an independently signed bootstrap into a NEW administrator-selected directory. Never registers/stops services. */
export async function installUpdaterBootstrap(options: {
  releaseDirectory: string;
  bootstrapDirectory: string;
  trustedPublicKeyPem: string;
}) {
  try {
    await lstat(options.bootstrapDirectory);
    throw new OperationError("bootstrap_exists", "Bootstrapziel existiert bereits; kein automatischer Selbstersatz.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = await verifyRelease(options.releaseDirectory, options.trustedPublicKeyPem, {
    platform: process.platform,
    arch: process.arch,
  });
  if (!manifest.files.some((f) => f.path === "dist/apps/updater/main.js"))
    throw new OperationError("updater_entrypoint", "Signierter Updater-Einstieg fehlt.");
  return activateRelease({
    releaseDirectory: options.releaseDirectory,
    installDirectory: options.bootstrapDirectory,
    trustedPublicKeyPem: options.trustedPublicKeyPem,
    currentSchemaVersion: 1,
    beforeActivate: async () => {},
    healthCheck: async (directory) => {
      await verifyRelease(directory, options.trustedPublicKeyPem);
      return true;
    },
    restartPrevious: async () => {},
  });
}
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** Produces reviewable definitions only. Privileges and registration remain administrator-managed. */
export async function writeUpdaterServiceDefinition(configurationPath: string, outputDirectory: string) {
  const config = await readUpdaterConfiguration(configurationPath),
    file = await realpath(configurationPath),
    root = config.bootstrapDirectory;
  const manifest = await verifyRelease(root, config.trustedPublicKeyPem, {
    platform: process.platform,
    arch: process.arch,
  });
  if (!manifest.files.some((f) => f.path === "dist/apps/updater/main.js"))
    throw new OperationError("updater_entrypoint", "Signierter Updater-Einstieg fehlt.");
  const name = "ironcrew-updater",
    runtime = path.join(root, process.platform === "win32" ? "runtime/node.exe" : "runtime/node"),
    entry = path.join(root, "dist/apps/updater/main.js");
  for (const value of [file, root, runtime, entry])
    if (/[\r\n\0]/.test(value)) throw new OperationError("service_path", "Dienstpfad enthält Steuerzeichen.");
  const q = (s: string) =>
    '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$") + '"';
  let filename: string, definition: string;
  if (process.platform === "linux") {
    filename = name + ".service";
    definition = `[Unit]\nDescription=IronCrew independent signed updater\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${q(root)}\nExecStart=${q(runtime)} ${q(entry)} serve --config ${q(file)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=300\nUMask=0077\nPrivateTmp=true\nProtectHome=read-only\n\n[Install]\nWantedBy=multi-user.target\n`;
  } else if (process.platform === "darwin") {
    filename = name + ".plist";
    definition = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[runtime, entry, "serve", "--config", file].map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>300</integer><key>Umask</key><integer>63</integer></dict></plist>\n`;
  } else {
    filename = name + ".xml";
    definition = `<service><id>${name}</id><name>IronCrew independent updater</name><description>Independent signed update executor</description><executable>${xml(runtime)}</executable><arguments>${[entry, "serve", "--config", file].map((v) => "&quot;" + xml(v) + "&quot;").join(" ")}</arguments><workingdirectory>${xml(root)}</workingdirectory><stoptimeout>300 sec</stoptimeout><onfailure action="restart" delay="10 sec"/></service>\n`;
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(outputDirectory, filename);
  await writeFile(destination, definition, { flag: "wx", mode: 0o600 });
  return { definitionPath: destination, serviceName: name, registrationPerformed: false as const };
}

export async function assertUpdaterProcess(configurationPath: string, entrypoint: string) {
  const config = await readUpdaterConfiguration(configurationPath);
  const expected = path.join(config.bootstrapDirectory, "dist/apps/updater/main.js");
  if (
    (await realpath(fileURLToPath(entrypoint))) !== expected ||
    (await realpath(process.execPath)) !==
      path.join(config.bootstrapDirectory, process.platform === "win32" ? "runtime/node.exe" : "runtime/node") ||
    (await realpath(process.cwd())) !== config.bootstrapDirectory
  )
    throw new OperationError(
      "updater_bootstrap_execution",
      "Updater muss aus seinem unabhängigen signierten Bootstrap mit privater Runtime starten.",
    );
  const manifest = await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem, {
    platform: process.platform,
    arch: process.arch,
  });
  if (!manifest.files.some((f) => f.path === "dist/apps/updater/main.js"))
    throw new OperationError("updater_entrypoint", "Signierter Updater-Einstieg fehlt.");
}
