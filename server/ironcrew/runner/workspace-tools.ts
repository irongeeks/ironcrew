/** Small native tool allowlist. No shell, network, writes, or cross-project reads. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { redactValue } from "../security/redaction.ts";
import type {
  OpenRouterTool,
  OpenRouterToolCall,
  OpenRouterToolExecutor,
  OpenRouterToolAuthorization,
} from "../runtime/openrouter-tools.ts";
import type { RunContext } from "../runtime/run-events.ts";

const argsSchema = z.object({ path: z.string().max(4096).default(".") }).strict();
const MAX_READ = 256 * 1024;
const MAX_ENTRIES = 500;
const PRIVATE_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|credentials(?:\..*)?)$/i;

export class RunnerWorkspaceTools implements OpenRouterToolExecutor {
  // Text-only runs remain usable; listTools returns [] without a project.
  readonly workspaceRequired = false;
  constructor(private readonly auditPath: string) {
    if (!path.isAbsolute(auditPath)) throw new Error("Runner tool audit path must be absolute.");
  }
  async listTools(context: RunContext): Promise<OpenRouterTool[]> {
    try {
      this.resolve(".", context);
    } catch {
      return [];
    }
    const available: OpenRouterTool[] = [
      {
        name: "workspace_list",
        description: "Verzeichniseinträge im zugewiesenen Projekt lesen (maximal 500).",
        inputSchema: argsSchema,
      },
      {
        name: "workspace_read",
        description: "Eine UTF-8-Textdatei im zugewiesenen Projekt lesen (maximal 256 KiB).",
        inputSchema: argsSchema,
      },
    ];
    return available.filter((tool) => this.granted(tool.name, context));
  }
  private granted(name: string, context: RunContext): boolean {
    const grant = name === "workspace_read" ? "workspace.read" : name === "workspace_list" ? "workspace.list" : null;
    return grant !== null && context.allowedTools?.includes(grant) === true;
  }
  private resolve(relative: string, context: RunContext): string {
    if (
      !context.projectId ||
      !path.isAbsolute(context.workspacePath) ||
      path.isAbsolute(relative) ||
      relative.includes("\0")
    )
      throw new Error("Nur relative Pfade im zugewiesenen Projekt sind erlaubt.");
    const root = fs.realpathSync(context.workspacePath);
    if (root === path.parse(root).root) throw new Error("Filesystem-Wurzel ist kein Projekt.");
    const parts = relative.split(/[\\/]/).filter((part) => part && part !== ".");
    if (parts.some((part) => part === ".." || PRIVATE_COMPONENT.test(part)))
      throw new Error("Privater oder projektfremder Pfad ist gesperrt.");
    let target = root;
    for (const part of parts) {
      target = path.join(target, part);
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Symlinks werden von Runner-Tools nicht verfolgt.");
    }
    const real = fs.realpathSync(target);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error("Pfad verlässt den Projektordner.");
    return real;
  }
  async authorize(call: OpenRouterToolCall, context: RunContext): Promise<OpenRouterToolAuthorization> {
    if (!this.granted(call.name, context))
      return { status: "denied", reason: "Tool ist auf dem Runner nicht freigegeben." };
    try {
      this.resolve(argsSchema.parse(call.arguments).path, context);
      return { status: "allowed" };
    } catch {
      return { status: "denied", reason: "Pfad fehlt, ist privat oder liegt außerhalb des zugewiesenen Projekts." };
    }
  }
  async execute(call: OpenRouterToolCall, context: RunContext): Promise<unknown> {
    if ((await this.authorize(call, context)).status !== "allowed") throw new Error("Runner-Tool nicht erlaubt.");
    const relative = argsSchema.parse(call.arguments).path;
    const target = this.resolve(relative, context);
    if (context.signal?.aborted) throw new Error("Run abgebrochen.");
    if (call.name === "workspace_list") {
      const entries: Array<{ name: string; kind: string }> = [];
      const directory = fs.opendirSync(target);
      let truncated = false;
      try {
        for (;;) {
          const entry = directory.readSync();
          if (!entry) break;
          if (PRIVATE_COMPONENT.test(entry.name) || entry.isSymbolicLink()) continue;
          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          entries.push({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          });
        }
      } finally {
        directory.closeSync();
      }
      return { path: relative, entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated };
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      const current = fs.statSync(this.resolve(relative, context));
      if (!stat.isFile() || stat.size > MAX_READ || stat.dev !== current.dev || stat.ino !== current.ino)
        throw new Error("Datei ist zu groß, kein regulärer Text oder wurde während des Zugriffs geändert.");
      const data = Buffer.alloc(Math.min(stat.size + 1, MAX_READ + 1));
      const bytes = fs.readSync(fd, data, 0, data.length, 0);
      if (bytes > MAX_READ || data.subarray(0, bytes).includes(0)) throw new Error("Datei ist binär oder zu groß.");
      return { path: relative, text: data.subarray(0, bytes).toString("utf-8"), bytes };
    } finally {
      fs.closeSync(fd);
    }
  }
  async audit(
    stage: Parameters<OpenRouterToolExecutor["audit"]>[0],
    call: OpenRouterToolCall,
    context: RunContext,
    result?: unknown,
  ): Promise<void> {
    // Fail closed if durable evidence cannot be written. Never record full
    // file contents here; run events carry the appropriately redacted result.
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(
      this.auditPath,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const entry = redactValue(
        {
          timestamp: Date.now(),
          actor: context.agentId,
          companyId: context.companyId,
          projectId: context.projectId,
          taskId: context.taskId,
          runId: context.runId,
          correlationId: context.correlationId,
          stage,
          tool: call.name,
          callId: call.id,
          arguments: call.arguments,
          resultPresent: result !== undefined,
        },
        context.redactValues,
      );
      fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
