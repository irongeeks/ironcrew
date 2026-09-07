import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import path from "node:path";
import { lstat, realpath, unlink, mkdtemp, rename, link, rmdir, chmod } from "node:fs/promises";
import { hashFile, OperationError } from "./common.ts";
const absolute = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"));
export const maintenanceWindowSchema = z
  .object({ cron: z.string().min(1), timezone: z.string().min(1), durationMinutes: z.number().int().min(1).max(240) })
  .strict();
export const backupPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    recipient: z.string().regex(/^age1[0-9a-z]{20,100}$/),
    ageExecutable: absolute,
    destination: absolute,
    retention: z
      .object({
        enabled: z.boolean().default(false),
        daily: z.number().int().min(1).max(365).default(7),
        weekly: z.number().int().min(0).max(104).default(4),
      })
      .strict()
      .default({ enabled: false, daily: 7, weekly: 4 }),
  })
  .strict();
export type BackupPolicyInput = z.infer<typeof backupPolicySchema>;
export const updatePolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    trustedPublicKeyPem: z.string().min(40).max(16000),
    installDirectory: absolute,
    backupPolicyId: z.uuid(),
    autoApplyApproved: z.boolean().optional(),
    allowedClasses: z
      .array(z.enum(["patch", "minor", "major"]))
      .min(1)
      .max(3)
      .default(["patch"]),
    window: maintenanceWindowSchema,
  })
  .strict();
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
export function nextMaintenance(cron: string, timezone: string, after: Date): string {
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  if (cron.trim().split(/\s+/).length !== 5)
    throw new OperationError("maintenance_cron", "Fünfteiliger Cron-Ausdruck ist erforderlich.");
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toISOString()!;
}
export function inMaintenanceWindow(window: z.infer<typeof maintenanceWindowSchema>, at: Date): boolean {
  nextMaintenance(window.cron, window.timezone, at);
  const start = CronExpressionParser.parse(window.cron, {
    tz: window.timezone,
    currentDate: new Date(at.getTime() + 1),
  })
    .prev()
    .toDate();
  return at.getTime() >= start.getTime() && at.getTime() < start.getTime() + window.durationMinutes * 60000;
}
export function localSlot(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}
export function updateClass(current: string, next: string): "patch" | "minor" | "major" {
  const parse = (value: string) => {
    const parts = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(value);
    if (!parts) throw new OperationError("update_version", "Semantische Releaseversion erforderlich.");
    return parts.slice(1, 4).map(Number);
  };
  const before = parse(current),
    after = parse(next);
  if (after[0] > before[0]) return "major";
  if (after[0] === before[0] && after[1] > before[1]) return "minor";
  if (after[0] === before[0] && after[1] === before[1] && after[2] > before[2]) return "patch";
  throw new OperationError(
    "update_version",
    "Update muss eine höhere Version haben; Downgrade benötigt gesonderten Rückweg.",
  );
}
export interface OwnedArchive {
  id: string;
  archivePath: string;
  sha256: string;
  createdAt: string;
  state: "available" | "deleted";
}
/** Keeps newest archive in each of the newest configured local days/weeks, plus explicitly pinned probe evidence. */
export function retentionCandidates(
  archives: OwnedArchive[],
  policy: BackupPolicyInput,
  pinnedIds: string[] = [],
): OwnedArchive[] {
  if (!policy.retention.enabled) return [];
  const sorted = archives
    .filter((archive) => archive.state === "available")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set(pinnedIds),
    days = new Set<string>(),
    weeks = new Set<string>();
  for (const archive of sorted) {
    const day = localSlot(new Date(archive.createdAt), policy.timezone).slice(0, 10);
    const date = new Date(day + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = date.toISOString().slice(0, 10);
    if (!days.has(day) && days.size < policy.retention.daily) {
      days.add(day);
      keep.add(archive.id);
    }
    if (!weeks.has(week) && weeks.size < policy.retention.weekly) {
      weeks.add(week);
      keep.add(archive.id);
    }
  }
  return sorted.filter((archive) => !keep.has(archive.id));
}
export async function verifyOwnedArchive(archive: OwnedArchive, destination: string): Promise<void> {
  const base = await realpath(destination);
  const file = path.resolve(archive.archivePath);
  if (path.dirname(file) !== base || !/^ironcrew-[A-Za-z0-9:_.-]+\.tar\.age$/.test(path.basename(file)))
    throw new OperationError("archive_ownership", "Archiv liegt nicht in der registrierten eigenen Ablage.");
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (await realpath(file)) !== file ||
    (await hashFile(file)) !== archive.sha256
  )
    throw new OperationError("archive_hash", "Registriertes Archiv wurde ersetzt oder verändert; keine Löschung.");
}
export async function deleteOwnedArchive(archive: OwnedArchive, destination: string): Promise<void> {
  await verifyOwnedArchive(archive, destination);
  const prior = await lstat(archive.archivePath);
  const quarantine = await mkdtemp(path.join(await realpath(destination), ".retention-"));
  await chmod(quarantine, 0o700);
  const staged = path.join(quarantine, "archive.tar.age");
  let moved = false;
  try {
    await rename(archive.archivePath, staged);
    moved = true;
    const current = await lstat(staged);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== prior.dev ||
      current.ino !== prior.ino ||
      (await hashFile(staged)) !== archive.sha256
    )
      throw new OperationError("archive_hash", "Archiv wurde vor dem Löschen ersetzt; Datei bleibt erhalten.");
    await unlink(staged);
    moved = false;
  } finally {
    if (moved) {
      // link is exclusive: never overwrite a concurrently created file at the original path.
      try {
        await link(staged, archive.archivePath);
        await unlink(staged);
        moved = false;
      } catch {
        /* Keep the quarantined bytes if their original name is already occupied. */
      }
    }
    if (!moved) await rmdir(quarantine);
  }
}
