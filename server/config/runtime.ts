import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIRNAME = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .env loader (no dotenv dependency)
// ---------------------------------------------------------------------------
const envFilePath = path.resolve(SERVER_DIRNAME, "..", "..", ".env");
try {
  if (fs.existsSync(envFilePath)) {
    const envContent = fs.readFileSync(envFilePath, "utf8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding single or double quotes (normalizeSecret/normalizePathEnv
      // already handle this for specific vars, but not all env vars go through those)
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // ignore .env read errors
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const PKG_VERSION: string = (() => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.resolve(SERVER_DIRNAME, "..", "..", "package.json"), "utf8")).version ?? "1.0.0"
    );
  } catch {
    return "1.0.0";
  }
})();

export const PORT = Number(process.env.PORT ?? 8790);
export const HOST = process.env.HOST ?? "127.0.0.1";
export const OAUTH_BASE_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
export const SESSION_COOKIE_NAME = "claw_session";

function normalizeSecret(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed === "__CHANGE_ME__") return "";
  return trimmed;
}

const API_AUTH_TOKEN = normalizeSecret(process.env.API_AUTH_TOKEN);
export const INBOX_WEBHOOK_SECRET = normalizeSecret(process.env.INBOX_WEBHOOK_SECRET);
export const SESSION_AUTH_TOKEN = API_AUTH_TOKEN || randomBytes(32).toString("hex");
export const ALLOWED_ORIGIN_SUFFIXES = (process.env.ALLOWED_ORIGIN_SUFFIXES ?? ".ts.net")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Production static file serving
// ---------------------------------------------------------------------------
export const DIST_DIR = path.resolve(SERVER_DIRNAME, "..", "..", "dist");
export const IS_PRODUCTION = !process.env.VITE_DEV && fs.existsSync(path.join(DIST_DIR, "index.html"));

// ---------------------------------------------------------------------------
// Database defaults
// ---------------------------------------------------------------------------
export const DEFAULT_DB_PATH = path.join(process.cwd(), "octooffice.sqlite");
