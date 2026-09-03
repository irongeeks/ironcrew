import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SshConfig, FileEntry, FileStat, SshExecResult } from "./types.ts";
import { validateCommand, sanitizePath } from "./command-allowlist.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_READ_SIZE = 1_048_576;
const MAX_WRITE_SIZE = 5_242_880;

function ensureControlDir(): string {
  const dir = join(homedir(), ".ssh", "controlmasters");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* exists */
  }
  return dir;
}

function buildSshArgs(config: SshConfig, command?: string): string[] {
  const controlDir = ensureControlDir();
  const args = [
    "-o",
    `StrictHostKeyChecking=${config.known_hosts_policy === "strict" ? "yes" : "no"}`,
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlDir}/octooffice-%h-%p-%r`,
    "-o",
    "ControlPersist=300",
    "-p",
    String(config.port),
    "-i",
    config.private_key_path,
    `${config.user}@${config.host}`,
  ];
  if (command) args.push(command);
  return args;
}

function spawnSsh(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function spawnSftp(config: SshConfig, batchCommands: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<SshExecResult> {
  const controlDir = ensureControlDir();
  return new Promise((resolve, reject) => {
    const args = [
      "-o",
      `StrictHostKeyChecking=${config.known_hosts_policy === "strict" ? "yes" : "no"}`,
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlDir}/octooffice-%h-%p-%r`,
      "-o",
      "ControlPersist=300",
      "-P",
      String(config.port),
      "-i",
      config.private_key_path,
      "-b",
      "-",
      `${config.user}@${config.host}`,
    ];
    const proc = spawn("sftp", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("SFTP timed out"));
    }, timeoutMs);
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(batchCommands.join("\n") + "\n");
    proc.stdin.end();
  });
}

function parseLsOutput(raw: string, basePath: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("total")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 8) continue;
    const permissions = parts[0];
    const size = parseInt(parts[4], 10) || 0;
    const dateStr = `${parts[5]} ${parts[6]}`;
    const name = parts.slice(7).join(" ");
    if (name === "." || name === "..") continue;
    let type: "file" | "directory" | "symlink" = "file";
    if (permissions.startsWith("d")) type = "directory";
    else if (permissions.startsWith("l")) type = "symlink";
    entries.push({
      name,
      path: basePath.endsWith("/") ? basePath + name : basePath + "/" + name,
      type,
      size,
      modified: dateStr,
      permissions,
    });
  }
  return entries;
}

export interface SshConnectorInterface {
  testConnection(): Promise<boolean>;
  exec(command: string): Promise<SshExecResult>;
  listDirectory(path: string): Promise<FileEntry[]>;
  createDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
}

export function createSshConnector(config: SshConfig): SshConnectorInterface {
  const extraAllowed = config.allowed_commands ?? [];
  return {
    async testConnection() {
      try {
        const r = await spawnSsh(buildSshArgs(config, "echo ok"), 5000);
        return r.exitCode === 0;
      } catch {
        return false;
      }
    },
    async exec(command) {
      const v = validateCommand(command, extraAllowed);
      if (!v.allowed) throw new Error(`Command not allowed: ${v.reason}`);
      return spawnSsh(buildSshArgs(config, command));
    },
    async listDirectory(path) {
      const safePath = sanitizePath(path);
      const r = await spawnSsh(buildSshArgs(config, `ls -la ${safePath}`));
      if (r.exitCode !== 0) throw new Error(`Failed to list directory: ${r.stderr}`);
      return parseLsOutput(r.stdout, path);
    },
    async createDirectory(path) {
      const safePath = sanitizePath(path);
      const r = await spawnSsh(buildSshArgs(config, `mkdir -p ${safePath}`));
      if (r.exitCode !== 0) throw new Error(`Failed to create directory: ${r.stderr}`);
    },
    async readFile(path) {
      const safePath = sanitizePath(path);
      const sizeR = await spawnSsh(buildSshArgs(config, `stat --format=%s ${safePath}`));
      const size = parseInt(sizeR.stdout.trim(), 10);
      if (size > MAX_READ_SIZE) throw new Error(`File too large (${size} bytes, max ${MAX_READ_SIZE})`);
      const r = await spawnSsh(buildSshArgs(config, `cat ${safePath}`));
      if (r.exitCode !== 0) throw new Error(`Failed to read file: ${r.stderr}`);
      return r.stdout;
    },
    async writeFile(path, content) {
      if (content.length > MAX_WRITE_SIZE)
        throw new Error(`Content too large (${content.length} bytes, max ${MAX_WRITE_SIZE})`);
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: pathJoin } = await import("node:path");
      const tmpFile = pathJoin(tmpdir(), `octooffice-ssh-write-${Date.now()}`);
      try {
        writeFileSync(tmpFile, content, "utf-8");
        const safePath = sanitizePath(path);
        const r = await spawnSftp(config, [`put ${tmpFile} ${safePath}`]);
        if (r.exitCode !== 0) throw new Error(`Failed to write file: ${r.stderr}`);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* best-effort */
        }
      }
    },
    async deleteFile(path) {
      const safePath = sanitizePath(path);
      const r = await spawnSsh(buildSshArgs(config, `rm -f ${safePath}`));
      if (r.exitCode !== 0) throw new Error(`Failed to delete: ${r.stderr}`);
    },
    async stat(path) {
      const safePath = sanitizePath(path);
      const r = await spawnSsh(buildSshArgs(config, `stat --format='%F|%s|%Y|%A|%U|%G' ${safePath}`));
      if (r.exitCode !== 0) throw new Error(`Failed to stat: ${r.stderr}`);
      const parts = r.stdout.trim().split("|");
      const rawType = parts[0] || "";
      let type: "file" | "directory" | "symlink" = "file";
      if (rawType.includes("directory")) type = "directory";
      else if (rawType.includes("link")) type = "symlink";
      return {
        type,
        size: parseInt(parts[1], 10) || 0,
        modified: new Date(parseInt(parts[2], 10) * 1000).toISOString(),
        permissions: parts[3] || "",
        owner: parts[4] || "",
        group: parts[5] || "",
      };
    },
    async uploadFile(localPath, remotePath) {
      const safeRemote = sanitizePath(remotePath);
      const safeLocal = sanitizePath(localPath);
      const r = await spawnSftp(config, [`put ${safeLocal} ${safeRemote}`]);
      if (r.exitCode !== 0) throw new Error(`Upload failed: ${r.stderr}`);
    },
    async downloadFile(remotePath, localPath) {
      const safeRemote = sanitizePath(remotePath);
      const safeLocal = sanitizePath(localPath);
      const r = await spawnSftp(config, [`get ${safeRemote} ${safeLocal}`]);
      if (r.exitCode !== 0) throw new Error(`Download failed: ${r.stderr}`);
    },
  };
}
