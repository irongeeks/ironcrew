import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, realpath, rename, rm, open, readdir, opendir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  isVerifiedExecutionPort,
  type ExecutionPort,
  type ExecutionResult,
  type ExecutionContext,
} from "./isolation/index.ts";

export const digest = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export class ToolError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const patchSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().max(1_000_000),
        expectedSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    )
    .min(1)
    .max(32),
});
export type Patch = z.infer<typeof patchSchema>;
export const listSchema = z
  .object({
    path: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export type Evidence = {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string[];
  testedHashes: Record<string, string>;
};
/** No shell, inherited credentials, or unrestricted process execution. Arbitrary builds require OS isolation. */
export class Workspace {
  root: string;
  private readonly executionPort?: ExecutionPort;
  constructor(root: string, options?: { executionPort?: ExecutionPort }) {
    this.root = path.resolve(root);
    this.executionPort = options?.executionPort;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new ToolError("unsafe_workspace");
    this.root = await realpath(this.root);
  }
  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (
      !relative ||
      relative.includes("\\") ||
      relative.includes(":") ||
      relative.includes("\0") ||
      path.isAbsolute(relative)
    )
      throw new ToolError("path_denied");
    const segments = relative.split("/");
    if (
      segments.some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /^(\.env(?:\..*)?|\.git|\.ssh|\.ironcrew|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s) ||
          /[. ]$/.test(s),
      )
    )
      throw new ToolError("path_denied");
    const root = await realpath(this.root);
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1))
          throw new ToolError("path_denied");
      } catch (error) {
        if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    if (!current.startsWith(root + path.sep)) throw new ToolError("path_denied");
    return current;
  }
  async list(input: unknown = {}) {
    const parsed = listSchema.parse(input);
    if ((await lstat(this.root)).isSymbolicLink()) throw new ToolError("unsafe_workspace");
    const directory = parsed.path === undefined ? this.root : await this.resolve(parsed.path);
    if (!(await lstat(directory)).isDirectory()) throw new ToolError("directory_required");
    const entries: { path: string; type: "directory" | "file"; bytes: number }[] = [];
    let scanned = 0;
    for await (const entry of await opendir(directory)) {
      if (++scanned > 10000) throw new ToolError("workspace_limit_exceeded");
      const relative = parsed.path === undefined ? entry.name : `${parsed.path}/${entry.name}`;
      try {
        const file = await this.resolve(relative);
        const stat = await lstat(file);
        entries.push({
          path: relative,
          type: stat.isDirectory() ? "directory" : "file",
          bytes: stat.isFile() ? stat.size : 0,
        });
      } catch (error) {
        if (error instanceof ToolError && error.code === "path_denied") continue;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      path: parsed.path ?? "",
      entries: entries.slice(0, parsed.limit),
      truncated: entries.length > parsed.limit,
    };
  }
  async read(relative: string): Promise<{ content: string; sha256: string }> {
    const file = await this.resolve(relative);
    if ((await lstat(file)).size > 1_000_000) throw new ToolError("file_too_large");
    const content = await readFile(file, "utf8");
    return { content, sha256: digest(content) };
  }
  async applyPatch(input: unknown) {
    const { files } = patchSchema.parse(input);
    if (new Set(files.map((f) => f.path.toLowerCase())).size !== files.length) throw new ToolError("duplicate_path");
    const prepared: { target: string; content: string; before: string | null; relative: string }[] = [];
    for (const f of files) {
      const target = await this.resolve(f.path, true);
      let before: string | null = null;
      try {
        before = (await this.read(f.path)).content;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if ((before === null ? null : digest(before)) !== f.expectedSha256) throw new ToolError("file_conflict");
      prepared.push({ target, content: f.content, before, relative: f.path });
    }
    const changed: typeof prepared = [];
    try {
      for (const f of prepared) {
        await mkdir(path.dirname(f.target), { recursive: true, mode: 0o700 });
        await this.resolve(f.relative, true);
        const temporary = f.target + ".ironcrew-staging";
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(f.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, f.target);
        changed.push(f);
      }
    } catch (error) {
      for (const f of changed.reverse()) {
        if (f.before === null) await rm(f.target);
        else await writeFile(f.target, f.before, { mode: 0o600 });
      }
      throw error;
    }
    return {
      files: prepared.map((f) => ({
        path: f.relative,
        sha256: digest(f.content),
        bytes: Buffer.byteLength(f.content),
      })),
    };
  }
  async snapshotHashes(): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    let bytes = 0,
      count = 0;
    const visit = async (relative: string) => {
      for (const name of await readdir(relative ? await this.resolve(relative) : this.root)) {
        const item = relative ? relative + "/" + name : name;
        const file = await this.resolve(item);
        const stat = await lstat(file);
        if (stat.isDirectory()) await visit(item);
        else {
          bytes += stat.size;
          if (++count > 10000 || bytes > 32_000_000) throw new ToolError("workspace_limit_exceeded");
          hashes[item] = digest(await readFile(file));
        }
      }
    };
    await visit("");
    return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  async testFixture(relative: string, allowedHash: string, timeoutMs = 10_000): Promise<Evidence> {
    const file = await this.resolve(relative);
    const content = await this.read(relative);
    if (content.sha256 !== allowedHash) throw new ToolError("fixture_not_trusted");
    // Only an administrator-registered immutable fixture may use this interim runner.
    const args = ["--permission", "--allow-fs-read=" + this.root, file];
    const before = await this.snapshotHashes();
    const result = await boundedProcess(process.execPath, args, this.root, timeoutMs);
    const after = await this.snapshotHashes();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new ToolError("workspace_changed_during_test");
    return { ...result, command: ["node", ...args], testedHashes: before };
  }
  async execute(input: unknown, context?: ExecutionContext, signal?: AbortSignal): Promise<ExecutionResult> {
    if (!isVerifiedExecutionPort(this.executionPort)) throw new ToolError("isolation_profile_unverified");
    const parsed = z
      .object({
        argv: z.array(z.string().max(65536)).min(1).max(128),
        timeoutMs: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        outputPaths: z.array(z.string()).min(1).max(64).optional(),
      })
      .strict()
      .parse(input);
    return this.executionPort.execute({ ...parsed, workspaceRoot: this.root, context, signal });
  }
}

export async function boundedProcess(executable: string, argv: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { PATH: path.dirname(process.execPath), LANG: "C.UTF-8", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0,
      killed = false;
    const timer = setTimeout(
      () => {
        killed = true;
        child.kill("SIGKILL");
      },
      Math.min(timeoutMs, 60_000),
    );
    const append = (channel: "stdout" | "stderr", buffer: Buffer) => {
      size += buffer.length;
      if (size > 1_000_000) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      if (channel === "stdout") stdout += buffer.toString();
      else stderr += buffer.toString();
    };
    child.stdout.on("data", (b) => append("stdout", b));
    child.stderr.on("data", (b) => append("stderr", b));
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ToolError("process_start_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killed) reject(new ToolError("process_limit_exceeded"));
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
