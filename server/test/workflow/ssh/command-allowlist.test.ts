// server/test/workflow/ssh/command-allowlist.test.ts
import { describe, it, expect } from "vitest";
import { SshConfigSchema, FileEntrySchema } from "../../../modules/workflow/ssh/types.ts";

describe("SshConfigSchema", () => {
  it("parses valid config", () => {
    const result = SshConfigSchema.safeParse({
      host: "100.101.102.103",
      port: 22,
      user: "user",
      private_key_path: "/home/user/.ssh/id_ed25519",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.known_hosts_policy).toBe("accept");
    }
  });

  it("rejects empty host", () => {
    const result = SshConfigSchema.safeParse({ host: "", user: "a", private_key_path: "/k" });
    expect(result.success).toBe(false);
  });

  it("applies default port", () => {
    const result = SshConfigSchema.safeParse({
      host: "10.0.0.1",
      user: "u",
      private_key_path: "/k",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.port).toBe(22);
  });

  it("accepts allowed_commands array", () => {
    const result = SshConfigSchema.safeParse({
      host: "10.0.0.1",
      user: "u",
      private_key_path: "/k",
      allowed_commands: ["docker", "systemctl"],
    });
    expect(result.success).toBe(true);
  });
});

describe("FileEntrySchema", () => {
  it("parses valid entry", () => {
    const result = FileEntrySchema.safeParse({
      name: "src",
      path: "/home/user/src",
      type: "directory",
      size: 4096,
      modified: "2026-03-18T10:00:00Z",
      permissions: "drwxr-xr-x",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = FileEntrySchema.safeParse({
      name: "x",
      path: "/x",
      type: "socket",
      size: 0,
      modified: "2026-01-01",
      permissions: "-",
    });
    expect(result.success).toBe(false);
  });
});

import { validateCommand, parseCommandArgv, sanitizePath } from "../../../modules/workflow/ssh/command-allowlist.ts";

describe("parseCommandArgv", () => {
  it("splits simple command", () => {
    expect(parseCommandArgv("ls -la /home")).toEqual(["ls", "-la", "/home"]);
  });

  it("handles quoted strings", () => {
    expect(parseCommandArgv('cat "file with spaces.txt"')).toEqual(["cat", "file with spaces.txt"]);
  });

  it("handles single quotes", () => {
    expect(parseCommandArgv("cat 'file name.txt'")).toEqual(["cat", "file name.txt"]);
  });
});

describe("validateCommand", () => {
  it("allows simple ls", () => {
    const result = validateCommand("ls -la /home/user");
    expect(result.allowed).toBe(true);
  });

  it("allows mkdir", () => {
    const result = validateCommand("mkdir -p /home/user/projects/new");
    expect(result.allowed).toBe(true);
  });

  it("allows git status", () => {
    const result = validateCommand("git status");
    expect(result.allowed).toBe(true);
  });

  it("rejects sudo", () => {
    const result = validateCommand("sudo rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("rejects shell metachar semicolon", () => {
    const result = validateCommand("ls; rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("metacharacter");
  });

  it("rejects pipe", () => {
    const result = validateCommand("cat file | bash");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("metacharacter");
  });

  it("rejects command substitution", () => {
    const result = validateCommand("ls $(whoami)");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("metacharacter");
  });

  it("rejects backtick substitution", () => {
    const result = validateCommand("ls `whoami`");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("metacharacter");
  });

  it("rejects redirect", () => {
    const result = validateCommand("echo hack > /etc/passwd");
    expect(result.allowed).toBe(false);
  });

  it("rejects && chaining", () => {
    const result = validateCommand("ls && rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("metacharacter");
  });

  it("rejects python -c", () => {
    const result = validateCommand("python -c 'import os; os.system(\"rm -rf /\")'");
    expect(result.allowed).toBe(false);
  });

  it("rejects find -exec", () => {
    const result = validateCommand("find / -exec rm {} ;");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-exec");
  });

  it("rejects find -execdir", () => {
    const result = validateCommand("find / -execdir rm {} ;");
    expect(result.allowed).toBe(false);
  });

  it("rejects find -delete", () => {
    const result = validateCommand("find / -delete");
    expect(result.allowed).toBe(false);
  });

  it("allows extra commands from server config", () => {
    const result = validateCommand("docker ps", ["docker"]);
    expect(result.allowed).toBe(true);
  });

  it("rejects unknown command even with extras", () => {
    const result = validateCommand("curl http://evil.com", ["docker"]);
    expect(result.allowed).toBe(false);
  });

  it("rejects path traversal in arguments", () => {
    const result = validateCommand("cat ../../../etc/passwd");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("traversal");
  });

  it("rejects rm -rf /", () => {
    const result = validateCommand("rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("root");
  });

  it("rejects rm -rf with bare slash path", () => {
    const result = validateCommand("rm -rf /var");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("top-level");
  });

  it("allows rm on specific files", () => {
    const result = validateCommand("rm /home/user/projects/temp/file.txt");
    expect(result.allowed).toBe(true);
  });
});

describe("sanitizePath", () => {
  it("returns single-quoted path for safe input", () => {
    expect(sanitizePath("/home/user/file.txt")).toBe("'/home/user/file.txt'");
  });

  it("escapes embedded single quotes", () => {
    expect(sanitizePath("/home/user/it's a file")).toBe("'/home/user/it'\\''s a file'");
  });

  it("rejects semicolons", () => {
    expect(() => sanitizePath("/tmp; rm -rf /")).toThrow("dangerous character");
  });

  it("rejects backticks", () => {
    expect(() => sanitizePath("/tmp/`whoami`")).toThrow("dangerous character");
  });

  it("rejects $() command substitution", () => {
    expect(() => sanitizePath("/tmp/$(id)")).toThrow("dangerous character");
  });

  it("rejects pipe", () => {
    expect(() => sanitizePath("/tmp/file | cat /etc/passwd")).toThrow("dangerous character");
  });

  it("rejects newlines", () => {
    expect(() => sanitizePath("/tmp/file\nrm -rf /")).toThrow("dangerous character");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizePath("/tmp/file\0")).toThrow("null byte");
  });

  it("rejects path traversal", () => {
    expect(() => sanitizePath("../../../etc/passwd")).toThrow("traversal");
  });

  it("rejects empty string", () => {
    expect(() => sanitizePath("")).toThrow("non-empty");
  });

  it("allows paths with spaces", () => {
    expect(sanitizePath("/home/user/my project")).toBe("'/home/user/my project'");
  });

  it("allows tilde paths", () => {
    expect(sanitizePath("~/projects")).toBe("'~/projects'");
  });
});
