import { describe, it, expect } from "vitest";
import { createTestDb } from "./test-db.ts";

describe("migration 0011 — the shape after the split", () => {
  it("adds the pairing columns and removes the ones that moved", () => {
    const db = createTestDb();
    const cols = (db.prepare("PRAGMA table_info(crew_agents)").all() as Array<{ name: string }>).map((c) => c.name);

    expect(cols).toEqual(expect.arrayContaining(["vessel_id", "talent_id"]));
    for (const gone of [
      "professional_role",
      "role_summary",
      "seniority",
      "policy_json",
      "persona_json",
      "runtime_provider",
      "runtime_profile",
    ]) {
      expect(cols, `${gone} should have moved out of crew_agents`).not.toContain(gone);
    }
    db.close();
  });

  it("gives a vessel no way to grant permission", () => {
    // Not an omission to fill in later: permission modes come from a
    // SandboxGrant tied to an approval (THREAT_MODEL T-01). A vessel column
    // saying "elevated" would be a second route to elevation.
    const db = createTestDb();
    const cols = (db.prepare("PRAGMA table_info(crew_vessels)").all() as Array<{ name: string }>).map((c) => c.name);

    for (const forbidden of ["permission_mode", "sandbox", "allowed_tools", "policy_json", "grant_id"]) {
      expect(cols).not.toContain(forbidden);
    }
    db.close();
  });
});
