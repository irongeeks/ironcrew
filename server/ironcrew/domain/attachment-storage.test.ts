import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AttachmentStorage } from "./attachment-storage.ts";

let dir: string;
let storage: AttachmentStorage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-attach-"));
  storage = new AttachmentStorage(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AttachmentStorage", () => {
  it("creates the root directory on construction", () => {
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("writes a blob and reads it back byte-for-byte", () => {
    const buf = Buffer.from("hello world");
    const blob = storage.write("cmp_1", buf);
    expect(blob.sizeBytes).toBe(buf.length);
    expect(blob.storageKey).toBe(`cmp_1/${blob.sha256}`);
    expect(storage.read(blob.storageKey)).toEqual(buf);
  });

  it("de-duplicates identical content under the same key", () => {
    const buf = Buffer.from("same content");
    const a = storage.write("cmp_1", buf);
    const b = storage.write("cmp_1", buf);
    expect(a.storageKey).toBe(b.storageKey);
  });

  it("gives different companies different keys for identical content", () => {
    const buf = Buffer.from("shared bytes");
    const a = storage.write("cmp_1", buf);
    const b = storage.write("cmp_2", buf);
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.sha256).toBe(b.sha256);
  });

  it("delete removes the blob; a second delete is a no-op", () => {
    const blob = storage.write("cmp_1", Buffer.from("x"));
    storage.delete(blob.storageKey);
    expect(() => storage.read(blob.storageKey)).toThrow();
    expect(() => storage.delete(blob.storageKey)).not.toThrow();
  });

  it("delete on a never-written key is a no-op, not an error", () => {
    expect(() => storage.delete("cmp_1/deadbeef")).not.toThrow();
  });

  it("refuses to resolve a storage key that would escape the root", () => {
    expect(() => storage.read("../../etc/passwd")).toThrow(/outside the attachments root/);
    expect(() => storage.delete("../../etc/passwd")).toThrow(/outside the attachments root/);
  });
});
