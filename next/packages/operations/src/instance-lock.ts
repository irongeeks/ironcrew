import { open, readFile, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OperationError } from "./common.ts";
type Record = { version: 1; pid: number; token: string; purpose: string; createdAt: string };
type OwnedFile = { file: string; dev: number; ino: number; record: Record };
const instanceName = "instance.lock",
  gateName = ".instance-acquire.lock";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function recovery(file: string): OperationError {
  return new OperationError(
    "lock_recovery_required",
    `Sperre ${file} bleibt geschützt. Zentrale und Offline-CLI vollständig beenden; PID und Besitz-Token der Sperrdatei prüfen und erst danach diese konkrete Sperrdatei als Administrator entfernen. Keine automatische Übernahme einer abgebrochenen Übernahmesperre.`,
  );
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function inspect(
  file: string,
): Promise<{ dev: number; ino: number; record: Record | { pid: number } } | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw recovery(file);
    const raw = await readFile(file, "utf8");
    const parsed = /^\d+\s*$/.test(raw) ? { pid: Number(raw.trim()) } : JSON.parse(raw);
    if (
      !parsed ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      parsed.pid > 2147483647 ||
      ("token" in parsed &&
        (parsed.version !== 1 || typeof parsed.token !== "string" || !/^[a-f0-9-]{36}$/.test(parsed.token)))
    )
      throw recovery(file);
    return { dev: stat.dev, ino: stat.ino, record: parsed };
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof OperationError) throw error;
    throw recovery(file);
  }
}
async function create(file: string, record: Record): Promise<OwnedFile> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\n");
    await handle.sync();
    const stat = await handle.stat();
    return { file, dev: stat.dev, ino: stat.ino, record };
  } finally {
    await handle.close();
  }
}
async function removeOwned(owned: OwnedFile, file = owned.file): Promise<void> {
  const current = await inspect(file);
  if (
    !current ||
    current.dev !== owned.dev ||
    current.ino !== owned.ino ||
    !("token" in current.record) ||
    current.record.token !== owned.record.token ||
    current.record.pid !== process.pid
  )
    throw new OperationError(
      "lock_ownership_changed",
      `Sperre ${file} gehört nicht mehr dieser Operation; sie wurde nicht entfernt.`,
    );
  await unlink(file);
}
const record = (purpose: string): Record => ({
  version: 1,
  pid: process.pid,
  token: randomUUID(),
  purpose,
  createdAt: new Date().toISOString(),
});
async function guard(file: string): Promise<OwnedFile> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      return await create(file, record("acquisition"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: Awaited<ReturnType<typeof inspect>>;
      try {
        existing = await inspect(file);
      } catch {
        if (Date.now() >= deadline) throw recovery(file);
      }
      if (existing && !alive(existing.record.pid)) throw recovery(file);
      if (Date.now() >= deadline)
        throw new OperationError(
          "instance_busy",
          `Übernahme-/Verzeichniswechsel läuft: ${file}. Nach Abschluss erneut versuchen; bei Prozessabbruch ist eine geprüfte Betreiberbereinigung erforderlich.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
async function assertNoTransition(file: string) {
  const transition = await inspect(file);
  if (!transition) return;
  if (!alive(transition.record.pid)) throw recovery(file);
  throw new OperationError(
    "instance_busy",
    `Datenverzeichnis wird gerade vorbereitet oder wiederhergestellt: ${file}.`,
  );
}
/** Shared by control and offline CLI. All acquisitions and releases serialize through an O_EXCL gate. */
export class InstanceLock {
  readonly directory: string;
  private owned: OwnedFile;
  private readonly transitionPath: string;
  private released = false;
  private replacing = false;
  constructor(directory: string, owned: OwnedFile, transitionPath: string) {
    this.directory = directory;
    this.owned = owned;
    this.transitionPath = transitionPath;
  }
  async release(): Promise<void> {
    if (this.released) return;
    if (this.replacing) throw recovery(this.transitionPath);
    const gate = await guard(path.join(this.directory, gateName));
    try {
      await assertNoTransition(this.transitionPath);
      await removeOwned(this.owned);
      this.released = true;
    } finally {
      await removeOwned(gate);
    }
  }
  /** Preserve ownership while restore atomically exchanges the data directory. The parent marker survives both renames. */
  async prepareReplacement(
    stagedDirectory: string,
  ): Promise<{ finish: (previousDirectory?: string) => Promise<void> }> {
    if (this.released || this.replacing)
      throw new OperationError("lock_state", "Instanzsperre ist nicht für Wiederherstellung bereit.");
    const gate = await guard(path.join(this.directory, gateName));
    let transition: OwnedFile;
    try {
      const current = await inspect(this.owned.file);
      if (
        !current ||
        current.dev !== this.owned.dev ||
        current.ino !== this.owned.ino ||
        !("token" in current.record) ||
        current.record.token !== this.owned.record.token
      )
        throw recovery(this.owned.file);
      transition = await guard(this.transitionPath);
    } catch (error) {
      await removeOwned(gate);
      throw error;
    }
    let staged: OwnedFile;
    try {
      staged = await create(path.join(stagedDirectory, instanceName), this.owned.record);
    } catch (error) {
      await removeOwned(transition);
      await removeOwned(gate);
      throw error;
    }
    this.replacing = true;
    let finished = false;
    return {
      finish: async (previousDirectory) => {
        if (finished) return;
        const current = await inspect(path.join(this.directory, instanceName));
        if (!current || !("token" in current.record) || current.record.token !== this.owned.record.token)
          throw recovery(this.transitionPath);
        if (current.dev === staged.dev && current.ino === staged.ino) {
          if (
            !previousDirectory ||
            path.dirname(path.resolve(previousDirectory)) !== path.dirname(this.directory) ||
            !path.basename(previousDirectory).startsWith(path.basename(this.directory) + ".before-recovery-")
          )
            throw recovery(this.transitionPath);
          await removeOwned(this.owned, path.join(previousDirectory, instanceName));
          await removeOwned(gate, path.join(previousDirectory, gateName));
          this.owned = { ...staged, file: path.join(this.directory, instanceName) };
        } else if (current.dev === this.owned.dev && current.ino === this.owned.ino) {
          await removeOwned(gate); // Restore failed before activation or rolled the directory back.
        } else throw recovery(this.transitionPath);
        await removeOwned(transition);
        this.replacing = false;
        finished = true;
      },
    };
  }
}
export async function acquireInstanceLock(directory: string, purpose = "control"): Promise<InstanceLock> {
  const resolved = path.resolve(directory);
  const parent = await realpath(path.dirname(resolved));
  const base = path.basename(resolved);
  if (!base || base === path.parse(resolved).root)
    throw new OperationError("lock_path", "Ein eigenes Datenverzeichnis ist erforderlich.");
  const target = path.join(parent, base);
  const transitionPath = path.join(parent, `.${base}.ironcrew-directory.lock`);
  let exists = false;
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new OperationError("lock_path", "Datenverzeichnis muss ein reguläres Verzeichnis sein.");
    exists = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!exists) {
    // Creating a data directory and replacing one share this parent guard. Existing service installations need no parent write rights.
    const transition = await guard(transitionPath);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await removeOwned(transition);
    }
  }
  await assertNoTransition(transitionPath);
  const gate = await guard(path.join(target, gateName));
  try {
    await assertNoTransition(transitionPath);
    const file = path.join(target, instanceName),
      old = await inspect(file);
    if (old) {
      if (alive(old.record.pid))
        throw new OperationError(
          "instance_running",
          `Zentrale oder Offline-Wartung mit PID ${old.record.pid} besitzt ${file}. Diesen Prozess zuerst regulär beenden.`,
        );
      // No other cooperating acquirer can replace the observed file while this gate is held.
      const current = await inspect(file);
      if (!current || current.dev !== old.dev || current.ino !== old.ino) throw recovery(file);
      await unlink(file);
    }
    const owned = await create(file, record(purpose));
    return new InstanceLock(target, owned, transitionPath);
  } finally {
    await removeOwned(gate);
  }
}
