import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { ActionRequest } from "../../domain/workflows/actions.ts";
import type { Scope } from "../../contracts/src/index.ts";
import type { GitActionPort } from "./git.ts";
import { IntegrationError } from "./transport.ts";
export interface ServiceTarget {
  id: string;
  scope: Scope;
  kind: "systemd" | "docker" | "windows";
  resourceName: string;
  executable: string;
}
export type BrokerRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; exitCode: number }>;
const defaultRunner: BrokerRunner = (executable, args, options) =>
  new Promise((resolve, reject) =>
    execFile(executable, args, options, (error, stdout) => {
      if (error && (error.killed || typeof error.code !== "number"))
        reject(
          new IntegrationError(
            "transport",
            "Dienstbroker konnte die Aktion nicht abschließend prüfen.",
            "effect_unknown",
          ),
        );
      else resolve({ stdout, exitCode: error ? Number(error.code) : 0 });
    }),
  );
export const serviceBrokerCapabilities = [
  { id: "linux.service.status", effect: "read" },
  { id: "linux.service.restart", effect: "external_change" },
  { id: "docker.container.status", effect: "read" },
  { id: "docker.container.restart", effect: "external_change" },
  { id: "windows.service.status", effect: "read" },
  { id: "windows.service.restart", effect: "external_change" },
] as const;
/** A native broker can possess OS rights, but offers exactly two verbs against a fixed administrative target. */
export class ServiceBroker {
  private readonly target: ServiceTarget;
  private readonly actions: GitActionPort;
  private readonly run: BrokerRunner;
  constructor(target: ServiceTarget, actions: GitActionPort, run: BrokerRunner = defaultRunner) {
    if (!path.isAbsolute(target.executable) || !z.uuid().safeParse(target.id).success)
      throw new IntegrationError(
        "configuration",
        "Dienstbroker benötigt ein explizites Ziel und absoluten Programmpfad.",
      );
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.@ -]{0,200}$/.test(target.resourceName) ||
      (target.kind === "systemd" && !target.resourceName.endsWith(".service")) ||
      (target.kind === "docker" && target.resourceName.includes(" "))
    )
      throw new IntegrationError("configuration", "Ungültiger Dienst- oder Containername.");
    this.target = structuredClone(target);
    this.actions = actions;
    this.run = run;
  }
  async execute(
    request: Omit<ActionRequest, "scope" | "targetId" | "toolId" | "effect" | "args">,
    operation: "status" | "restart",
  ) {
    if (operation !== "status" && operation !== "restart")
      throw new IntegrationError("validation", "Dienstbroker unterstützt nur Status und Neustart.");
    const write = operation === "restart";
    const prefix =
      this.target.kind === "systemd"
        ? "linux.service"
        : this.target.kind === "docker"
          ? "docker.container"
          : "windows.service";
    return this.actions.perform(
      {
        ...request,
        scope: this.target.scope,
        targetId: this.target.id,
        toolId: `${prefix}.${operation}`,
        effect: write ? "external_change" : "read",
        args: { resourceName: this.target.resourceName },
      },
      async () => {
        let args: string[];
        if (this.target.kind === "systemd")
          args = write
            ? ["restart", "--", this.target.resourceName]
            : ["show", "--property=LoadState,ActiveState,SubState", "--", this.target.resourceName];
        else if (this.target.kind === "docker")
          args = write
            ? ["container", "restart", "--time", "30", this.target.resourceName]
            : ["container", "inspect", "--format", "{{json .State}}", this.target.resourceName];
        else {
          // Resource name is administrative and restricted above; no user-controlled PowerShell code or shell interpolation.
          const script = write
            ? `$ErrorActionPreference='Stop'; Restart-Service -Name '${this.target.resourceName}' -ErrorAction Stop`
            : `$ErrorActionPreference='Stop'; $service=Get-Service -Name '${this.target.resourceName}' -ErrorAction Stop; @{Name=$service.Name; Status=$service.Status.ToString()} | ConvertTo-Json -Compress`;
          args = [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ];
        }
        let result: { stdout: string; exitCode: number };
        try {
          result = await this.run(this.target.executable, args, {
            env: {
              PATH: path.dirname(this.target.executable),
              ...(process.platform === "win32"
                ? { SYSTEMROOT: process.env.SYSTEMROOT, SystemRoot: process.env.SystemRoot }
                : {}),
            },
            timeout: write ? 60000 : 30000,
            maxBuffer: 64 * 1024,
          });
        } catch {
          throw new IntegrationError(
            "transport",
            "Dienstbroker-Verbindung oder Prozess wurde unterbrochen.",
            write ? "effect_unknown" : "failed",
          );
        }
        if (result.exitCode !== 0)
          throw new IntegrationError(
            "provider",
            "Dienstbroker meldet einen fehlgeschlagenen Befehl.",
            write ? "effect_unknown" : "failed",
          );
        if (write)
          return {
            observedAt: new Date().toISOString(),
            effectStatus: "accepted",
            resourceName: this.target.resourceName,
            requiresFunctionalCheck: true,
            evidenceRefs: [],
          };
        let status: string;
        let details: unknown;
        try {
          if (this.target.kind === "systemd") {
            const state = Object.fromEntries(
              result.stdout
                .trim()
                .split("\n")
                .map((line) => line.split("=")),
            );
            const parsed = z
              .object({ LoadState: z.string().min(1), ActiveState: z.string().min(1), SubState: z.string().min(1) })
              .parse(state);
            status = parsed.ActiveState;
            details = parsed;
          } else if (this.target.kind === "docker") {
            const parsed = z
              .object({ Status: z.string().min(1), Running: z.boolean(), ExitCode: z.number().int() })
              .parse(JSON.parse(result.stdout));
            status = parsed.Status;
            details = parsed;
          } else {
            const parsed = z
              .object({ Name: z.string().min(1), Status: z.string().min(1) })
              .parse(JSON.parse(result.stdout));
            if (parsed.Name.toLowerCase() !== this.target.resourceName.toLowerCase()) throw new Error("target");
            status = parsed.Status;
            details = parsed;
          }
        } catch {
          throw new IntegrationError("provider", "Dienststatus besitzt kein gültiges Brokerformat.");
        }
        return {
          observedAt: new Date().toISOString(),
          effectStatus: "succeeded",
          resourceName: this.target.resourceName,
          status,
          details,
          evidenceRefs: [],
        };
      },
    );
  }
}
