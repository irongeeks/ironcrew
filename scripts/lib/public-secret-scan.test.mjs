import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanPublicSecrets } from "./public-secret-scan.mjs";

const directories = [];
const fixturePath = "next/tests/integration/worker-fixtures/key.pem";
const publicKey = readFileSync(new URL("../../" + fixturePath, import.meta.url));
const token = "ghp_" + "A".repeat(36);
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ironcrew-secret-scan-"));
  directories.push(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Secret Scan Fixture");
  const write = (path, bytes) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
  };
  return { dir, git, write, commit };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public release secret scanner", () => {
  it("permits only the exact public localhost fixtures in the worktree and history", () => {
    const f = repository();
    f.write(fixturePath, publicKey);
    const certificate = fixturePath.replace("key.pem", "cert.pem");
    f.write(certificate, readFileSync(new URL("../../" + certificate, import.meta.url)));
    f.commit();
    expect(scanPublicSecrets(f.dir)).toEqual([]);
  });

  it("rejects replacement content at a public fixture path", () => {
    const f = repository();
    f.write(fixturePath, publicKey);
    f.commit();
    f.write(fixturePath, token);
    expect(scanPublicSecrets(f.dir)).toEqual([expect.objectContaining({ scope: "working tree", path: fixturePath })]);
  });

  it("checks historical fixture content even when the current fixture is restored", () => {
    const f = repository();
    f.write(fixturePath, token);
    f.commit();
    f.write(fixturePath, publicKey);
    f.commit();
    const findings = scanPublicSecrets(f.dir);
    expect(findings).toEqual([expect.objectContaining({ scope: "history", path: fixturePath })]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it("rejects the public key at any other path and handles spaces in paths", () => {
    const f = repository();
    f.write("other public key.pem", publicKey);
    f.commit();
    expect(scanPublicSecrets(f.dir)).toEqual([
      expect.objectContaining({ scope: "working tree", path: "other public key.pem" }),
      expect.objectContaining({ scope: "history", path: "other public key.pem" }),
    ]);
  });

  it("reports only locations for token and RSA private-key findings", () => {
    const f = repository();
    f.write("token.txt", token);
    const privateKeyHeader = ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" ");
    f.write("private.txt", privateKeyHeader);
    f.commit();
    const findings = scanPublicSecrets(f.dir);
    expect(findings).toHaveLength(4);
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(JSON.stringify(findings)).not.toContain(privateKeyHeader);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./public-secret-scan.mjs", import.meta.url))], {
      cwd: f.dir,
      stdio: "pipe",
    });
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).not.toContain(token);
    expect(result.stderr.toString()).not.toContain(privateKeyHeader);
  });

  it("allows documented synthetic specimens but rejects an added token in the same test file", () => {
    const f = repository();
    const path = "server/ironcrew/security/redaction.test.ts";
    const source = readFileSync(new URL("../../" + path, import.meta.url), "utf8");
    f.write(path, source);
    f.commit();
    expect(scanPublicSecrets(f.dir)).toEqual([]);
    f.write(path, source + "\n" + token);
    expect(scanPublicSecrets(f.dir)).toEqual([expect.objectContaining({ scope: "working tree", path })]);
  });

  it("never exempts a changed private-key body in a synthetic fixture's test file", () => {
    const f = repository();
    const path = "server/ironcrew/security/redaction.test.ts";
    const source = readFileSync(new URL("../../" + path, import.meta.url), "utf8");
    f.write(path, source.replaceAll("MOREKEYMATERIAL", "DIFFERENTKEYMATERIAL"));
    f.commit();
    expect(scanPublicSecrets(f.dir)).toHaveLength(2);
  });

  it("does not exempt token extensions or synthetic tokens copied to unrelated files", () => {
    const f = repository();
    const sourcePath = "server/ironcrew/runtime/run-store.test.ts";
    const source = readFileSync(new URL("../../" + sourcePath, import.meta.url), "utf8");
    const synthetic = source.match(/ghp_[A-Za-z0-9]{36}/)[0];
    f.write(sourcePath, synthetic + "EXTRA");
    f.write("unrelated.txt", synthetic);
    f.commit();
    expect(scanPublicSecrets(f.dir)).toHaveLength(4);
  });
});
