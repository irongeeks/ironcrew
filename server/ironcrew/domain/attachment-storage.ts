/**
 * IronCrew — attachment blob storage (filesystem).
 *
 * Blob content lives under a generated, content-addressed key
 * ("<companyId>/<sha256 hex>") — never the user-supplied filename, so a
 * crafted filename (e.g. "../../etc/passwd") can never become part of a
 * path. `crew_attachments.storage_key` is exactly this key; the original
 * filename is preserved separately in the DB row for display/download only.
 *
 * Content-addressing also gives free de-duplication: uploading the same
 * bytes twice writes the file once. That means more than one row can
 * reference the same storage_key, so deleting a row must not delete the
 * blob out from under a sibling row still using it — see
 * AttachmentStore.isStorageKeyOrphaned(), which CompanyOrchestrator checks
 * before calling delete() here.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface StoredBlob {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

export class AttachmentStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  write(companyId: string, buffer: Buffer): StoredBlob {
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const storageKey = `${companyId}/${sha256}`;
    const filePath = this.resolve(storageKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
    return { storageKey, sha256, sizeBytes: buffer.length };
  }

  read(storageKey: string): Buffer {
    return fs.readFileSync(this.resolve(storageKey));
  }

  /** Idempotent: deleting an already-missing blob is not an error. */
  delete(storageKey: string): void {
    try {
      fs.unlinkSync(this.resolve(storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private resolve(storageKey: string): string {
    const filePath = path.resolve(this.rootDir, storageKey);
    // storageKey is always produced by write() above ("<companyId>/<hex
    // digest>", both server-generated, never raw user input) — a traversal
    // segment can't reach here in practice. Still asserted as defense in
    // depth, the same posture run-cli.ts and the CliAdapterRuntime take
    // toward their own inputs.
    if (filePath !== this.rootDir && !filePath.startsWith(this.rootDir + path.sep)) {
      throw new Error(`Refusing to resolve a storage key outside the attachments root: "${storageKey}"`);
    }
    return filePath;
  }
}
