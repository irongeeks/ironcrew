// scripts/lib/db-path.mjs
//
// Where the operational CLIs look for the database when nobody told them.
//
// This exists because they disagreed. The server resolves its default in
// server/config/runtime.ts as ./ironcrew.sqlite in the working directory, with
// a fallback to the pre-rename ./octooffice.sqlite; the migrate and backup
// CLIs defaulted to <repo>/data/ironcrew.sqlite instead. On an installation
// that follows the Quick start — which does not set DB_PATH — that meant the
// backup script reported "Datenbank nicht gefunden" while the database sat one
// directory up, and the migrate check that exists to stop an old build from
// writing into a newer schema was checking a file that was not there.
//
// The order below is deliberate:
//   1. --db          the operator said so
//   2. $DB_PATH      the service was told so, and these tools serve the service
//   3. ./ironcrew.sqlite         the server's own default
//   4. ./octooffice.sqlite       the same install before the rename
//   5. ./data/ironcrew.sqlite    the layout docs/LINUX_INSTALL.md sets up
//
// 4 matters more than it looks: an installation older than the rename keeps
// every task, decision, approval and audit entry in the legacy file. Skipping
// it would back up, migrate or verify an empty database and report success.
//
// Only existing files are considered for 3-5. If none of them exists the
// preferred name is returned so the caller's "not found" message names the
// file the operator should have.

import fs from "node:fs";
import path from "node:path";

export const DB_FILE_NAME = "ironcrew.sqlite";
export const LEGACY_DB_FILE_NAME = "octooffice.sqlite";

/**
 * @param {object} [options]
 * @param {string} [options.explicit]  value of --db, already as the user typed it
 * @param {string} [options.cwd]       directory --db and $DB_PATH resolve against
 * @param {string} [options.repoRoot]  checkout root, for the ./data layout
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string} absolute path
 */
export function resolveDbPath({ explicit, cwd = process.cwd(), repoRoot = cwd, env = process.env } = {}) {
  if (explicit) return path.resolve(cwd, explicit);
  if (env.DB_PATH) return path.resolve(cwd, env.DB_PATH);

  const candidates = [
    path.join(cwd, DB_FILE_NAME),
    path.join(cwd, LEGACY_DB_FILE_NAME),
    path.join(repoRoot, "data", DB_FILE_NAME),
    path.join(repoRoot, "data", LEGACY_DB_FILE_NAME),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable directory is not an answer either way; keep looking.
    }
  }
  return candidates[0];
}

/**
 * True when the resolved path is the pre-rename file. Callers use it to say so
 * out loud — silently operating on octooffice.sqlite is correct behaviour but
 * confusing behaviour, and the operator has an `mv` to run.
 */
export function isLegacyDbPath(dbPath) {
  return path.basename(dbPath) === LEGACY_DB_FILE_NAME;
}

/**
 * Says so, once, when the resolved database is the pre-rename file.
 *
 * Operating on it is correct — it is the real database. Operating on it
 * silently is not: the operator asked for IronCrew and the tool touched a file
 * called octooffice.sqlite. The same `mv` the server suggests is suggested
 * here, and only here, so the notice never lands in the middle of --json
 * output that something else is parsing.
 *
 * @param {string} dbPath
 * @param {string} prefix  the tool's own log prefix, e.g. "[ironcrew-backup]"
 */
export function announceLegacyDbPath(dbPath, prefix) {
  if (!isLegacyDbPath(dbPath)) return;
  process.stderr.write(
    `${prefix} Verwende die Datenbank von vor der Umbenennung: ${dbPath}\n` +
      `${prefix} Dienst stoppen und umbenennen: mv ${LEGACY_DB_FILE_NAME} ${DB_FILE_NAME}\n`,
  );
}
