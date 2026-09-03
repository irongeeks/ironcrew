import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const customSkillsDir = path.join(projectRoot, "custom-skills");
const defaultDbPath = path.join(projectRoot, "octooffice.sqlite");

function toPosInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function uniqueStrings(values) {
  const out = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeDbPath(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return t || defaultDbPath;
}

function scoreMeta(meta, dirPath) {
  const mUpdated = toPosInt(meta?.updatedAt);
  const mCreated = toPosInt(meta?.createdAt);
  let mtime = 0;
  try {
    mtime = toPosInt(fs.statSync(dirPath).mtimeMs);
  } catch {
    // noop
  }
  return Math.max(mUpdated, mCreated, mtime);
}

function renameDirWithCaseSupport(fromPath, toPath) {
  if (fromPath === toPath) return;
  const sameFold = fromPath.toLowerCase() === toPath.toLowerCase();
  if (sameFold) {
    const tmpPath = path.join(
      path.dirname(fromPath),
      `.tmp-case-${path.basename(fromPath)}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    fs.renameSync(fromPath, tmpPath);
    fs.renameSync(tmpPath, toPath);
    return;
  }
  fs.renameSync(fromPath, toPath);
}

function readSkillsContentLength(skillDir, fallback = 0) {
  try {
    const skillFilePath = path.join(skillDir, "skills.md");
    if (!fs.existsSync(skillFilePath)) return toPosInt(fallback);
    return Buffer.byteLength(fs.readFileSync(skillFilePath, "utf-8"), "utf-8");
  } catch {
    return toPosInt(fallback);
  }
}

function ensureCanonicalMeta(skillDir, fallbackSkillName, canonicalSkillName) {
  const metaPath = path.join(skillDir, "meta.json");
  const current = readJson(metaPath) ?? {};
  const skillName = String(current.skillName ?? fallbackSkillName ?? canonicalSkillName).trim() || canonicalSkillName;
  const providers = uniqueStrings(Array.isArray(current.providers) ? current.providers : []);
  const createdAt = toPosInt(current.createdAt) || Date.now();
  const updatedAt = Math.max(toPosInt(current.updatedAt), createdAt);
  const contentLength = readSkillsContentLength(skillDir, current.contentLength);
  const next = {
    skillName,
    canonicalSkillName,
    providers,
    createdAt,
    updatedAt,
    contentLength,
  };
  const before = JSON.stringify(current);
  const after = JSON.stringify(next);
  if (before !== after) {
    fs.writeFileSync(metaPath, JSON.stringify(next, null, 2), "utf-8");
    return true;
  }
  return false;
}

function mergeSkillDirs(sourceDir, targetDir, canonicalSkillName) {
  const sourceMetaPath = path.join(sourceDir, "meta.json");
  const targetMetaPath = path.join(targetDir, "meta.json");
  const sourceMeta = readJson(sourceMetaPath) ?? {};
  const targetMeta = readJson(targetMetaPath) ?? {};
  const sourceScore = scoreMeta(sourceMeta, sourceDir);
  const targetScore = scoreMeta(targetMeta, targetDir);
  const sourceSkillsPath = path.join(sourceDir, "skills.md");
  const targetSkillsPath = path.join(targetDir, "skills.md");
  const preferSource = sourceScore >= targetScore;

  if (preferSource && fs.existsSync(sourceSkillsPath)) {
    fs.copyFileSync(sourceSkillsPath, targetSkillsPath);
  } else if (!fs.existsSync(targetSkillsPath) && fs.existsSync(sourceSkillsPath)) {
    fs.copyFileSync(sourceSkillsPath, targetSkillsPath);
  }

  const winnerMeta = preferSource ? sourceMeta : targetMeta;
  const mergedProviders = uniqueStrings([
    ...(Array.isArray(targetMeta.providers) ? targetMeta.providers : []),
    ...(Array.isArray(sourceMeta.providers) ? sourceMeta.providers : []),
  ]);
  const createdCandidates = [toPosInt(sourceMeta.createdAt), toPosInt(targetMeta.createdAt)].filter((v) => v > 0);
  const createdAt = createdCandidates.length > 0 ? Math.min(...createdCandidates) : Date.now();
  const updatedAt = Math.max(toPosInt(sourceMeta.updatedAt), toPosInt(targetMeta.updatedAt), createdAt);
  const skillName = String(winnerMeta.skillName ?? canonicalSkillName).trim() || canonicalSkillName;
  const contentLength = readSkillsContentLength(targetDir, winnerMeta.contentLength);
  const mergedMeta = {
    skillName,
    canonicalSkillName,
    providers: mergedProviders,
    createdAt,
    updatedAt,
    contentLength,
  };
  fs.writeFileSync(targetMetaPath, JSON.stringify(mergedMeta, null, 2), "utf-8");
  fs.rmSync(sourceDir, { recursive: true, force: true });
}

function migrateFileSystem(summary) {
  if (!fs.existsSync(customSkillsDir)) {
    console.log(`[custom-skills] directory not found: ${customSkillsDir}`);
    return;
  }

  const entries = fs.readdirSync(customSkillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    summary.directoriesScanned += 1;
    const originalName = entry.name;
    const canonicalName = originalName.toLowerCase();

    if (!SKILL_NAME_RE.test(originalName)) {
      summary.invalidNameSkipped += 1;
      console.warn(`[custom-skills] skipped invalid name: ${originalName}`);
      continue;
    }

    let workingDir = path.join(customSkillsDir, originalName);
    const canonicalDir = path.join(customSkillsDir, canonicalName);

    if (originalName !== canonicalName) {
      if (fs.existsSync(canonicalDir)) {
        mergeSkillDirs(workingDir, canonicalDir, canonicalName);
        summary.directoriesMerged += 1;
        workingDir = canonicalDir;
      } else {
        renameDirWithCaseSupport(workingDir, canonicalDir);
        summary.directoriesRenamed += 1;
        workingDir = canonicalDir;
      }
    }

    if (ensureCanonicalMeta(workingDir, originalName, canonicalName)) {
      summary.metaUpdated += 1;
    }
  }
}

function migrateDatabase(summary) {
  const dbPath = normalizeDbPath(process.env.DB_PATH);
  if (!fs.existsSync(dbPath)) {
    console.log(`[custom-skills] database not found, skipped DB migration: ${dbPath}`);
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_learning_history'")
      .get();
    if (!table) {
      console.log("[custom-skills] table skill_learning_history not found, skipped DB migration");
      return;
    }

    const rows = db.prepare("SELECT DISTINCT repo FROM skill_learning_history WHERE repo LIKE 'custom/%'").all();

    for (const row of rows) {
      const repo = String(row.repo ?? "").trim();
      if (!repo.toLowerCase().startsWith("custom/")) continue;
      const rawSkillName = repo.slice("custom/".length);
      if (!rawSkillName) continue;
      const canonicalSkillName = rawSkillName.toLowerCase();
      const canonicalRepo = `custom/${canonicalSkillName}`;
      const now = Date.now();

      const repoChanges = db
        .prepare("UPDATE skill_learning_history SET repo = ?, updated_at = ? WHERE lower(repo) = lower(?)")
        .run(canonicalRepo, now, repo).changes;
      summary.dbRepoRowsUpdated += Number(repoChanges || 0);

      const skillIdChanges = db
        .prepare(
          "UPDATE skill_learning_history SET skill_id = ?, updated_at = ? WHERE lower(repo) = lower(?) AND lower(skill_id) = lower(?)",
        )
        .run(canonicalSkillName, now, canonicalRepo, rawSkillName).changes;
      summary.dbSkillIdRowsUpdated += Number(skillIdChanges || 0);
    }
  } finally {
    db.close();
  }
}

function main() {
  const summary = {
    directoriesScanned: 0,
    directoriesRenamed: 0,
    directoriesMerged: 0,
    metaUpdated: 0,
    invalidNameSkipped: 0,
    dbRepoRowsUpdated: 0,
    dbSkillIdRowsUpdated: 0,
  };

  migrateFileSystem(summary);
  migrateDatabase(summary);

  console.log("[custom-skills] migration complete");
  console.log(JSON.stringify(summary, null, 2));
}

main();
