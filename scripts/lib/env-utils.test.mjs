// scripts/lib/env-utils.test.mjs
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readEnvFile, readEnvValue, upsertEnvValue, generateSecret, writeEnvFile } from "./env-utils.mjs";

describe("env-utils", () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-utils-test-"));
    envPath = path.join(tmpDir, ".env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readEnvValue", () => {
    it("reads a plain value", () => {
      fs.writeFileSync(envPath, "PORT=8790\nHOST=localhost\n");
      const content = readEnvFile(envPath);
      expect(readEnvValue(content, "PORT")).toBe("8790");
    });

    it("reads a quoted value", () => {
      fs.writeFileSync(envPath, 'SECRET="abc123"\n');
      const content = readEnvFile(envPath);
      expect(readEnvValue(content, "SECRET")).toBe("abc123");
    });

    it("returns empty string for missing key", () => {
      fs.writeFileSync(envPath, "PORT=8790\n");
      const content = readEnvFile(envPath);
      expect(readEnvValue(content, "MISSING")).toBe("");
    });
  });

  describe("upsertEnvValue", () => {
    it("updates an existing key", () => {
      const content = "PORT=8790\nHOST=localhost\n";
      const result = upsertEnvValue(content, "PORT", "9000");
      expect(readEnvValue(result, "PORT")).toBe("9000");
      expect(readEnvValue(result, "HOST")).toBe("localhost");
    });

    it("uncomments a commented key", () => {
      const content = "# PORT=8790\nHOST=localhost\n";
      const result = upsertEnvValue(content, "PORT", "9000");
      expect(readEnvValue(result, "PORT")).toBe("9000");
    });

    it("appends a new key", () => {
      const content = "HOST=localhost\n";
      const result = upsertEnvValue(content, "PORT", "9000");
      expect(readEnvValue(result, "PORT")).toBe("9000");
    });
  });

  describe("generateSecret", () => {
    it("returns a 64-character hex string", () => {
      const secret = generateSecret();
      expect(secret).toHaveLength(64);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique values", () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a).not.toBe(b);
    });
  });

  describe("writeEnvFile", () => {
    it("writes content and can be read back", () => {
      const content = "PORT=8790\nSECRET=abc\n";
      writeEnvFile(envPath, content);
      const readBack = readEnvFile(envPath);
      expect(readBack).toBe(content);
    });
  });
});
