import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fixtureGitExecutable } from "./git.ts";

/** Keep installer grammar checks real on Windows by using Git for Windows' installed POSIX shell. */
export async function fixtureShellExecutable(): Promise<string> {
  if (process.platform !== "win32") return realpath("/bin/sh");
  let directory = path.dirname(await fixtureGitExecutable());
  for (let depth = 0; depth < 4; depth++) {
    for (const relative of ["sh.exe", "bin/sh.exe", "usr/bin/sh.exe"]) {
      const candidate = path.join(directory, relative);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return realpath(candidate);
      } catch {
        /* Try the adjacent Git for Windows shell directory. */
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("The installed Git for Windows POSIX shell is required for installer grammar checks");
}
