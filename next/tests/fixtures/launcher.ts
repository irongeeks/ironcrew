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
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Fixture-only PE: only the three child pipe ends may cross this process boundary.
class Launcher {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb;
    public IntPtr lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo; public IntPtr lpAttributeList;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);

  static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr handle) {
    if(handle != IntPtr.Zero && handle != new IntPtr(-1)) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
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
  static FileStream Transfer(ref IntPtr handle, FileAccess access) {
    var owned = new SafeFileHandle(handle, true); handle = IntPtr.Zero;
    try { return new FileStream(owned, access, 4096, false); }
    catch { owned.Dispose(); throw; }
  }
  static void CheckLayouts() {
    bool x64 = IntPtr.Size == 8;
    if(Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)) != (x64 ? 24 : 12) ||
       Marshal.SizeOf(typeof(STARTUPINFO)) != (x64 ? 104 : 68) ||
       Marshal.SizeOf(typeof(STARTUPINFOEX)) != (x64 ? 112 : 72) ||
       Marshal.SizeOf(typeof(PROCESS_INFORMATION)) != (x64 ? 24 : 16))
      throw new InvalidOperationException("Invalid Win32 structure layout");
  }
  static int Main(string[] args) {
    IntPtr childInput = IntPtr.Zero, parentInput = IntPtr.Zero;
    IntPtr parentOutput = IntPtr.Zero, childOutput = IntPtr.Zero;
    IntPtr parentError = IntPtr.Zero, childError = IntPtr.Zero;
    IntPtr list = IntPtr.Zero, handles = IntPtr.Zero;
    bool initialized = false, started = false, exited = false;
    var process = new PROCESS_INFORMATION();
    FileStream stdin = null, stdout = null, stderr = null;
    try {
      CheckLayouts();
      var attributes = new SECURITY_ATTRIBUTES();
      attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      attributes.bInheritHandle = 1;
      Check(CreatePipe(out childInput, out parentInput, ref attributes, 0));
      Check(CreatePipe(out parentOutput, out childOutput, ref attributes, 0));
      Check(CreatePipe(out parentError, out childError, ref attributes, 0));
      // Parent ends never enter the inherited child handle set.
      Check(SetHandleInformation(parentInput, 1, 0));
      Check(SetHandleInformation(parentOutput, 1, 0));
      Check(SetHandleInformation(parentError, 1, 0));
      UIntPtr size = UIntPtr.Zero;
      bool queried = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      int queryError = Marshal.GetLastWin32Error();
      if(queried || queryError != 122 || size.ToUInt64() == 0)
        throw new Win32Exception(queryError);
      list = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
      Check(InitializeProcThreadAttributeList(list, 1, 0, ref size));
      initialized = true;
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      Marshal.WriteIntPtr(handles, 0, childInput);
      Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput);
      Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, childError);
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST. Both the attribute buffer and handle array
      // remain alive until CreateProcess returns and the attribute list is deleted.
      Check(UpdateProcThreadAttribute(list, 0, new UIntPtr(0x00020002), handles,
        new UIntPtr((uint)(3 * IntPtr.Size)), IntPtr.Zero, IntPtr.Zero));
      var startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
      startup.StartupInfo.hStdInput = childInput;
      startup.StartupInfo.hStdOutput = childOutput;
      startup.StartupInfo.hStdError = childError;
      startup.lpAttributeList = list;
      string node = ${csharpString(process.execPath)};
      var command = new StringBuilder(Quote(node));
      command.Append(" ").Append(Quote(Assembly.GetExecutingAssembly().Location + ".mjs"));
      foreach(string argument in args) command.Append(" ").Append(Quote(argument));
      // Explicit application path; inherited environment/cwd; no shell. TRUE is
      // required by the handle-list contract, while the list bounds inheritance.
      Check(CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true,
        0x00080000, IntPtr.Zero, null, ref startup, out process));
      started = true;
      DeleteProcThreadAttributeList(list); initialized = false;
      Marshal.FreeHGlobal(list); list = IntPtr.Zero;
      Marshal.FreeHGlobal(handles); handles = IntPtr.Zero;
      Close(ref childInput); Close(ref childOutput); Close(ref childError);
      Close(ref process.hThread);
      stdin = Transfer(ref parentInput, FileAccess.Write);
      stdout = Transfer(ref parentOutput, FileAccess.Read);
      stderr = Transfer(ref parentError, FileAccess.Read);
      // Anonymous pipes are synchronous handles. Copies run independently so binary
      // output on one pipe cannot block draining the other; there are no text writers.
      Task output = stdout.CopyToAsync(Console.OpenStandardOutput());
      Task error = stderr.CopyToAsync(Console.OpenStandardError());
      FileStream input = stdin;
      Task.Run(async () => {
        try { await Console.OpenStandardInput().CopyToAsync(input); }
        catch(IOException) { } catch(ObjectDisposedException) { }
        finally { input.Dispose(); }
      });
      uint wait = WaitForSingleObject(process.hProcess, 0xffffffff);
      if(wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      exited = true;
      uint exitCode; Check(GetExitCodeProcess(process.hProcess, out exitCode));
      Task.WaitAll(output, error);
      return unchecked((int)exitCode);
    } catch(Exception error) {
      Console.Error.WriteLine("Fixture launcher failed: " + error.GetType().Name);
      return 125;
    } finally {
      if(started && !exited) {
        // Only the child process created by this invocation can be terminated here.
        TerminateProcess(process.hProcess, 125); WaitForSingleObject(process.hProcess, 5000);
      }
      // A still-open console stdin must not hold the exited broker wrapper open.
      if(stdin != null) stdin.Dispose();
      if(stdout != null) stdout.Dispose();
      if(stderr != null) stderr.Dispose();
      Close(ref childInput); Close(ref parentInput);
      Close(ref childOutput); Close(ref parentOutput);
      Close(ref childError); Close(ref parentError);
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      Close(ref process.hThread); Close(ref process.hProcess);
    }
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
