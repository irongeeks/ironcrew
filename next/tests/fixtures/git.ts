import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Resolve the real installed Git binary; never execute a shell shim. */
export async function fixtureGitExecutable(): Promise<string> {
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {
      // Continue searching the host's configured executable directories.
    }
  }
  throw new Error("The real Git executable is required for the Git integration fixtures");
}
