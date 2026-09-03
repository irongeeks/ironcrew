// scripts/lib/env-utils.mjs
import fs from "node:fs";
import crypto from "node:crypto";

export function readEnvFile(envPath) {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
}

export function writeEnvFile(envPath, content) {
  fs.writeFileSync(envPath, content, "utf8");
}

export function readEnvValue(content, key) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

export function upsertEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const active = new RegExp(`^${key}\\s*=.*$`, "m");
  const commented = new RegExp(`^#\\s*${key}\\s*=.*$`, "m");

  if (active.test(content)) {
    return content.replace(active, line);
  }
  if (commented.test(content)) {
    return content.replace(commented, line);
  }
  if (!content.endsWith("\n")) content += "\n";
  return content + `${line}\n`;
}

export function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}
