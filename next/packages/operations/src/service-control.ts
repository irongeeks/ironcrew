import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { WINSW_SHA256 } from "./services.ts";
import { OperationError, hashFile } from "./common.ts";
const executable = z.string().refine(path.isAbsolute),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$/);
export const serviceControlSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("systemd"),
      executable,
      executableSha256: digest,
      name: name.refine((n) => n.endsWith(".service")),
    })
    .strict(),
  z
    .object({
      kind: z.literal("launchd"),
      executable,
      executableSha256: digest,
      name,
      plistPath: executable,
      domain: z
        .string()
        .regex(/^(system|gui\/[0-9]+|user\/[0-9]+)$/)
        .default("system"),
      configurationSha256: digest,
    })
    .strict(),
  z
    .object({
      kind: z.literal("winsw"),
      executable,
      executableSha256: digest,
      name,
      configurationPath: executable,
      configurationSha256: digest,
    })
    .strict(),
  z.object({ kind: z.literal("ironcrew-service-v1"), executable, executableSha256: digest, name }).strict(),
]);
export type ServiceControlConfiguration = z.infer<typeof serviceControlSchema>;
/** Wait only; never signal/kill another process. PID reuse or access ambiguity stays conservative. */
export async function waitForStoppedProcess(pid: number, timeoutMs = 45000) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new OperationError("service_effect_unknown", "Dienstprozess-ID ist ungültig.");
  const until = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    if (Date.now() >= until)
      throw new OperationError(
        "service_effect_unknown",
        "Dienstprozess hat den begrenzten Stoppzeitraum überschritten.",
      );
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, until - Date.now()))));
  }
}
export class NativeServiceControl {
  readonly config: ServiceControlConfiguration;
  readonly installDirectory: string;
  readonly dataDirectory: string;
  constructor(config: ServiceControlConfiguration, installDirectory: string, dataDirectory: string) {
    this.config = serviceControlSchema.parse(config);
    this.installDirectory = installDirectory;
    this.dataDirectory = dataDirectory;
  }
  async invoke(operation: "stop" | "start" | "status") {
    const c = this.config;
    if ((await hashFile(c.executable)) !== c.executableSha256)
      throw new OperationError("service_binary_changed", "Administrativer Dienstcontroller wurde verändert.");
    if (c.kind === "launchd" || c.kind === "winsw") {
      const file = c.kind === "launchd" ? c.plistPath : c.configurationPath;
      if ((await hashFile(file)) !== c.configurationSha256)
        throw new OperationError("service_definition_changed", "Dienstdefinition wurde verändert.");
    }
    if (c.kind === "winsw") {
      const expected = c.executable.replace(/\.exe$/i, ".xml");
      const xml = await readFile(c.configurationPath, "utf8");
      if (
        c.executableSha256 !== WINSW_SHA256 ||
        expected === c.executable ||
        expected.toLowerCase() !== c.configurationPath.toLowerCase() ||
        /<!DOCTYPE|<!ENTITY/i.test(xml) ||
        !xml.includes(`<id>${c.name}</id>`)
      )
        throw new OperationError(
          "winsw_configuration",
          "Gepinnter WinSW2.12-Wrapper benötigt seine eigene gleichnamige XML-Datei mit passender Dienst-ID.",
        );
    }
    let stoppedPid: number | undefined;
    if (c.kind === "launchd" && operation === "stop") {
      try {
        const { stdout } = await promisify(execFile)(c.executable, ["print", `${c.domain}/${c.name}`], {
          env: { PATH: path.dirname(c.executable), LANG: "C", TZ: "UTC" },
          timeout: 10000,
          maxBuffer: 64000,
        });
        const value = /\bpid = (\d+)/.exec(stdout)?.[1];
        if (value) stoppedPid = Number(value);
      } catch {
        throw new OperationError(
          "service_effect_unknown",
          "Dienstidentität vor Stopp ist nicht zuverlässig feststellbar.",
        );
      }
    }
    const args =
      c.kind === "systemd"
        ? [operation === "status" ? "is-active" : operation, "--", c.name]
        : c.kind === "launchd"
          ? operation === "stop"
            ? ["bootout", `${c.domain}/${c.name}`]
            : operation === "start"
              ? ["bootstrap", c.domain, c.plistPath]
              : ["print", `${c.domain}/${c.name}`]
          : c.kind === "winsw"
            ? ["/elevated", operation]
            : [
                "--service",
                c.name,
                "--operation",
                operation,
                "--program-dir",
                this.installDirectory,
                "--data-dir",
                this.dataDirectory,
              ];
    const result = await new Promise<{ stdout: string; code: number }>((resolve, reject) =>
      execFile(
        c.executable,
        args,
        {
          env: {
            PATH: path.dirname(c.executable),
            LANG: "C",
            TZ: "UTC",
            ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
          },
          timeout: 90000,
          maxBuffer: 64000,
        },
        (error, stdout) => {
          if (error && (error.killed || typeof error.code !== "number"))
            reject(
              new OperationError(
                "service_effect_unknown",
                "Dienstwechsel wurde unterbrochen; Prozesszustand abgleichen.",
              ),
            );
          else resolve({ stdout, code: error ? Number(error.code) : 0 });
        },
      ),
    );
    if (result.code !== 0)
      throw new OperationError("service_effect_unknown", "Dienstcontroller bestätigt keinen erfolgreichen Wechsel.");
    if (c.kind === "winsw" && operation === "status" && result.stdout.trim() !== "Started")
      throw new OperationError("service_effect_unknown", "WinSW meldet keinen gestarteten Dienst.");
    if (c.kind === "launchd" && operation === "status" && !/state = running/.test(result.stdout))
      throw new OperationError("service_effect_unknown", "launchd meldet keinen laufenden Dienst.");
    if (c.kind === "ironcrew-service-v1") {
      const parsed = z
        .object({ serviceName: z.literal(c.name), state: z.enum(["running", "stopped"]) })
        .passthrough()
        .safeParse(JSON.parse(result.stdout));
      if (!parsed.success || parsed.data.state !== (operation === "stop" ? "stopped" : "running"))
        throw new OperationError("service_effect_unknown", "Dienstbroker bestätigt nicht den geforderten Zustand.");
    }
    if (stoppedPid !== undefined) await waitForStoppedProcess(stoppedPid);
    return { operation, confirmed: true as const };
  }
}
