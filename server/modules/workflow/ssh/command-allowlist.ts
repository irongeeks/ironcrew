// server/modules/workflow/ssh/command-allowlist.ts

const DEFAULT_ALLOWED_COMMANDS = [
  "mkdir",
  "ls",
  "cat",
  "cp",
  "mv",
  "rm",
  "find",
  "git",
  "df",
  "du",
  "head",
  "tail",
  "wc",
  "stat",
  "readlink",
] as const;

const BLOCKED_COMMANDS = new Set([
  "sudo",
  "curl",
  "wget",
  "bash",
  "sh",
  "zsh",
  "fish",
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "env",
  "xargs",
  "exec",
  "chmod",
  "chown",
  "chroot",
  "nohup",
]);

const SHELL_METACHAR_PATTERN = /[;|&`$()<>\n]/;

const FIND_DANGEROUS_FLAGS = new Set(["-exec", "-execdir", "-delete"]);

export interface CommandValidation {
  allowed: boolean;
  reason?: string;
  argv?: string[];
}

export function parseCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) argv.push(current);
  return argv;
}

export function validateCommand(command: string, extraAllowed: string[] = []): CommandValidation {
  // Step 1: Parse into argv first (needed for early find flag check)
  // Strip trailing `;` tokens used as find -exec terminators before metachar check
  const rawArgv = parseCommandArgv(command.replace(/\s*;\s*$/, ""));
  if (rawArgv.length === 0) {
    return { allowed: false, reason: "Empty command" };
  }

  const cmd = rawArgv[0];

  // Step 2: find-specific flag checks — before metachar check because find -exec uses `;`
  if (cmd === "find") {
    for (const arg of rawArgv.slice(1)) {
      if (FIND_DANGEROUS_FLAGS.has(arg)) {
        return { allowed: false, reason: `find flag "${arg}" is not allowed` };
      }
    }
  }

  // Step 3: Check for shell metacharacters in the raw command
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return { allowed: false, reason: "Command contains shell metacharacter" };
  }

  // At this point argv equals rawArgv (no trailing semicolons to worry about)
  const argv = rawArgv;

  // Step 4: Check blocked list first
  if (BLOCKED_COMMANDS.has(cmd)) {
    return { allowed: false, reason: `Command "${cmd}" is blocked` };
  }

  // Step 5: Check allowed list
  const allowed = new Set<string>([...DEFAULT_ALLOWED_COMMANDS, ...extraAllowed]);
  if (!allowed.has(cmd)) {
    return { allowed: false, reason: `Command "${cmd}" is not in allowlist` };
  }

  // Step 5b: rm safety checks
  if (cmd === "rm") {
    const pathArgs = argv.slice(1).filter((a) => !a.startsWith("-"));
    const hasRecursive = argv.some((a) => a.includes("r") && a.startsWith("-"));
    for (const p of pathArgs) {
      if (p === "/") {
        return { allowed: false, reason: "rm on root path is not allowed" };
      }
      const segments = p.split("/").filter(Boolean);
      if (hasRecursive && segments.length <= 1) {
        return { allowed: false, reason: `rm -r on top-level path "${p}" is not allowed` };
      }
    }
  }

  // Step 6: Path traversal check on all arguments
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (arg.includes("..")) {
      return { allowed: false, reason: `Path traversal ("..") detected in argument` };
    }
  }

  return { allowed: true, argv };
}

/**
 * Dangerous characters that can break out of shell-quoted strings or SFTP batch commands.
 * Rejects: shell metacharacters, backticks, $-expansion, newlines, null bytes.
 */
const DANGEROUS_PATH_CHARS = /[;|&`$()<>\n\r\0]/;

/**
 * Validate and sanitize a path for use in SSH commands or SFTP batch commands.
 * Rejects paths with shell metacharacters, traversal, and null bytes.
 * Returns a single-quoted escaped path safe for shell interpolation.
 */
export function sanitizePath(raw: string): string {
  if (!raw || typeof raw !== "string") throw new Error("Path must be a non-empty string");
  if (raw.includes("\0")) throw new Error("Path contains null byte");
  if (DANGEROUS_PATH_CHARS.test(raw)) throw new Error(`Path contains dangerous character: ${raw}`);
  if (raw.includes("..")) throw new Error("Path traversal (..) is not allowed");
  // Single-quote the path; escape any embedded single quotes with '\''
  return "'" + raw.replace(/'/g, "'\\''") + "'";
}
