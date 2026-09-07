import { it, expect } from "vitest";
import {
  nextMaintenance,
  inMaintenanceWindow,
  retentionCandidates,
  backupPolicySchema,
  updateClass,
} from "../../packages/operations/src/maintenance.ts";
it("evaluates IANA wall-clock windows across DST and rejects second-level cron", () => {
  expect(nextMaintenance("30 2 * * *", "Europe/Berlin", new Date("2026-10-24T23:00:00Z"))).toBe(
    "2026-10-25T00:30:00.000Z",
  );
  expect(
    inMaintenanceWindow(
      { cron: "30 2 * * *", timezone: "Europe/Berlin", durationMinutes: 30 },
      new Date("2026-10-25T00:40:00Z"),
    ),
  ).toBe(true);
  expect(
    inMaintenanceWindow(
      { cron: "30 2 * * *", timezone: "Europe/Berlin", durationMinutes: 30 },
      new Date("2026-10-25T01:20:00Z"),
    ),
  ).toBe(false);
  expect(() => nextMaintenance("* * * * * *", "UTC", new Date())).toThrow();
});
it("keeps distinct daily and weekly representatives plus pinned evidence, and retention defaults disabled", () => {
  const policy = backupPolicySchema.parse({
    name: "Fixture",
    cron: "0 2 * * *",
    timezone: "UTC",
    recipient: "age1" + "a".repeat(40),
    ageExecutable: "/fixture/age",
    destination: "/fixture/backups",
  });
  const archives = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    archivePath: "/fixture/" + i,
    sha256: "a".repeat(64),
    state: "available" as const,
    createdAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
  }));
  expect(retentionCandidates(archives, policy)).toEqual([]);
  const candidates = retentionCandidates(archives, { ...policy, retention: { enabled: true, daily: 7, weekly: 4 } }, [
    "0",
  ]);
  expect(candidates.some((a) => a.id === "0")).toBe(false);
  expect(candidates.some((a) => a.id === "39")).toBe(false);
  expect(candidates.length).toBeGreaterThan(25);
});
it("classifies higher semantic versions and refuses downgrade", () => {
  expect(updateClass("0.4.0", "0.4.1")).toBe("patch");
  expect(updateClass("0.4.0", "0.5.0")).toBe("minor");
  expect(() => updateClass("0.4.1", "0.4.0")).toThrow();
});
