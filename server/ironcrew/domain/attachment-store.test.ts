import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { AttachmentStore, AttachmentMutationError } from "./attachment-store.ts";
import { TaskStore } from "./task-store.ts";
import { ProjectStore } from "./project-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: AttachmentStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new AttachmentStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

function blobInput(overrides: Partial<Parameters<AttachmentStore["create"]>[0]> = {}) {
  return {
    companyId,
    filename: "report.pdf",
    sizeBytes: 1234,
    storageKey: `${companyId}/deadbeef`,
    sha256: "deadbeef",
    ...overrides,
  };
}

describe("create — general document store", () => {
  it("creates a general attachment when neither task nor project is given", () => {
    const a = store.create(blobInput());
    expect(a.task_id).toBeNull();
    expect(a.project_id).toBeNull();
    expect(a.filename).toBe("report.pdf");
    expect(a.content_type).toBe("application/octet-stream");
  });

  it("rejects an empty filename", () => {
    expect(() => store.create(blobInput({ filename: "  " }))).toThrow(AttachmentMutationError);
  });

  it("rejects a negative size", () => {
    expect(() => store.create(blobInput({ sizeBytes: -1 }))).toThrow(AttachmentMutationError);
  });
});

describe("create — task/project scoping", () => {
  it("scopes to a real task in the same company", () => {
    const task = new TaskStore(db).create({ companyId, title: "Do the thing" });
    const a = store.create(blobInput({ taskId: task.id }));
    expect(a.task_id).toBe(task.id);
    expect(a.project_id).toBeNull();
  });

  it("scopes to a real project in the same company", () => {
    const project = new ProjectStore(db).create({ companyId, title: "Launch" });
    const a = store.create(blobInput({ projectId: project.id }));
    expect(a.project_id).toBe(project.id);
    expect(a.task_id).toBeNull();
  });

  it("rejects both task and project set at once", () => {
    const task = new TaskStore(db).create({ companyId, title: "T" });
    const project = new ProjectStore(db).create({ companyId, title: "P" });
    expect(() => store.create(blobInput({ taskId: task.id, projectId: project.id }))).toThrow(AttachmentMutationError);
  });

  it("rejects a task that does not exist", () => {
    expect(() => store.create(blobInput({ taskId: "task_nope" }))).toThrow(AttachmentMutationError);
  });

  it("rejects a task from a different company", () => {
    const other = seedCompany(db, "Other Co");
    const task = new TaskStore(db).create({ companyId: other, title: "T" });
    expect(() => store.create(blobInput({ taskId: task.id }))).toThrow(AttachmentMutationError);
  });

  it("rejects a project that does not exist", () => {
    expect(() => store.create(blobInput({ projectId: "prj_nope" }))).toThrow(AttachmentMutationError);
  });

  it("rejects a project from a different company", () => {
    const other = seedCompany(db, "Other Co");
    const project = new ProjectStore(db).create({ companyId: other, title: "P" });
    expect(() => store.create(blobInput({ projectId: project.id }))).toThrow(AttachmentMutationError);
  });
});

describe("listing", () => {
  it("listForTask / listForProject / listGeneral partition correctly", () => {
    const task = new TaskStore(db).create({ companyId, title: "T" });
    const project = new ProjectStore(db).create({ companyId, title: "P" });
    store.create(blobInput({ taskId: task.id, filename: "task-file" }));
    store.create(blobInput({ projectId: project.id, filename: "project-file" }));
    store.create(blobInput({ filename: "general-file" }));

    expect(store.listForTask(companyId, task.id).map((a) => a.filename)).toEqual(["task-file"]);
    expect(store.listForProject(companyId, project.id).map((a) => a.filename)).toEqual(["project-file"]);
    expect(store.listGeneral(companyId).map((a) => a.filename)).toEqual(["general-file"]);
  });

  it("newest first", () => {
    store.create(blobInput({ filename: "first", storageKey: `${companyId}/aaa`, sha256: "aaa" }));
    store.create(blobInput({ filename: "second", storageKey: `${companyId}/bbb`, sha256: "bbb" }));
    const names = store.listGeneral(companyId).map((a) => a.filename);
    expect(names).toEqual(["second", "first"]);
  });
});

describe("delete + orphan tracking", () => {
  it("deletes a row and returns it", () => {
    const a = store.create(blobInput());
    const deleted = store.delete(a.id);
    expect(deleted?.id).toBe(a.id);
    expect(store.get(a.id)).toBeNull();
  });

  it("returns null for a missing id", () => {
    expect(store.delete("att_nope")).toBeNull();
  });

  it("isStorageKeyOrphaned is true once the last referencing row is gone", () => {
    const a = store.create(blobInput());
    expect(store.isStorageKeyOrphaned(a.storage_key)).toBe(false);
    store.delete(a.id);
    expect(store.isStorageKeyOrphaned(a.storage_key)).toBe(true);
  });

  it("isStorageKeyOrphaned stays false while a sibling row still shares the key (de-duplicated content)", () => {
    const key = `${companyId}/shared`;
    const a = store.create(blobInput({ filename: "a", storageKey: key, sha256: "shared" }));
    store.create(blobInput({ filename: "b", storageKey: key, sha256: "shared" }));
    store.delete(a.id);
    expect(store.isStorageKeyOrphaned(key)).toBe(false);
  });
});

describe("audit trail", () => {
  it("audits upload and delete, and the chain stays valid", () => {
    const a = store.create(blobInput());
    store.delete(a.id);
    const result = verifyAuditChain(db, companyId);
    expect(result.valid).toBe(true);

    const actions = db
      .prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC")
      .all(companyId) as Array<{ action: string }>;
    expect(actions.map((r) => r.action)).toEqual(["attachment.uploaded", "attachment.deleted"]);
  });
});
