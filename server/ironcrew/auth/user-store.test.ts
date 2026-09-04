import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { MIN_PASSWORD_LENGTH, UserMutationError, UserStore, type UserRow } from "./user-store.ts";

let db: DatabaseSync;
let companyId: string;
let users: UserStore;

const OWNER_PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "another perfectly fine passphrase";

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  users = new UserStore(db);
});

afterEach(() => db.close());

function storedHash(id: string): string {
  const row = db.prepare("SELECT password_hash FROM crew_users WHERE id = ?").get(id) as { password_hash: string };
  return row.password_hash;
}

function auditActions(): string[] {
  return (db.prepare("SELECT action FROM crew_audit_events ORDER BY seq ASC").all() as Array<{ action: string }>).map(
    (r) => r.action,
  );
}

function auditDetails(action: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT details_json FROM crew_audit_events WHERE action = ? ORDER BY seq DESC LIMIT 1")
    .get(action) as { details_json: string } | undefined;
  return row ? (JSON.parse(row.details_json) as Record<string, unknown>) : {};
}

/** The first account bootstraps the install, so it is an owner by default. */
async function seedOwner(email = "owner@example.com"): Promise<UserRow> {
  return users.create({ email, password: OWNER_PASSWORD, displayName: "Owner" }, { companyId });
}

describe("UserStore", () => {
  describe("the shape is the guarantee", () => {
    it("never puts password_hash on a row any read path returns", async () => {
      const created = await seedOwner();
      await users.setPassword(created.id, OTHER_PASSWORD, { companyId });
      const rows = [
        created,
        users.get(created.id)!,
        users.byEmail("owner@example.com")!,
        ...users.list(),
        users.update(created.id, { displayName: "Chef" }, { companyId })!,
        (await users.authenticate("owner@example.com", OTHER_PASSWORD))!,
      ];

      for (const row of rows) {
        expect(Object.keys(row)).not.toContain("password_hash");
      }
    });

    it("cannot leak the hash or the plaintext through JSON.stringify", async () => {
      const created = await seedOwner();
      const hash = storedHash(created.id);
      expect(hash).toMatch(/^scrypt:/);

      const serialised = JSON.stringify([created, users.get(created.id), users.list()]);
      expect(serialised).not.toContain(hash);
      expect(serialised).not.toContain(OWNER_PASSWORD);
      // The salt alone is enough to make a targeted rainbow table.
      expect(serialised).not.toContain(hash.split(":")[1]);
    });
  });

  describe("email is case-insensitive and stored lowercased", () => {
    it("lowercases on the way in", async () => {
      const created = await users.create({ email: "  Robert@Example.COM ", password: OWNER_PASSWORD }, { companyId });
      expect(created.email).toBe("robert@example.com");
    });

    it("finds an account regardless of how the email is typed", async () => {
      const created = await users.create({ email: "Robert@Example.com", password: OWNER_PASSWORD }, { companyId });
      expect(users.byEmail("ROBERT@EXAMPLE.COM")?.id).toBe(created.id);
      expect((await users.authenticate("RoBeRt@ExAmPlE.com", OWNER_PASSWORD))?.id).toBe(created.id);
    });

    it("refuses a second account that differs only in capitalisation", async () => {
      await users.create({ email: "robert@example.com", password: OWNER_PASSWORD }, { companyId });
      await expect(
        users.create({ email: "ROBERT@example.com", password: OTHER_PASSWORD }, { companyId }),
      ).rejects.toThrow(UserMutationError);
      expect(users.count()).toBe(1);
    });

    it("rejects an unusable email instead of storing it", async () => {
      for (const email of ["", "   ", "nope", "a b@example.com", "@example.com", "robert@"]) {
        await expect(users.create({ email, password: OWNER_PASSWORD }, { companyId })).rejects.toThrow(
          UserMutationError,
        );
      }
      expect(users.count()).toBe(0);
    });
  });

  describe("authenticate", () => {
    it("returns the user for correct credentials", async () => {
      const created = await seedOwner();
      const authed = await users.authenticate("owner@example.com", OWNER_PASSWORD);
      expect(authed?.id).toBe(created.id);
    });

    it("returns null identically for unknown email, wrong password and a disabled account", async () => {
      await seedOwner();
      // A second owner, so disabling the first is allowed.
      const other = await users.create(
        { email: "second@example.com", password: OTHER_PASSWORD, role: "owner" },
        { companyId },
      );
      users.update(other.id, { status: "disabled" }, { companyId });

      expect(await users.authenticate("nobody@example.com", OWNER_PASSWORD)).toBeNull();
      expect(await users.authenticate("owner@example.com", "the wrong passphrase")).toBeNull();
      expect(await users.authenticate("second@example.com", OTHER_PASSWORD)).toBeNull();
    });

    it("spends scrypt on an unknown email too, so 'no such account' is not instant", async () => {
      await seedOwner();

      const timeOf = async (fn: () => Promise<unknown>): Promise<number> => {
        const started = performance.now();
        await fn();
        return performance.now() - started;
      };
      // Both paths run a full scrypt verification; the unknown-email one uses
      // a dummy hash. A wide margin (4x) keeps this from flaking on a loaded
      // machine while still failing loudly if the dummy verification is ever
      // optimised away.
      const wrongPassword = await timeOf(() => users.authenticate("owner@example.com", "the wrong passphrase"));
      const unknownEmail = await timeOf(() => users.authenticate("nobody@example.com", "the wrong passphrase"));
      expect(unknownEmail).toBeGreaterThan(wrongPassword / 4);
    });

    it("records last_login_at on success", async () => {
      const created = await seedOwner();
      expect(created.last_login_at).toBeNull();

      const authed = await users.authenticate("owner@example.com", OWNER_PASSWORD, { now: 1_700_000_000_000 });
      expect(authed?.last_login_at).toBe(1_700_000_000_000);
      expect(users.get(created.id)?.last_login_at).toBe(1_700_000_000_000);
    });

    it("changes nothing on a failed attempt", async () => {
      const created = await seedOwner();
      await users.authenticate("owner@example.com", OWNER_PASSWORD, { now: 1_700_000_000_000 });
      const before = users.get(created.id)!;

      expect(await users.authenticate("owner@example.com", "wrong", { now: 1_800_000_000_000 })).toBeNull();
      expect(await users.authenticate("nobody@example.com", OWNER_PASSWORD, { now: 1_800_000_000_000 })).toBeNull();
      expect(users.get(created.id)).toEqual(before);
    });

    it("does not treat signing in as an edit to the account record", async () => {
      const created = await seedOwner();
      await users.authenticate("owner@example.com", OWNER_PASSWORD, { now: 1_700_000_000_000 });
      expect(users.get(created.id)?.updated_at).toBe(created.updated_at);
    });
  });

  describe("there is always an owner", () => {
    it("refuses to demote the last active owner", async () => {
      const owner = await seedOwner();
      expect(() => users.update(owner.id, { role: "operator" }, { companyId })).toThrow(UserMutationError);
      expect(users.get(owner.id)?.role).toBe("owner");
    });

    it("refuses to disable the last active owner", async () => {
      const owner = await seedOwner();
      expect(() => users.update(owner.id, { status: "disabled" }, { companyId })).toThrow(UserMutationError);
      expect(users.get(owner.id)?.status).toBe("active");
    });

    it("refuses to delete the last active owner", async () => {
      const owner = await seedOwner();
      expect(() => users.delete(owner.id, { companyId })).toThrow(UserMutationError);
      expect(users.count()).toBe(1);
    });

    it("does not count a disabled owner as cover", async () => {
      const owner = await seedOwner();
      const spare = await users.create(
        { email: "spare@example.com", password: OTHER_PASSWORD, role: "owner" },
        { companyId },
      );
      users.update(spare.id, { status: "disabled" }, { companyId });

      expect(() => users.update(owner.id, { role: "viewer" }, { companyId })).toThrow(UserMutationError);
    });

    it("allows demoting an owner once a second active owner exists", async () => {
      const owner = await seedOwner();
      await users.create({ email: "spare@example.com", password: OTHER_PASSWORD, role: "owner" }, { companyId });

      expect(users.update(owner.id, { role: "operator" }, { companyId })?.role).toBe("operator");
      users.delete(owner.id, { companyId });
      expect(users.count()).toBe(1);
    });

    it("makes the very first account an owner, so an install cannot be born bricked", async () => {
      const first = await seedOwner();
      const second = await users.create({ email: "second@example.com", password: OTHER_PASSWORD }, { companyId });
      expect(first.role).toBe("owner");
      expect(second.role).toBe("viewer");
    });
  });

  describe("passwords", () => {
    it(`refuses anything shorter than ${MIN_PASSWORD_LENGTH} characters`, async () => {
      expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
      await expect(
        users.create({ email: "short@example.com", password: "a".repeat(MIN_PASSWORD_LENGTH - 1) }, { companyId }),
      ).rejects.toThrow(UserMutationError);
      // Rejected before any hashing happens: no row, and therefore no hash.
      expect(users.count()).toBe(0);
    });

    it("refuses an absurdly long password rather than hashing it", async () => {
      await expect(
        users.create({ email: "long@example.com", password: "a".repeat(5000) }, { companyId }),
      ).rejects.toThrow(UserMutationError);
      expect(await users.authenticate("long@example.com", "a".repeat(5000))).toBeNull();
    });

    it("leaves the old password working when a change is refused", async () => {
      const owner = await seedOwner();
      await expect(users.setPassword(owner.id, "tooshort", { companyId })).rejects.toThrow(UserMutationError);
      expect(await users.authenticate("owner@example.com", OWNER_PASSWORD)).not.toBeNull();
    });

    it("replaces the hash on setPassword and invalidates the old password", async () => {
      const owner = await seedOwner();
      const before = storedHash(owner.id);

      await users.setPassword(owner.id, OTHER_PASSWORD, { companyId });
      expect(storedHash(owner.id)).not.toBe(before);
      expect(await users.authenticate("owner@example.com", OWNER_PASSWORD)).toBeNull();
      expect(await users.authenticate("owner@example.com", OTHER_PASSWORD)).not.toBeNull();
    });

    it("salts, so two accounts with the same password do not share a hash", async () => {
      const a = await users.create({ email: "a@example.com", password: OWNER_PASSWORD }, { companyId });
      const b = await users.create({ email: "b@example.com", password: OWNER_PASSWORD }, { companyId });
      expect(storedHash(a.id)).not.toBe(storedHash(b.id));
    });

    it("returns null from setPassword for an unknown user", async () => {
      expect(await users.setPassword("usr_missing", OTHER_PASSWORD, { companyId })).toBeNull();
    });
  });

  describe("audit", () => {
    it("records the five governance events and keeps the chain valid", async () => {
      const owner = await seedOwner();
      const spare = await users.create(
        { email: "spare@example.com", password: OTHER_PASSWORD, role: "owner" },
        { companyId },
      );
      users.update(owner.id, { role: "operator" }, { companyId });
      users.update(owner.id, { status: "disabled" }, { companyId });
      await users.setPassword(spare.id, OWNER_PASSWORD, { companyId });
      users.delete(owner.id, { companyId });

      expect(auditActions()).toEqual([
        "user.created",
        "user.created",
        "user.role_changed",
        "user.disabled",
        "user.password_changed",
        "user.deleted",
      ]);
      expect(verifyAuditChain(db, companyId).valid).toBe(true);
    });

    it("never writes the password, its hash or its length into the chain", async () => {
      const owner = await seedOwner();
      const hash = storedHash(owner.id);
      await users.setPassword(owner.id, OTHER_PASSWORD, { companyId });

      const raw = (db.prepare("SELECT details_json FROM crew_audit_events").all() as Array<{ details_json: string }>)
        .map((r) => r.details_json)
        .join("\n");
      expect(raw).not.toContain(OWNER_PASSWORD);
      expect(raw).not.toContain(OTHER_PASSWORD);
      expect(raw).not.toContain(hash);
      expect(raw).not.toContain(hash.split(":")[1]);
      for (const details of [auditDetails("user.created"), auditDetails("user.password_changed")]) {
        expect(Object.keys(details)).not.toContain("password");
        expect(Object.keys(details)).not.toContain("passwordHash");
        expect(Object.keys(details)).not.toContain("password_hash");
        // Not even a length: it is a search-space hint handed to every reader
        // of the log.
        expect(Object.values(details)).not.toContain(OWNER_PASSWORD.length);
        expect(Object.values(details)).not.toContain(OTHER_PASSWORD.length);
      }
    });

    it("files under the single company row when the caller names none", async () => {
      const owner = await users.create({ email: "owner@example.com", password: OWNER_PASSWORD });
      expect(auditActions()).toEqual(["user.created"]);
      expect(verifyAuditChain(db, companyId).valid).toBe(true);
      expect(owner.role).toBe("owner");
    });

    it("still performs the mutation when there is no company to file under", async () => {
      const bare = createTestDb();
      try {
        const store = new UserStore(bare);
        const created = await store.create({ email: "owner@example.com", password: OWNER_PASSWORD });
        expect(store.get(created.id)).not.toBeNull();
        expect((bare.prepare("SELECT COUNT(*) AS n FROM crew_audit_events").get() as { n: number }).n).toBe(0);
      } finally {
        bare.close();
      }
    });

    it("audits a re-enable as well, so restoring access is not invisible", async () => {
      await seedOwner();
      const spare = await users.create({ email: "spare@example.com", password: OTHER_PASSWORD }, { companyId });
      users.update(spare.id, { status: "disabled" }, { companyId });
      users.update(spare.id, { status: "active" }, { companyId });
      expect(auditActions()).toContain("user.enabled");
    });
  });

  describe("reads and edits", () => {
    it("counts, lists in creation order and reads back by id", async () => {
      expect(users.count()).toBe(0);
      const first = await seedOwner();
      const second = await users.create({ email: "b@example.com", password: OTHER_PASSWORD }, { companyId });

      expect(users.count()).toBe(2);
      expect(users.list().map((u) => u.id)).toEqual([first.id, second.id]);
      expect(users.get(second.id)?.email).toBe("b@example.com");
      expect(users.get("usr_missing")).toBeNull();
      expect(users.byEmail("nobody@example.com")).toBeNull();
    });

    it("updates the display name without touching role or status", async () => {
      const owner = await seedOwner();
      const updated = users.update(owner.id, { displayName: "  Käpt'n  " }, { companyId })!;
      expect(updated.display_name).toBe("Käpt'n");
      expect(updated.role).toBe("owner");
      expect(updated.status).toBe("active");
      // Cosmetic edits stay out of the chain.
      expect(auditActions()).toEqual(["user.created"]);
    });

    it("returns null when updating an unknown user and stays quiet on deleting one", () => {
      expect(users.update("usr_missing", { role: "viewer" }, { companyId })).toBeNull();
      expect(() => users.delete("usr_missing", { companyId })).not.toThrow();
    });

    it("refuses an unknown role or status rather than letting SQLite decide", async () => {
      const owner = await seedOwner();
      expect(() => users.update(owner.id, { role: "admin" as never }, { companyId })).toThrow(UserMutationError);
      expect(() => users.update(owner.id, { status: "deleted" as never }, { companyId })).toThrow(UserMutationError);
      await expect(
        users.create({ email: "x@example.com", password: OTHER_PASSWORD, role: "root" as never }, { companyId }),
      ).rejects.toThrow(UserMutationError);
    });
  });
});
