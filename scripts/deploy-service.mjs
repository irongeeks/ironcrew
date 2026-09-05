#!/usr/bin/env node
/** Install definitions only; services are never started or enabled implicitly. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderService, serviceOptions } from "./lib/service-definitions.mjs";
const argv = process.argv.slice(2);
const action = argv.shift();
if (!["render", "install", "uninstall"].includes(action)) {
  console.log(
    "Usage: node scripts/deploy-service.mjs render|install|uninstall [--role control|runner] [--platform linux|darwin] [--prefix /opt/ironcrew] [--node /absolute/node] [--user dedicated-user] [--group ironcrew] [--env-file /etc/ironcrew/ironcrew.env] [--output ./staging]",
  );
  process.exit(action ? 1 : 0);
}
const supplied = {};
let output;
for (let i = 0; i < argv.length; i += 2) {
  const key = {
    "--role": "role",
    "--platform": "platform",
    "--prefix": "prefix",
    "--node": "node",
    "--user": "user",
    "--group": "group",
    "--env-file": "envFile",
  }[argv[i]];
  if (argv[i] === "--output") output = argv[i + 1];
  else if (key) supplied[key] = argv[i + 1];
  else throw new Error(`Unknown option ${argv[i]}`);
  if (!argv[i + 1]) throw new Error(`Missing value for ${argv[i]}`);
}
const options = serviceOptions(supplied);
const definition = renderService(options);
if (action === "render") {
  if (output) {
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(output, definition.name), definition.content, { mode: 0o644 });
  } else process.stdout.write(definition.content);
  process.exit(0);
}
if (process.getuid?.() !== 0)
  throw new Error("Installation/removal requires root; use render to inspect the exact definition first.");
if (options.platform !== process.platform) throw new Error("Cannot install definitions for another operating system.");
const destination = path.join(
  options.platform === "darwin" ? "/Library/LaunchDaemons" : "/etc/systemd/system",
  definition.name,
);
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed.`);
};
if (action === "uninstall") {
  const existing = fs.existsSync(destination);
  if (existing) {
    if (options.platform === "darwin") {
      const label = `system/eu.irongeeks.${options.role === "runner" ? "ironcrew-runner" : "ironcrew"}`;
      if (spawnSync("launchctl", ["print", label], { stdio: "ignore" }).status === 0)
        run("launchctl", ["bootout", label]);
    } else run("systemctl", ["disable", "--now", definition.name]);
    fs.unlinkSync(destination);
  }
  if (options.platform === "linux") run("systemctl", ["daemon-reload"]);
  console.log("Service definition removed. Accounts, credentials, application and data are retained.");
  process.exit(0);
}
if (
  !fs.existsSync(path.join(options.prefix, "server/index.ts")) ||
  !fs.existsSync(path.join(options.prefix, "dist/index.html"))
)
  throw new Error("Install requires an existing built IronCrew checkout.");
fs.accessSync(options.node, fs.constants.X_OK);
const version = spawnSync(options.node, ["-p", 'process.versions.node.split(".")[0]'], { encoding: "utf8" });
if (version.status !== 0 || Number(version.stdout.trim()) < 22) throw new Error("Node22+ is required.");
const identity = spawnSync("id", ["-u", options.user], { encoding: "utf8" });
if (identity.status !== 0 || Number(identity.stdout.trim()) === 0)
  throw new Error("Create a dedicated non-root service account first (see docs/SECURITY_OPERATIONS.md).");
const group = spawnSync("id", ["-g", options.user], { encoding: "utf8" });
if (group.status !== 0) throw new Error("Cannot resolve service group.");
const groupLookup = spawnSync("id", ["-Gn", options.user], { encoding: "utf8" });
if (!groupLookup.stdout.trim().split(/\s+/).includes(options.group))
  throw new Error("Service account must be a member of the selected group.");
const uid = Number(identity.stdout.trim());
// Resolve the selected group through a member account without evaluating commands.
const gidResult = spawnSync(
  options.platform === "darwin" ? "dscl" : "getent",
  options.platform === "darwin"
    ? [".", "-read", `/Groups/${options.group}`, "PrimaryGroupID"]
    : ["group", options.group],
  { encoding: "utf8" },
);
if (gidResult.status !== 0) throw new Error("Cannot resolve selected group.");
const gid = Number(
  options.platform === "darwin" ? gidResult.stdout.trim().split(/\s+/).at(-1) : gidResult.stdout.split(":")[2],
);
if (!Number.isSafeInteger(gid) || gid === 0) throw new Error("Invalid dedicated group.");
for (const dir of [
  `/var/lib/${options.user}`,
  ...(options.role === "control" ? [`${options.prefix}/data`] : []),
  "/var/lib/ironcrew-workspaces",
]) {
  const existed = fs.existsSync(dir);
  if (existed && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Service directories must not be symlinks.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  // Do not recursively change a checkout or existing data ownership.
  if (!existed || dir !== "/var/lib/ironcrew-workspaces" || options.role === "runner") fs.chownSync(dir, uid, gid);
  fs.chmodSync(dir, dir === `/var/lib/${options.user}` ? 0o700 : 0o750);
}
fs.mkdirSync(path.dirname(options.envFile), { recursive: true, mode: 0o755 });
if (!fs.existsSync(options.envFile)) {
  const base =
    options.role === "runner"
      ? `IRONCREW_RUNNER_SOCKET=${options.platform === "darwin" ? "/var/lib/ironcrew-workspaces/runner.sock" : "/run/ironcrew/runner.sock"}\nIRONCREW_RUNNER_WORKSPACE_ROOT=/var/lib/ironcrew-workspaces\nIRONCREW_RUNNER_TOKEN=__CHANGE_ME__\nPATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/var/lib/${options.user}/.local/bin\n`
      : `HOST=127.0.0.1\nPORT=8790\nDB_PATH=${options.prefix}/data/ironcrew.sqlite\nLOGS_DIR=${options.prefix}/data/logs\nOBSIDIAN_VAULT_PATH=${options.prefix}/data/vault\nOAUTH_ENCRYPTION_SECRET=__CHANGE_ME__\n`;
  fs.writeFileSync(options.envFile, base, { mode: 0o600, flag: "wx" });
  fs.chownSync(options.envFile, uid, gid);
} else {
  const info = fs.lstatSync(options.envFile);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Existing env file must be owned by service account with mode 0600; content is never overwritten.");
}
if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink())
  throw new Error("Service destination must not be a symlink.");
fs.writeFileSync(destination, definition.content, { mode: 0o644 });
fs.chownSync(destination, 0, 0);
fs.chmodSync(destination, 0o644);
if (options.platform === "linux") run("systemctl", ["daemon-reload"]);
console.log(
  `Installed ${destination}. Configure ${options.envFile}, then explicitly start using ${options.platform === "darwin" ? "sudo launchctl bootstrap system " + destination : "sudo systemctl enable --now " + definition.name}.`,
);
