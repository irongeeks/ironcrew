import { realpath, stat, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

/** Exact attachment only: reject AppArmor glob, expansion and rule syntax. */
export function chromiumAppArmorProfile(executable: string) {
  if (
    !path.posix.isAbsolute(executable) ||
    !/^\/[A-Za-z0-9_./ -]+$/.test(executable) ||
    path.posix.normalize(executable) !== executable
  )
    throw new Error("Chromium AppArmor attachment must be one canonical literal absolute path");
  return `abi <abi/4.0>,\nprofile ironcrew-ci-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`;
}

export async function writeChromiumAppArmorProfile(destination: string) {
  if (process.platform !== "linux") throw new Error("Chromium CI AppArmor setup requires Linux");
  const executable = await realpath(chromium.executablePath());
  if (!(await stat(executable)).isFile()) throw new Error("Playwright Chromium must be a regular executable");
  await access(executable, constants.X_OK);
  await writeFile(destination, chromiumAppArmorProfile(executable), { flag: "wx", mode: 0o600 });
  return executable;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) throw new Error("Usage: ci-chromium-apparmor.ts PROFILE_PATH");
  process.stdout.write((await writeChromiumAppArmorProfile(destination)) + "\n");
}
