import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
/** Explicit native release updates. No branch pull, daemon restart or automatic database downgrade. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { releaseVersionOrderOverride } from "./release-version.mjs";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const PUBLIC_REPO = "irongeeks/ironcrew";
export class UpdateError extends Error {}
export function cleanEnvironment(env = process.env) {
  const safe = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"].filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
  );
  return {
    ...safe,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_manage_package_manager_versions: "false",
  };
}
/** Capture bounded output; callers deliberately never forward subprocess stderr or environment. */
export function execute(command, args, { cwd, env = cleanEnvironment(), timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      stopped = false;
    const stop = () => {
      stopped = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") reject(new UpdateError("Unterprozess konnte nicht beendet werden."));
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    const collect = (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 2_000_000) stop();
    };
    child.stdout.setEncoding("utf8").on("data", (c) => collect("stdout", c));
    child.stderr.setEncoding("utf8").on("data", (c) => collect("stderr", c));
    child.once("error", () => {
      clearTimeout(timer);
      reject(new UpdateError("Benötigtes lokales Programm konnte nicht gestartet werden."));
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (stopped) reject(new UpdateError("Unterprozess überschritt Zeit- oder Ausgabelimit."));
      else resolve({ status, stdout, stderr });
    });
  });
}
function ensure(condition, message) {
  if (!condition) throw new UpdateError(message);
}
async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
async function jsonResponse(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json" },
    signal: globalThis.AbortSignal.timeout(15000),
  });
  ensure(
    response.ok,
    "Öffentliche Release-Metadaten sind nicht verfügbar. Expliziten --commit verwenden oder später erneut prüfen.",
  );
  let size = 0,
    text = "";
  for await (const chunk of response.body) {
    size += chunk.length;
    ensure(size <= 256000, "Release-Metadaten überschreiten das Größenlimit.");
    text += Buffer.from(chunk).toString("utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdateError("Release-Metadaten enthalten kein gültiges JSON.");
  }
}
export async function publishedCommit(tag, remoteUrl, fetcher = globalThis.fetch) {
  ensure(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)irongeeks\/ironcrew(?:\.git)?$/.test(
      remoteUrl,
    ),
    "Automatische Releaseauflösung benötigt den offiziellen GitHub-Remote; ansonsten --commit angeben.",
  );
  const release = await jsonResponse(`https://api.github.com/repos/${PUBLIC_REPO}/releases/tags/${tag}`, fetcher);
  ensure(
    release.tag_name === tag && !release.draft && !release.prerelease,
    "Release muss veröffentlicht und stabil sein.",
  );
  const assetUrl = `https://github.com/${PUBLIC_REPO}/releases/download/${tag}/release-manifest.json`;
  ensure(
    release.assets?.some((a) => a.name === "release-manifest.json" && a.browser_download_url === assetUrl),
    "Veröffentlichtes Release-Manifest fehlt.",
  );
  const manifest = await jsonResponse(assetUrl, fetcher);
  ensure(
    manifest.schemaVersion === 1 &&
      manifest.tag === tag &&
      manifest.version === tag.slice(1) &&
      SHA.test(manifest.commit),
    "Release-Manifest passt nicht zu Version oder Commit.",
  );
  return manifest.commit;
}
export async function assertStopped(options, run) {
  const manager = options.serviceManager ?? (process.platform === "darwin" ? "launchd" : "systemd");
  if (manager === "manual") {
    ensure(
      options.confirmStopped === true,
      "Manueller Betrieb benötigt --confirm-stopped nach Stoppen aller Prozesse dieses Checkouts.",
    );
    return;
  }
  if (manager === "systemd") {
    const service = options.service ?? "ironcrew.service";
    ensure(/^[A-Za-z0-9_.@-]+\.service$/.test(service), "Ungültiger systemd-Dienstname.");
    const runnerService = options.runnerService ?? "ironcrew-runner.service";
    ensure(/^[A-Za-z0-9_.@-]+\.service$/.test(runnerService), "Ungültiger Runner-Dienstname.");
    for (const name of new Set([service, runnerService])) {
      const result = await run("systemctl", [
        "show",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        name,
      ]);
      const fields = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      if (name !== service && [0, 1].includes(result.status) && fields.LoadState === "not-found") continue;
      ensure(
        result.status === 0 &&
          fields.LoadState === "loaded" &&
          ["inactive", "failed"].includes(fields.ActiveState) &&
          ["dead", "failed"].includes(fields.SubState),
        "Dienststillstand nicht bestätigt. Control Plane und installierten nativen Runner zuerst stoppen; automatische Neustarts verhindern.",
      );
    }
    return;
  }
  if (manager === "launchd") {
    const service = options.service ?? "eu.irongeeks.ironcrew",
      domain = options.launchdDomain ?? "system";
    ensure(/^[A-Za-z0-9_.-]+$/.test(service) && /^(system|gui\/\d+)$/.test(domain), "Ungültige launchd-Dienstadresse.");
    const runnerService = options.runnerService ?? "eu.irongeeks.ironcrew-runner";
    ensure(/^[A-Za-z0-9_.-]+$/.test(runnerService), "Ungültige Runner-Dienstadresse.");
    for (const name of new Set([service, runnerService])) {
      const result = await run("launchctl", ["print", `${domain}/${name}`]);
      ensure(
        result.status !== 0 && /Could not find service/.test(result.stderr),
        "launchd-Control-Plane und Runner zuerst mit bootout entladen; Stillstand ist nicht bestätigt.",
      );
    }
    return;
  }
  throw new UpdateError("Unbekannter Dienstmanager.");
}
export async function updateRelease(
  options,
  { run = execute, fetcher = globalThis.fetch, onProgress = () => {} } = {},
) {
  ensure(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22 oder neuer ist erforderlich.");
  ensure(
    TAG.test(options.to ?? ""),
    "--to benötigt ein exaktes stabiles Tag vX.Y.Z; main/latest/Prereleases sind ausgeschlossen.",
  );
  if (options.commit !== undefined)
    ensure(
      SHA.test(options.commit),
      "--commit benötigt einen vollständigen kleingeschriebenen 40-stelligen Commit-SHA.",
    );
  const repo = await fs.realpath(options.repo ?? process.cwd());
  const git = async (args, allowFailure = false) => {
    const result = await run("git", args, { cwd: repo });
    ensure(
      allowFailure || result.status === 0,
      "Git-Prüfung oder Releaseoperation fehlgeschlagen; keine fremden Ausgaben werden übernommen.",
    );
    return result;
  };
  const root = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
  ensure((await fs.realpath(root)) === repo, "Updater muss auf dem Wurzelverzeichnis des Checkouts arbeiten.");
  const original = (await git(["rev-parse", "HEAD"])).stdout.trim();
  ensure(SHA.test(original), "Aktueller Commit ist ungültig.");
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  const originalBranch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const assertClean = async () =>
    ensure(
      !(await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout,
      "Checkout enthält lokale Änderungen oder unversionierte Dateien. Vor dem Update sichern/committen.",
    );
  await assertClean();
  const remote = options.remote ?? "origin";
  ensure(/^[A-Za-z0-9_-]+$/.test(remote), "Remote muss ein konfigurierter Git-Remotename sein.");
  const remoteUrl = (await git(["remote", "get-url", remote])).stdout.trim();
  const commit = options.commit ?? (await publishedCommit(options.to, remoteUrl, fetcher));
  const temporaryRef = `refs/ironcrew-update/${randomUUID()}`;
  let transaction,
    backupDirectory,
    locked = false,
    switched = false,
    completed = false,
    recovered = false;
  const lockPath = path.resolve(repo, (await git(["rev-parse", "--git-path", "ironcrew-update.lock"])).stdout.trim());
  const moved = [];
  let stageAdded = false;
  const result = {
    startedAt: new Date().toISOString(),
    operator: { uid: process.getuid?.() ?? null, platform: process.platform },
    version: options.to.slice(1),
    tag: options.to,
    commit,
    previousCommit: original,
    mode: options.check || options.dryRun ? "check" : "apply",
    backupDirectory: null,
    serviceStarted: false,
    databaseMigrated: false,
  };
  try {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if (error.code === "EEXIST")
        throw new UpdateError(
          "Ein Update-Lock besteht bereits. Laufenden Vorgang prüfen; verwaisten Lock erst danach manuell entfernen.",
        );
      throw error;
    }
    onProgress("Release-Tag und Commit prüfen");
    await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/tags/${options.to}:${temporaryRef}`]);
    const resolved = (await git(["rev-parse", `${temporaryRef}^{commit}`])).stdout.trim();
    ensure(resolved === commit, "Release-Tag und erwarteter Commit stimmen nicht überein.");
    let pkg;
    try {
      pkg = JSON.parse((await git(["show", `${commit}:package.json`])).stdout);
    } catch {
      throw new UpdateError("Release enthält kein gültiges package.json.");
    }
    ensure(pkg.version === options.to.slice(1), "Release-Tag und package.json-Version stimmen nicht überein.");
    ensure(
      /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(pkg.packageManager ?? ""),
      "Release muss eine exakte pnpm-Version festlegen.",
    );
    let currentPackage;
    try {
      currentPackage = JSON.parse((await git(["show", `${original}:package.json`])).stdout);
    } catch {
      throw new UpdateError("Aktuelle Anwendungsversion ist nicht lesbar.");
    }
    ensure(
      TAG.test(`v${currentPackage.version}`),
      "Aktuelle Version ist kein stabiles Semver; manuelle Releaseumstellung erforderlich.",
    );
    const currentVersion = currentPackage.version.split(".").map(BigInt),
      targetVersion = pkg.version.split(".").map(BigInt);
    const difference =
      releaseVersionOrderOverride(pkg.version, currentPackage.version) ??
      targetVersion.map((part, i) => part - currentVersion[i]).find((n) => n !== 0n) ??
      0n;
    ensure(
      difference >= 0n,
      "Automatischer Versions-Downgrade ist ausgeschlossen. Passende Datenbankwiederherstellung muss manuell geplant werden.",
    );
    if (difference === 0n && original !== commit) {
      const existingTag = await git(["rev-parse", `refs/tags/${options.to}^{commit}`], true);
      ensure(
        existingTag.status !== 0 || existingTag.stdout.trim() !== original,
        "Gleiche veröffentlichte Version zeigt auf einen anderen Commit; Release nicht überschreiben.",
      );
    }
    if (options.check || options.dryRun) return result;
    ensure(
      options.db && path.isAbsolute(options.db) && options.backupDir && path.isAbsolute(options.backupDir),
      "Apply benötigt --db und --backup-dir als absolute Pfade.",
    );
    const db = await fs.realpath(options.db);
    ensure((await fs.stat(db)).isFile(), "Datenbankpfad muss auf eine bestehende Datei zeigen.");
    await fs.mkdir(options.backupDir, { recursive: true, mode: 0o700 });
    const backupRoot = await fs.realpath(options.backupDir);
    ensure(!inside(repo, backupRoot), "Backup-Verzeichnis muss außerhalb des Checkouts liegen.");
    await assertStopped(options, run);
    backupDirectory = await fs.mkdtemp(path.join(backupRoot, "release-update-"));
    await fs.chmod(backupDirectory, 0o700);
    result.backupDirectory = backupDirectory;
    const extras = [
      ...new Set([
        path.join(repo, "data/private-assets"),
        path.join(repo, "config/private"),
        path.join(repo, "vault"),
        path.join(repo, "data/vault"),
        path.join(repo, "data/crew-attachments"),
        path.join(repo, ".env"),
        ...(options.extras ?? []),
      ]),
    ];
    const backupArgs = [path.join(repo, "scripts/ironcrew-backup.mjs"), "--db", db, "--out", backupDirectory];
    if (options.attachments) backupArgs.push("--attachments", path.resolve(options.attachments));
    for (const extra of extras) {
      ensure(path.isAbsolute(extra), "Zusätzliche Backuppfade müssen absolut sein.");
      if (await exists(extra)) backupArgs.push("--extra", extra);
      else ensure(!(options.extras ?? []).includes(extra), "Expliziter zusätzlicher Backuppfad fehlt.");
    }
    onProgress("Datenbank, Anhänge und private Projektdaten sichern");
    ensure(
      (await run(process.execPath, backupArgs, { cwd: repo, timeoutMs: 600000 })).status === 0,
      "Backup fehlgeschlagen; Anwendung wurde nicht verändert.",
    );
    const archives = (await fs.readdir(backupDirectory)).filter((name) => name.endsWith(".tar.gz"));
    ensure(archives.length === 1, "Backup lieferte kein eindeutiges Archiv; Anwendung wurde nicht verändert.");
    await fs.chmod(path.join(backupDirectory, archives[0]), 0o600);
    ensure(
      (
        await run(
          process.execPath,
          [path.join(repo, "scripts/ironcrew-backup.mjs"), "--inspect", path.join(backupDirectory, archives[0])],
          { cwd: repo, timeoutMs: 600000 },
        )
      ).status === 0,
      "Backupmanifest ist nicht lesbar; Anwendung wurde nicht verändert.",
    );
    await fs.writeFile(
      path.join(backupDirectory, "update.json"),
      JSON.stringify({ ...result, previousBranch: originalBranch, backupArchive: archives[0] }, null, 2) + "\n",
      { mode: 0o600 },
    );
    transaction = await fs.mkdtemp(path.join(path.dirname(repo), ".ironcrew-update-"));
    await fs.chmod(transaction, 0o700);
    const stage = path.join(transaction, "candidate");
    await fs.writeFile(
      path.join(backupDirectory, "update.json"),
      JSON.stringify(
        {
          ...result,
          status: "preparing",
          previousBranch: originalBranch,
          backupArchive: archives[0],
          transactionDirectory: transaction,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await git(["worktree", "add", "--detach", stage, commit]);
    stageAdded = true;
    const pnpm = options.pnpm ?? "pnpm";
    const pmVersion = await run(pnpm, ["--version"], { cwd: stage });
    ensure(
      pmVersion.status === 0 && pmVersion.stdout.trim() === pkg.packageManager.split("@")[1].split("+")[0],
      "Installierte pnpm-Version stimmt nicht mit dem Release überein.",
    );
    onProgress("Release isoliert installieren und bauen");
    ensure(
      (await run(pnpm, ["install", "--frozen-lockfile"], { cwd: stage, timeoutMs: 1200000 })).status === 0,
      "Release-Installation fehlgeschlagen; ursprünglicher Checkout bleibt erhalten.",
    );
    ensure(
      (await run(pnpm, ["build"], { cwd: stage, timeoutMs: 1200000 })).status === 0,
      "Release-Build fehlgeschlagen; ursprünglicher Checkout bleibt erhalten.",
    );
    for (const artifact of ["node_modules", "dist"]) {
      const stat = await fs.lstat(path.join(stage, artifact));
      ensure(stat.isDirectory() && !stat.isSymbolicLink(), "Buildartefakte fehlen oder sind unerwartete Symlinks.");
    }
    await assertClean();
    ensure(
      (await git(["rev-parse", "HEAD"])).stdout.trim() === original,
      "Checkout wurde während der Vorbereitung verändert.",
    );
    await assertStopped(options, run);
    onProgress("Geprüften Release einwechseln; Dienst bleibt gestoppt");
    await git(["checkout", "--detach", "--no-overwrite-ignore", commit]);
    switched = true;
    for (const artifact of ["node_modules", "dist"]) {
      const current = path.join(repo, artifact),
        previous = path.join(transaction, `previous-${artifact}`);
      if (await exists(current)) {
        ensure(
          !(await fs.lstat(current)).isSymbolicLink(),
          "Bestehende Buildartefakte dürfen keine externen Symlinks sein.",
        );
        await fs.rename(current, previous);
        moved.push({ artifact, hadPrevious: true });
      } else moved.push({ artifact, hadPrevious: false });
      await fs.rename(path.join(stage, artifact), current);
    }
    await assertStopped(options, run);
    await fs.writeFile(
      path.join(backupDirectory, "update.json"),
      JSON.stringify(
        { ...result, status: "installed-service-stopped", previousBranch: originalBranch, backupArchive: archives[0] },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    completed = true;
    return result;
  } catch (error) {
    if (switched && !completed) {
      try {
        await assertStopped(options, run);
        for (const item of [...moved].reverse()) {
          await fs.rm(path.join(repo, item.artifact), { recursive: true, force: true });
          if (item.hadPrevious)
            await fs.rename(path.join(transaction, `previous-${item.artifact}`), path.join(repo, item.artifact));
        }
        const branchUnchanged =
          originalBranch && (await git(["rev-parse", `refs/heads/${originalBranch}`], true)).stdout.trim() === original;
        await git([
          "checkout",
          ...(branchUnchanged ? [] : ["--detach"]),
          "--no-overwrite-ignore",
          branchUnchanged ? originalBranch : original,
        ]);
        recovered = true;
      } catch {
        throw new UpdateError(
          "Updatewechsel fehlgeschlagen; automatische Wiederherstellung war nicht sicher möglich. Dienst gestoppt lassen und lokalen Transaktionsordner sowie Backup prüfen. Datenbank wurde nicht zurückgesetzt.",
        );
      }
    }
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      "Releaseupdate fehlgeschlagen. Dienstzustand, Berechtigungen und freien Speicher prüfen; keine Datenbankrücksetzung ausgeführt.",
    );
  } finally {
    if (stageAdded && (!switched || completed || recovered))
      await git(["worktree", "remove", "--force", path.join(transaction, "candidate")], true);
    // Preserve any previous artifacts when recovery could not safely finish.
    if (transaction) {
      if (!switched || completed || recovered) await fs.rm(transaction, { recursive: true, force: true });
    }
    await git(["update-ref", "-d", temporaryRef], true);
    if (locked)
      await fs
        .rmdir(lockPath)
        .catch(() => onProgress("Update-Lock konnte nicht entfernt werden; vor nächstem Update manuell prüfen."));
  }
}
