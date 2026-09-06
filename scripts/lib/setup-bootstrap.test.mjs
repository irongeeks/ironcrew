import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(major, installedPnpm = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "ironcrew-bootstrap-"));
  fixtures.push(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(directory, "scripts"));
  copyFileSync(path.join(root, "scripts/setup.sh"), path.join(directory, "scripts/setup.sh"));
  writeFileSync(path.join(directory, "scripts/setup-wizard.mjs"), "");
  writeFileSync(path.join(directory, "package.json"), '{"packageManager":"pnpm@10.30.1+sha512.fixture"}');
  const command = (name, script) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
  };
  command("dirname", 'exec /usr/bin/dirname "$@"');
  command(
    "node",
    `case "$1" in
      -p) case "$2" in *packageManager*) printf 'pnpm@10.30.1';; *) printf '${major}';; esac;;
      -v) printf 'v${major}.0.0';;
      *) printf 'wizard\\n' >> "$BOOTSTRAP_LOG";;
    esac`,
  );
  const pnpmScript = '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$BOOTSTRAP_LOG"\n';
  command(
    "npm",
    `printf 'npm %s\\n' "$*" >> "$BOOTSTRAP_LOG"
     printf '%s' '${pnpmScript}' > "$BOOTSTRAP_BIN/pnpm"
     /bin/chmod +x "$BOOTSTRAP_BIN/pnpm"`,
  );
  if (installedPnpm) command("pnpm", 'printf "pnpm %s\\n" "$*" >> "$BOOTSTRAP_LOG"');
  const log = path.join(directory, "commands.log");
  writeFileSync(log, "");
  return {
    run: () =>
      spawnSync("/bin/bash", [path.join(directory, "scripts/setup.sh"), "--yes"], {
        encoding: "utf8",
        env: { PATH: bin, BOOTSTRAP_BIN: bin, BOOTSTRAP_LOG: log },
      }),
    calls: () => readFileSync(log, "utf8"),
  };
}

describe.skipIf(process.platform === "win32")("native setup bootstrap", () => {
  it.each([22, 24, 25])("rejects Node %s before installing dependencies or configuring the checkout", (major) => {
    const setup = fixture(major);
    const result = setup.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node.js 26+ is required");
    expect(setup.calls()).toBe("");
  });

  it("installs pinned pnpm through npm when Corepack is absent on Node 26", () => {
    const setup = fixture(26);
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toBe("npm install --global pnpm@10.30.1\npnpm install --frozen-lockfile\nwizard\n");
  });

  it("uses an existing pnpm installation without requiring Corepack", () => {
    const setup = fixture(26, true);
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(setup.calls()).toBe("pnpm install --frozen-lockfile\nwizard\n");
  });
});
