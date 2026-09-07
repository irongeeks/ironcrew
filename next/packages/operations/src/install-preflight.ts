import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkPrivateRuntime, preflightInstallation } from "./preflight.ts";
import { OperationError } from "./common.ts";
async function existingParent(input: string) {
  let cursor = path.resolve(input);
  while (true) {
    try {
      await access(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (let p = cursor; ; p = path.dirname(p)) {
    const stat = await lstat(p);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new OperationError("path", "Installationspfad benötigt reguläre Verzeichnisse.");
    if (p === path.dirname(p)) break;
  }
  return cursor;
}
export async function registrationPreflight(platform: string, program: string, data: string) {
  if (platform !== process.platform)
    throw new OperationError("platform", "Dienstbundle gehört zu einem anderen Betriebssystem.");
  await checkPrivateRuntime(process.execPath);
  return preflightInstallation({
    programParent: await existingParent(program),
    dataParent: await existingParent(data),
    requiredBytes: 0,
    checkPort: false,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5)
      throw new OperationError("arguments", "Erwartet Plattform, Programm- und Datenpfad.");
    console.info(JSON.stringify(await registrationPreflight(process.argv[2]!, process.argv[3]!, process.argv[4]!)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Installationsvorprüfung fehlgeschlagen");
    process.exitCode = 1;
  }
}
