import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const commandPath = (name) => spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

/** Only explicitly listed commands are visible; package managers and downloads are always local mocks. */
function fixture({
  nodeMajor = 26,
  pnpmVersion = "10.30.1",
  missing = [],
  platform = "Linux",
  arch = "x86_64",
  checksumMismatch = false,
  downloadFailure = false,
  packageFailure = false,
  npmFailure = false,
  downloadedNodeMajor = 26,
  packageNoop = false,
  missingCommandLineTools = false,
  shadowedBrewPython = false,
  brewPythonInstalled = false,
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "ironcrew-bootstrap-"));
  fixtures.push(directory);
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  const toolchain = path.join(home, "toolchain");
  const source = path.join(directory, "available");
  for (const item of [bin, home, source, path.join(directory, "scripts/lib")]) mkdirSync(item, { recursive: true });
  copyFileSync(path.join(root, "scripts/setup.sh"), path.join(directory, "scripts/setup.sh"));
  copyFileSync(
    path.join(root, "scripts/lib/bootstrap-requirements.sh"),
    path.join(directory, "scripts/lib/bootstrap-requirements.sh"),
  );
  writeFileSync(path.join(directory, "scripts/setup-wizard.mjs"), "");
  writeFileSync(path.join(directory, "package.json"), '{"packageManager":"pnpm@10.30.1+sha512.fixture"}');
  const log = path.join(directory, "commands.log");
  writeFileSync(log, "");
  const executable = (file, script) => {
    writeFileSync(file, `#!/bin/sh\nset -eu\n${script}\n`);
    chmodSync(file, 0o755);
  };
  const command = (name, script) => executable(path.join(bin, name), script);
  for (const name of [
    "dirname",
    "basename",
    "mkdir",
    "mktemp",
    "cp",
    "mv",
    "rm",
    "ln",
    "chmod",
    "tar",
    "gzip",
    "awk",
    "sed",
    "grep",
    "cut",
    "tr",
    "head",
    "cat",
    "sort",
    "find",
    "touch",
    "readlink",
    "shasum",
    "sha256sum",
  ]) {
    const target = commandPath(name);
    if (target && !missing.includes(name)) symlinkSync(target, path.join(bin, name));
  }
  symlinkSync(commandPath("gzip"), path.join(source, "gzip"));
  command(
    "uname",
    `case "$1" in -s) echo ${quote(platform)};; -m) echo ${quote(arch)};; *) echo ${quote(platform)};; esac`,
  );
  command("id", "echo 0");
  command(
    "xcode-select",
    `case "$1" in
    -p) ${missingCommandLineTools ? '[ -f "$BOOTSTRAP_BIN/clt-installed" ]' : "exit 0"};;
    --install) printf 'xcode-select --install\\n' >> "$BOOTSTRAP_LOG"; touch "$BOOTSTRAP_BIN/clt-installed"; for name in git make c++ g++ cc gcc python3; do cp "$BOOTSTRAP_SOURCE/$name" "$BOOTSTRAP_BIN/$name"; done;;
  esac`,
  );
  command("sleep", 'echo "Unexpected wait in fixture" >&2; exit 91');
  for (const name of ["git", "python3", "make", "c++", "g++", "cc", "gcc"]) {
    executable(path.join(source, name), "exit 0");
    if (!missing.includes(name)) copyFileSync(path.join(source, name), path.join(bin, name));
  }
  if (shadowedBrewPython) {
    const brewPrefix = path.join(directory, "homebrew");
    mkdirSync(path.join(brewPrefix, "bin"), { recursive: true });
    command("python3", "exit 1");
    if (brewPythonInstalled) copyFileSync(path.join(source, "python3"), path.join(brewPrefix, "bin/python3"));
    command(
      "brew",
      `case "$1" in
      --prefix) echo ${quote(brewPrefix)};;
      install) printf 'brew %s\\n' "$*" >> "$BOOTSTRAP_LOG"; cp "$BOOTSTRAP_SOURCE/python3" ${quote(path.join(brewPrefix, "bin/python3"))};;
      *) exit 90;;
    esac`,
    );
  }
  const pnpmScript = (version) =>
    `if [ "\${1:-}" = --version ] || [ "\${1:-}" = -v ]; then echo ${quote(version)}; else printf 'pnpm %s\\n' "$*" >> "$BOOTSTRAP_LOG"; fi`;
  executable(path.join(source, "pnpm"), pnpmScript("10.30.1"));
  if (pnpmVersion) command("pnpm", pnpmScript(pnpmVersion));
  const nodeScript = (
    major,
    downloaded = false,
  ) => `${downloaded ? 'printf "downloaded-node %s\\n" "$*" >> "$BOOTSTRAP_LOG"' : ""}
case "\${1:-}" in
  -e) exit ${major >= 26 ? 0 : 1};;
  -p) case "\${2:-}" in *packageManager*) printf 'pnpm@10.30.1';; *versions.node*|*process.version*) printf '${major}';; *) printf '${major}';; esac;;
  -v|--version) printf 'v${major}.0.0';;
  *) printf 'wizard %s\\n' "$*" >> "$BOOTSTRAP_LOG";;
esac`;
  const npmScript = `printf 'npm %s\\n' "$*" >> "$BOOTSTRAP_LOG"
${npmFailure ? "exit 43" : ""}
prefix=""
while [ "$#" -gt 0 ]; do
  case "$1" in --prefix) prefix="$2"; shift 2;; --prefix=*) prefix="\${1#--prefix=}"; shift;; *) shift;; esac
done
if [ -n "$prefix" ]; then mkdir -p "$prefix/bin"; cp "$BOOTSTRAP_SOURCE/pnpm" "$prefix/bin/pnpm"; else cp "$BOOTSTRAP_SOURCE/pnpm" "$BOOTSTRAP_BIN/pnpm"; fi`;
  if (nodeMajor !== null) command("node", nodeScript(nodeMajor));
  if (!missing.includes("npm")) command("npm", npmScript);
  const archiveName = `node-v26.0.0-${platform === "Darwin" ? "darwin" : "linux"}-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"}`;
  const archiveRoot = path.join(directory, "archive", archiveName);
  mkdirSync(path.join(archiveRoot, "bin"), { recursive: true });
  executable(path.join(archiveRoot, "bin/node"), nodeScript(downloadedNodeMajor, true));
  executable(path.join(archiveRoot, "bin/npm"), npmScript);
  const archive = path.join(directory, `${archiveName}.tar.gz`);
  const packed = spawnSync(commandPath("tar"), ["-czf", archive, "-C", path.dirname(archiveRoot), archiveName]);
  if (packed.status !== 0) throw new Error(packed.stderr.toString());
  const hash = checksumMismatch ? "0".repeat(64) : createHash("sha256").update(readFileSync(archive)).digest("hex");
  const manifest = path.join(directory, "SHASUMS256.txt");
  writeFileSync(manifest, `${hash}  ${archiveName}.tar.gz\n`);
  const curlScript = `printf 'curl %s\\n' "$*" >> "$BOOTSTRAP_LOG"
${downloadFailure ? "exit 22" : ""}
output=""; url=""
while [ "$#" -gt 0 ]; do
 case "$1" in -o|--output) output="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac
done
case "$url" in
 *SHASUMS256.txt) file="$BOOTSTRAP_MANIFEST";;
 *.tar.gz) file="$BOOTSTRAP_ARCHIVE";;
 *) echo "Unexpected download: $url" >&2; exit 90;;
esac
if [ -n "$output" ]; then cp "$file" "$output"; else cat "$file"; fi`;
  executable(path.join(source, "curl"), curlScript);
  if (!missing.includes("curl")) copyFileSync(path.join(source, "curl"), path.join(bin, "curl"));
  command(
    "apt-get",
    `printf 'apt-get %s\\n' "$*" >> "$BOOTSTRAP_LOG"
${packageFailure ? "exit 42" : ""}
if [ "\${1:-}" = install ]; then
 ${packageNoop ? ":" : 'for file in "$BOOTSTRAP_SOURCE"/*; do case "$file" in */pnpm) continue;; esac; [ -e "$BOOTSTRAP_BIN/${file##*/}" ] && continue; cp "$file" "$BOOTSTRAP_BIN/"; done'}
fi`,
  );
  return {
    directory,
    toolchain,
    run: (...args) =>
      spawnSync("/bin/bash", [path.join(directory, "scripts/setup.sh"), ...args], {
        encoding: "utf8",
        env: {
          PATH: bin,
          HOME: home,
          IRONCREW_TOOLCHAIN_DIR: toolchain,
          BOOTSTRAP_BIN: bin,
          BOOTSTRAP_SOURCE: source,
          BOOTSTRAP_LOG: log,
          BOOTSTRAP_ARCHIVE: archive,
          BOOTSTRAP_MANIFEST: manifest,
        },
      }),
    calls: () => readFileSync(log, "utf8"),
  };
}

describe.skipIf(process.platform === "win32")("native setup bootstrap", () => {
  it("reuses installed requirements and runs dependency installation and the wizard", () => {
    const setup = fixture();
    const result = setup.run("--yes", "--port", "8912");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toContain("pnpm install --frozen-lockfile");
    expect(setup.calls()).toContain("wizard scripts/setup-wizard.mjs --yes --port 8912");
    expect(setup.calls()).not.toMatch(/apt-get|curl|\bnpm install/);
  });

  it("keeps an already compatible newer Node version", () => {
    const setup = fixture({ nodeMajor: 27 });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toBe("");
    expect(existsSync(setup.toolchain)).toBe(false);
  });

  it.each([false, true])(
    "uses Homebrew Python behind an older Python (already installed: %s)",
    (brewPythonInstalled) => {
      const setup = fixture({ platform: "Darwin", shadowedBrewPython: true, brewPythonInstalled });
      const result = setup.run("--requirements-only");
      expect(result.status, result.stderr).toBe(0);
      expect(setup.calls()).toBe(brewPythonInstalled ? "" : "brew install python\n");
      const calls = setup.calls();
      const repeated = setup.run("--check");
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(setup.calls()).toBe(calls);
    },
  );

  it("checks requirements without creating toolchain files or installing anything", () => {
    const setup = fixture({ nodeMajor: 24, pnpmVersion: null, missing: ["git"] });
    const result = setup.run("--check");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).not.toMatch(/apt-get|curl|npm install|pnpm install|wizard/);
    expect(existsSync(setup.toolchain)).toBe(false);
  });

  it("does not trigger macOS installation dialogs when checking missing Command Line Tools", () => {
    const setup = fixture({ platform: "Darwin", missingCommandLineTools: true });
    const result = setup.run("--check");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).toBe("");
    expect(existsSync(setup.toolchain)).toBe(false);
  });

  it("shows help without checking or installing requirements", () => {
    const setup = fixture({ nodeMajor: null, pnpmVersion: null, missing: ["curl", "git"] });
    const result = setup.run("--help");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--check");
    expect(setup.calls()).toBe("");
    expect(existsSync(setup.toolchain)).toBe(false);
  });

  it("can install user tools without modifying shell profiles", () => {
    const setup = fixture({ nodeMajor: 24 });
    const result = setup.run("--requirements-only", "--no-profile");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(setup.toolchain, "env.sh"))).toBe(true);
    expect(existsSync(path.join(setup.directory, "home/.bashrc"))).toBe(false);
    expect(existsSync(path.join(setup.directory, "home/.bash_profile"))).toBe(false);
    expect(existsSync(path.join(setup.directory, "home/.zshrc"))).toBe(false);
  });

  it("installs missing system tools and rechecks their availability", () => {
    const setup = fixture({ missing: ["git", "python3", "make", "c++", "g++", "cc", "gcc"] });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toMatch(/apt-get .*install .*git/);
    expect(setup.calls()).toContain("build-essential");
    expect(setup.calls()).not.toMatch(/curl|npm install|pnpm install|wizard/);
  });

  it("installs gzip when tar is present but its decompressor is missing", () => {
    const setup = fixture({ nodeMajor: 24, missing: ["gzip"] });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toMatch(/apt-get .*install .*gzip/);
    expect(setup.calls()).toContain("downloaded-node");
  });

  it.each([null, 22, 24, 25])("installs verified Node 26 when the installed major is %s", (nodeMajor) => {
    const setup = fixture({ nodeMajor });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toContain("https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt");
    expect(setup.calls()).toContain("node-v26.0.0-linux-x64.tar.gz");
    expect(setup.calls()).toContain("downloaded-node");
    expect(setup.calls()).not.toMatch(/pnpm install|wizard/);
    const before = setup.calls();
    const repeat = setup.run("--requirements-only");
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(setup.calls().slice(before.length)).not.toMatch(/curl|apt-get|npm install/);
  });

  it("never executes a downloaded Node archive with an invalid checksum", () => {
    const setup = fixture({ nodeMajor: 24, checksumMismatch: true });
    const result = setup.run("--requirements-only");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).not.toMatch(/downloaded-node|npm install|pnpm install|wizard/);
  });

  it("rejects a downloaded runtime that cannot execute as Node 26", () => {
    const setup = fixture({ nodeMajor: 24, downloadedNodeMajor: 24 });
    const result = setup.run("--requirements-only");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node 26 cannot run");
    expect(existsSync(path.join(setup.toolchain, "node"))).toBe(false);
    expect(setup.calls()).not.toMatch(/npm install|pnpm install|wizard/);
  });

  it("stops on failed downloads before running the downloaded toolchain", () => {
    const setup = fixture({ nodeMajor: null, downloadFailure: true });
    const result = setup.run("--requirements-only");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).toContain("curl");
    expect(setup.calls()).not.toMatch(/downloaded-node|npm install|pnpm install|wizard/);
  });

  it.each([null, "9.15.9"])("installs the pinned pnpm when version %s is present", (pnpmVersion) => {
    const setup = fixture({ pnpmVersion });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toMatch(/npm .*install .*pnpm@10\.30\.1/);
    expect(setup.calls()).not.toMatch(/apt-get|curl|pnpm install|wizard/);
    const before = setup.calls();
    const repeat = setup.run("--requirements-only");
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(setup.calls().slice(before.length)).not.toMatch(/curl|apt-get|npm install/);
  });

  it("installs an Apple Silicon Node archive using the same checksum verification", () => {
    const setup = fixture({ platform: "Darwin", arch: "arm64", nodeMajor: 24 });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toContain("node-v26.0.0-darwin-arm64.tar.gz");
    expect(setup.calls()).not.toMatch(/apt-get|xcode-select --install/);
  });

  it("installs missing macOS Command Line Tools and verifies them before continuing", () => {
    const setup = fixture({ platform: "Darwin", missingCommandLineTools: true, missing: ["git", "c++", "make"] });
    const result = setup.run("--requirements-only");
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toContain("xcode-select --install");
    expect(setup.calls()).not.toMatch(/apt-get|curl|npm install|pnpm install|wizard/);
  });

  it("stops if the pinned pnpm installation fails", () => {
    const setup = fixture({ pnpmVersion: null, npmFailure: true });
    const result = setup.run("--yes");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).toContain("npm install");
    expect(setup.calls()).not.toMatch(/pnpm install|wizard/);
  });

  it("stops if a package manager fails", () => {
    const setup = fixture({ missing: ["git"], packageFailure: true });
    const result = setup.run("--yes");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).toContain("apt-get");
    expect(setup.calls()).not.toMatch(/curl|npm install|pnpm install|wizard/);
  });

  it("does not continue if package installation succeeds without supplying required commands", () => {
    const setup = fixture({ missing: ["git"], packageNoop: true });
    const result = setup.run("--yes");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).not.toMatch(/curl|npm install|pnpm install|wizard/);
  });

  it("rejects an unsupported platform before installing requirements", () => {
    const setup = fixture({ platform: "FreeBSD", nodeMajor: null, missing: ["git"] });
    const result = setup.run("--requirements-only");
    expect(result.status).not.toBe(0);
    expect(setup.calls()).not.toMatch(/apt-get|curl|npm install|pnpm install|wizard/);
  });
});
