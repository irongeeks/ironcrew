import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { ChangeProposalError, ChangeProposalStore, sha256 } from "./change-proposal-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let companyId: string;
let agentId: string;
let store: ChangeProposalStore;
let workspace: string;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  store = new ChangeProposalStore(db);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-ws-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function write(relative: string, content: string) {
  const abs = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

function read(relative: string) {
  return fs.readFileSync(path.join(workspace, relative), "utf-8");
}

function propose(files: Parameters<ChangeProposalStore["create"]>[0]["files"], title = "Konfiguration anpassen") {
  return store.create({ companyId, agentId, title, workspacePath: workspace, files });
}

describe("ChangeProposalStore", () => {
  describe("no approval, no apply", () => {
    it("refuses to apply a pending proposal", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "neu" }]);

      // There is no force flag — a force flag is how a gate stops being one.
      expect(() => store.apply(p.id)).toThrow(/Only an approved proposal/);
      expect(fs.existsSync(path.join(workspace, "a.txt"))).toBe(false);
    });

    it("refuses to apply a rejected proposal", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "neu" }]);
      store.decide(p.id, "rejected");

      expect(() => store.apply(p.id)).toThrow(/Only an approved proposal/);
      expect(fs.existsSync(path.join(workspace, "a.txt"))).toBe(false);
    });

    it("writes once approved", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "neu" }]);
      store.decide(p.id, "approved");

      const result = store.apply(p.id);
      expect(result.applied).toEqual(["a.txt"]);
      expect(read("a.txt")).toBe("neu");
      expect(result.proposal.status).toBe("applied");
    });

    it("is idempotent — applying twice does not write twice", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "erst" }]);
      store.decide(p.id, "approved");
      store.apply(p.id);

      write("a.txt", "jemand hat das danach geändert");
      const second = store.apply(p.id);

      expect(second.applied).toEqual([]);
      expect(read("a.txt")).toBe("jemand hat das danach geändert");
    });

    it("only lets a pending proposal be decided", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "x" }]);
      store.decide(p.id, "approved");
      expect(() => store.decide(p.id, "rejected")).toThrow(ChangeProposalError);
    });
  });

  describe("the world must not have moved", () => {
    it("refuses an update when the file changed since the proposal", () => {
      write("config.yaml", "port: 8080");
      const p = propose([{ path: "config.yaml", operation: "update", content: "port: 9090" }]);
      store.decide(p.id, "approved");

      // Someone edited it between approval and apply. The approval described
      // a change against a state that no longer holds.
      write("config.yaml", "port: 8080\nextra: von Hand ergänzt");

      const result = store.apply(p.id);
      expect(result.applied).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].path).toBe("config.yaml");
      expect(result.conflicts[0].reason).toMatch(/geändert/);
      // Nothing was clobbered.
      expect(read("config.yaml")).toContain("von Hand ergänzt");
      expect(result.proposal.status).toBe("failed");
    });

    it("applies an update when the file is untouched", () => {
      write("config.yaml", "port: 8080");
      const p = propose([{ path: "config.yaml", operation: "update", content: "port: 9090" }]);
      store.decide(p.id, "approved");

      expect(store.apply(p.id).applied).toEqual(["config.yaml"]);
      expect(read("config.yaml")).toBe("port: 9090");
    });

    it("honours an explicitly supplied expected hash", () => {
      write("config.yaml", "port: 8080");
      const p = propose([
        {
          path: "config.yaml",
          operation: "update",
          content: "port: 9090",
          expectedSha256: sha256("etwas ganz anderes"),
        },
      ]);
      store.decide(p.id, "approved");

      expect(store.apply(p.id).conflicts).toHaveLength(1);
    });

    it("refuses a create when the file already exists", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "neu" }]);
      store.decide(p.id, "approved");
      write("a.txt", "war schon da");

      // "Create" that quietly overwrites is a different act than the approved one.
      const result = store.apply(p.id);
      expect(result.conflicts[0].reason).toMatch(/existiert bereits/);
      expect(read("a.txt")).toBe("war schon da");
    });

    it("refuses an update or delete when the file is gone", () => {
      write("a.txt", "da");
      const p = propose([{ path: "a.txt", operation: "update", content: "neu" }]);
      store.decide(p.id, "approved");
      fs.rmSync(path.join(workspace, "a.txt"));

      expect(store.apply(p.id).conflicts[0].reason).toMatch(/existiert nicht mehr/);
    });
  });

  describe("all or nothing", () => {
    it("writes nothing when any file conflicts", () => {
      write("ok.txt", "alt");
      write("konflikt.txt", "alt");
      const p = propose([
        { path: "ok.txt", operation: "update", content: "neu-ok" },
        { path: "konflikt.txt", operation: "update", content: "neu-konflikt" },
      ]);
      store.decide(p.id, "approved");

      write("konflikt.txt", "von Hand geändert");
      const result = store.apply(p.id);

      expect(result.applied).toEqual([]);
      // The file that *could* have applied was left alone too: a half-applied
      // change set is worse than none.
      expect(read("ok.txt")).toBe("alt");
      expect(read("konflikt.txt")).toBe("von Hand geändert");
    });

    it("applies every file when all of them are clean", () => {
      write("b.txt", "alt");
      const p = propose([
        { path: "a.txt", operation: "create", content: "A" },
        { path: "b.txt", operation: "update", content: "B" },
        { path: "nested/deep/c.txt", operation: "create", content: "C" },
      ]);
      store.decide(p.id, "approved");

      expect(store.apply(p.id).applied.sort()).toEqual(["a.txt", "b.txt", "nested/deep/c.txt"]);
      expect(read("a.txt")).toBe("A");
      expect(read("b.txt")).toBe("B");
      expect(read("nested/deep/c.txt")).toBe("C");
    });

    it("deletes a file it was approved to delete", () => {
      write("weg.txt", "inhalt");
      const p = propose([{ path: "weg.txt", operation: "delete" }]);
      store.decide(p.id, "approved");

      expect(store.apply(p.id).applied).toEqual(["weg.txt"]);
      expect(fs.existsSync(path.join(workspace, "weg.txt"))).toBe(false);
    });
  });

  describe("nothing leaves the workspace", () => {
    it("refuses a path that climbs out", () => {
      for (const bad of ["../escape.txt", "a/../../escape.txt", "./../../etc/passwd"]) {
        expect(() => propose([{ path: bad, operation: "create", content: "x" }])).toThrow(/outside the workspace/);
      }
    });

    it("refuses an absolute path", () => {
      expect(() => propose([{ path: "/etc/passwd", operation: "create", content: "x" }])).toThrow(/absolute/);
    });

    it("refuses a path that escapes through a symlinked directory", () => {
      // The string check alone would pass this; only resolving the real
      // directory catches it.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-outside-"));
      try {
        fs.symlinkSync(outside, path.join(workspace, "link"));
        expect(() => propose([{ path: "link/pwned.txt", operation: "create", content: "x" }])).toThrow(
          /outside the workspace/,
        );
        expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("writes nothing to the database when a path is refused", () => {
      expect(() =>
        propose([
          { path: "gut.txt", operation: "create", content: "x" },
          { path: "../boese.txt", operation: "create", content: "x" },
        ]),
      ).toThrow();

      // The valid half must not survive as an orphan proposal.
      expect(store.list(companyId)).toHaveLength(0);
    });
  });

  describe("bookkeeping", () => {
    it("rejects a proposal with no files, no title, or a duplicate path", () => {
      expect(() => store.create({ companyId, title: "x", workspacePath: workspace, files: [] })).toThrow(
        /at least one file/,
      );
      expect(() =>
        store.create({
          companyId,
          title: "  ",
          workspacePath: workspace,
          files: [{ path: "a", operation: "create", content: "" }],
        }),
      ).toThrow(/needs a title/);
      expect(() =>
        propose([
          { path: "a.txt", operation: "create", content: "1" },
          { path: "a.txt", operation: "update", content: "2" },
        ]),
      ).toThrow(/proposed twice/);
    });

    it("rejects a create or update with no content at all", () => {
      expect(() => propose([{ path: "a.txt", operation: "create" }])).toThrow(/carries no content/);
    });

    it("records the content hash actually written", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "inhalt" }]);
      store.decide(p.id, "approved");
      store.apply(p.id);

      expect(store.files(p.id)[0].applied_sha256).toBe(sha256("inhalt"));
    });

    it("lists by status", () => {
      const a = propose([{ path: "a.txt", operation: "create", content: "1" }], "A");
      propose([{ path: "b.txt", operation: "create", content: "2" }], "B");
      store.decide(a.id, "approved");

      expect(store.list(companyId)).toHaveLength(2);
      expect(store.list(companyId, { status: "approved" }).map((p) => p.title)).toEqual(["A"]);
      expect(store.list(companyId, { status: "pending" }).map((p) => p.title)).toEqual(["B"]);
    });

    it("supersedes a proposal that was overtaken, but never an applied one", () => {
      const p = propose([{ path: "a.txt", operation: "create", content: "1" }]);
      expect(store.supersede(p.id)?.status).toBe("superseded");

      const q = propose([{ path: "b.txt", operation: "create", content: "2" }]);
      store.decide(q.id, "approved");
      store.apply(q.id);
      // It already happened; calling it superseded would be a lie.
      expect(() => store.supersede(q.id)).toThrow(/already happened/);
    });

    it("audits the lifecycle without putting file contents in the log", () => {
      const p = propose([{ path: "geheim.txt", operation: "create", content: "SEHR-GEHEIMER-INHALT" }]);
      store.decide(p.id, "approved");
      store.apply(p.id);

      const rows = db
        .prepare("SELECT action, details_json FROM crew_audit_events WHERE company_id = ? ORDER BY seq")
        .all(companyId) as Array<{ action: string; details_json: string }>;

      expect(rows.map((r) => r.action)).toEqual([
        "change_proposal.created",
        "change_proposal.approved",
        "change_proposal.applied",
      ]);
      // An audit log is not a place to duplicate a repository.
      for (const row of rows) {
        expect(row.details_json).not.toContain("SEHR-GEHEIMER-INHALT");
      }
      expect(rows[0].details_json).toContain("geheim.txt");
      expect(verifyAuditChain(db, companyId).valid).toBe(true);
    });

    it("returns null for a proposal that does not exist", () => {
      expect(store.get("chg_nope")).toBeNull();
      expect(store.decide("chg_nope", "approved")).toBeNull();
      expect(store.supersede("chg_nope")).toBeNull();
      expect(() => store.apply("chg_nope")).toThrow(/does not exist/);
    });
  });
});
