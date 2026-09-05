/** Official CLI help/status probes only. No credential files or login flows.
 * Protocol references: docs/CLI_RUNTIME_ACCEPTANCE.md.
 */
import { execFile } from "node:child_process";
import { buildCliSpawnEnv } from "./process-env.ts";

export interface ProbeResult {
  code: number | null;
  text: string;
}
export type ProbeCommand = readonly [string, ...string[]];
export function probeCommand(command: ProbeCommand, args: string[], timeout = 5_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      command[0],
      [...command.slice(1), ...args],
      {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: buildCliSpawnEnv(process.env),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // Returned text remains in memory only. Callers whitelist booleans;
        // neither an exec error (which embeds stdout) nor raw auth text is logged.
        const code = error ? (typeof error.code === "number" && !error.killed ? error.code : null) : 0;
        resolve({ code, text: `${stdout}\n${stderr}` });
      },
    );
  });
}
export function helpHas(help: string, option: string): boolean {
  return new RegExp(`(?:^|[\\s,|])${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,=|<\\[]|$)`, "m").test(help);
}
export interface CliProbe {
  installed: boolean;
  version?: string;
  help: string;
  execHelp: string;
  resumeHelp: string;
  streaming: boolean;
  resume: boolean;
  authArgs: string[] | null;
}
export async function inspectCli(provider: string, command: ProbeCommand, timeout: number): Promise<CliProbe> {
  const [version, root] = await Promise.all([
    probeCommand(command, ["--version"], timeout),
    probeCommand(command, ["--help"], timeout),
  ]);
  const result: CliProbe = {
    installed: version.code === 0,
    version: undefined,
    help: root.code === 0 ? root.text : "",
    execHelp: "",
    resumeHelp: "",
    streaming: false,
    resume: false,
    authArgs: null,
  };
  // Keep just the version number, never arbitrary process output.
  result.version = version.code === 0 ? version.text.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] : undefined;
  if (!result.installed || root.code !== 0) return result;
  if (provider === "codex") {
    if (helpHas(result.help, "exec")) {
      const exec = await probeCommand(command, ["exec", "--help"], timeout);
      result.execHelp = exec.code === 0 ? exec.text : "";
      result.streaming = helpHas(result.execHelp, "--json");
      if (helpHas(result.execHelp, "resume")) {
        const resume = await probeCommand(command, ["exec", "resume", "--help"], timeout);
        result.resumeHelp = resume.code === 0 ? resume.text : "";
        result.resume = helpHas(result.resumeHelp, "--json") && /SESSION_ID/.test(result.resumeHelp);
      }
    }
    if (helpHas(result.help, "login")) {
      const login = await probeCommand(command, ["login", "--help"], timeout);
      if (login.code === 0 && helpHas(login.text, "status")) result.authArgs = ["login", "status"];
    }
  } else {
    result.streaming = helpHas(result.help, "--output-format") && /stream-json/.test(result.help);
    result.resume =
      result.streaming && helpHas(result.help, provider === "antigravity" ? "--conversation" : "--resume");
    if (provider === "claude" && helpHas(result.help, "auth")) {
      const auth = await probeCommand(command, ["auth", "--help"], timeout);
      if (auth.code === 0 && helpHas(auth.text, "status")) result.authArgs = ["auth", "status"];
    }
    // agy/gemini: never infer login from a model catalogue or successful help.
    // Until an official non-interactive status contract is supported, unknown.
  }
  return result;
}
