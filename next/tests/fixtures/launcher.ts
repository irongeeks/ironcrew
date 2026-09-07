import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const exec = promisify(execFile);
let windowsLauncher: Promise<Buffer> | undefined;
const csharpString = (value: string) => '@"' + value.replaceAll('"', '""') + '"';

/** A fixture-only PE: the Node executable is compiled in, the script is its own adjacent .mjs. */
async function buildWindowsLauncher() {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-fixture-compiler-"));
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows fixture needs an absolute SystemRoot");
    const candidates = ["Framework64", "Framework"].map((folder) =>
      path.join(systemRoot, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"),
    );
    let compiler: string | undefined;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.F_OK);
        compiler = candidate;
        break;
      } catch {
        /* Try the other installed architecture. */
      }
    }
    if (!compiler) throw new Error("Windows fixture requires the installed .NET Framework C# compiler");
    const source = path.join(directory, "Launcher.cs"),
      executable = path.join(directory, "launcher.exe");
    await writeFile(
      source,
      `using System;
using System.Diagnostics;
using System.Reflection;
using System.Text;
class Launcher {
  // Windows argv quoting: double backslashes preceding a quote or closing delimiter.
  static string Quote(string value) {
    var result = new StringBuilder(); result.Append('"'); int slashes = 0;
    foreach(char character in value) {
      if(character == '\\\\') { slashes++; continue; }
      if(character == '"') { result.Append('\\\\', slashes * 2 + 1); result.Append(character); }
      else { result.Append('\\\\', slashes); result.Append(character); }
      slashes = 0;
    }
    result.Append('\\\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static int Main(string[] args) {
    try {
      var arguments = new StringBuilder(Quote(Assembly.GetExecutingAssembly().Location + ".mjs"));
      foreach(string argument in args) arguments.Append(" ").Append(Quote(argument));
      var start = new ProcessStartInfo(${csharpString(process.execPath)}, arguments.ToString());
      start.UseShellExecute = false;
      using(var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
    } catch(Exception) { Console.Error.WriteLine("Fixture launcher failed"); return 125; }
  }
}
`,
    );
    await exec(compiler, ["/nologo", "/target:exe", "/optimize+", "/out:" + executable, source], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
    });
    const bytes = await readFile(executable);
    if (bytes.subarray(0, 2).toString() !== "MZ") throw new Error("Fixture compiler did not produce a PE executable");
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createFixtureLauncher(directory: string, name: string, source: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !path.isAbsolute(directory))
    throw new Error("Invalid fixture launcher location");
  const executable = path.join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const script = executable + ".mjs";
  await writeFile(script, source.replace(/^#![^\n]*\n/, ""), { flag: "wx", mode: 0o600 });
  if (process.platform === "win32") {
    windowsLauncher ??= buildWindowsLauncher();
    await writeFile(executable, await windowsLauncher, { flag: "wx", mode: 0o700 });
  } else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, {
      flag: "wx",
      mode: 0o700,
    });
  }
  return executable;
}
