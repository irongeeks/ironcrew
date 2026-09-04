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
/**
 * The database file, and the one place the rename from OctoOffice could have
 * silently destroyed somebody's company.
 *
 * `ironcrew.sqlite` is the name now. But an installation that predates the
 * rename has its entire history — every task, decision, approval and audit
 * entry — in a file called `octooffice.sqlite`, and a bare rename of this
 * constant would open a brand new empty database beside it. Nothing would
 * error. The service would start, the Command Center would render, and the
 * company would simply be gone: the worst possible failure, because it looks
 * like success.
 *
 * So the old file is adopted when it is the only one there, and the operator
 * is told, once, with the exact command to make it permanent. Adopted rather
 * than renamed automatically: a database file is the one thing on this box
 * that must not move without somebody deciding it should — a backup script,
 * a systemd unit or a second process may still name the old path, and a
 * surprise `mv` under a running service is how a restore turns into an
 * outage.
 *
 * `DB_PATH` overrides both and is checked first by the callers, so an
 * operator who already names the file explicitly is unaffected either way.
 */
export const DB_FILE_NAME = "ironcrew.sqlite";
/** What the file was called before the rename. Read-only fallback. */
export const LEGACY_DB_FILE_NAME = "octooffice.sqlite";

function resolveDefaultDbPath(): string {
  const preferred = path.join(process.cwd(), DB_FILE_NAME);
  const legacy = path.join(process.cwd(), LEGACY_DB_FILE_NAME);
  try {
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
      // Not `logger` — this module is imported before the logger exists.
      console.warn(
        `[ironcrew] Using the pre-rename database "${LEGACY_DB_FILE_NAME}". ` +
          `Stop the service and run: mv ${LEGACY_DB_FILE_NAME} ${DB_FILE_NAME} ` +
          `(and the -wal/-shm files beside it, if present).`,
      );
      return legacy;
    }
  } catch {
    // An unreadable working directory is not this function's problem to
    // report; fall through to the new name and let the opener say so.
  }
  return preferred;
}

export const DEFAULT_DB_PATH = resolveDefaultDbPath();
