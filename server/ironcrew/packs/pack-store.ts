/**
 * IronCrew — which packs are installed, and the receipt for each.
 *
 * Two tables, one idea (migration 0022): `crew_packs` says what is installed,
 * `crew_pack_objects` says exactly which departments, posts, tools and
 * routines *this installation* created. Uninstall reads the receipt rather
 * than re-deriving from the current definition, because a definition is code
 * and code changes — the version installed six months ago may have created a
 * department this version no longer mentions, and re-deriving would orphan
 * precisely the objects nobody remembers.
 *
 * The store does no policy. It records and it reports; deciding what to
 * create, what to reuse and what may be removed is the installer's job, and
 * keeping that out of here is what makes both testable.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { allRows, oneRow } from "../domain/sql.ts";

export const PACK_OBJECT_TYPES = ["department", "agent", "tool", "routine"] as const;
export type PackObjectType = (typeof PACK_OBJECT_TYPES)[number];

export interface PackRow {
  id: string;
  company_id: string;
  pack_key: string;
  version: string;
  installed_at: number;
  installed_by: string;
}

export interface PackObjectRow {
  id: string;
  pack_id: string;
  company_id: string;
  object_type: PackObjectType;
  object_id: string;
  object_key: string;
  created_at: number;
}

const PACK_COLUMNS = "id, company_id, pack_key, version, installed_at, installed_by";
const OBJECT_COLUMNS = "id, pack_id, company_id, object_type, object_id, object_key, created_at";

export class PackMutationError extends Error {}

export class PackStore {
  constructor(private readonly db: DatabaseSync) {}

  list(companyId: string): PackRow[] {
    return allRows<PackRow>(
      this.db.prepare(`SELECT ${PACK_COLUMNS} FROM crew_packs WHERE company_id = ? ORDER BY pack_key`),
      companyId,
    );
  }

  byKey(companyId: string, packKey: string): PackRow | null {
    return oneRow<PackRow>(
      this.db.prepare(`SELECT ${PACK_COLUMNS} FROM crew_packs WHERE company_id = ? AND pack_key = ?`),
      companyId,
      packKey,
    );
  }

  install(input: { companyId: string; packKey: string; version: string; installedBy?: string }): PackRow {
    if (this.byKey(input.companyId, input.packKey)) {
      throw new PackMutationError(`Pack "${input.packKey}" ist bereits installiert.`);
    }
    const id = newId("pack");
    this.db
      .prepare("INSERT INTO crew_packs (id, company_id, pack_key, version, installed_by) VALUES (?,?,?,?,?)")
      .run(id, input.companyId, input.packKey, input.version, input.installedBy ?? "ceo");
    return this.byKey(input.companyId, input.packKey)!;
  }

  /**
   * Records that this pack created this object.
   *
   * Silently does nothing when the object already belongs to a pack. That is
   * the unique index in migration 0022 expressed as behaviour: an object has
   * at most one owner, and a second pack wanting the same department reuses
   * it rather than claiming it — so uninstalling the second pack cannot take
   * away what the first one brought.
   */
  record(input: {
    packId: string;
    companyId: string;
    objectType: PackObjectType;
    objectId: string;
    objectKey: string;
  }): PackObjectRow | null {
    const existing = oneRow<PackObjectRow>(
      this.db.prepare(
        `SELECT ${OBJECT_COLUMNS} FROM crew_pack_objects
          WHERE company_id = ? AND object_type = ? AND object_id = ?`,
      ),
      input.companyId,
      input.objectType,
      input.objectId,
    );
    if (existing) return null;

    const id = newId("pobj");
    this.db
      .prepare(
        `INSERT INTO crew_pack_objects (id, pack_id, company_id, object_type, object_id, object_key)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, input.packId, input.companyId, input.objectType, input.objectId, input.objectKey);
    return oneRow<PackObjectRow>(this.db.prepare(`SELECT ${OBJECT_COLUMNS} FROM crew_pack_objects WHERE id = ?`), id);
  }

  objects(packId: string, objectType?: PackObjectType): PackObjectRow[] {
    if (objectType) {
      return allRows<PackObjectRow>(
        this.db.prepare(
          `SELECT ${OBJECT_COLUMNS} FROM crew_pack_objects WHERE pack_id = ? AND object_type = ? ORDER BY created_at`,
        ),
        packId,
        objectType,
      );
    }
    return allRows<PackObjectRow>(
      this.db.prepare(`SELECT ${OBJECT_COLUMNS} FROM crew_pack_objects WHERE pack_id = ? ORDER BY created_at`),
      packId,
    );
  }

  /** Which pack owns this object, if any. */
  ownerOf(companyId: string, objectType: PackObjectType, objectId: string): PackRow | null {
    return oneRow<PackRow>(
      this.db.prepare(
        `SELECT p.${PACK_COLUMNS.split(", ").join(", p.")}
           FROM crew_packs p
           JOIN crew_pack_objects o ON o.pack_id = p.id
          WHERE o.company_id = ? AND o.object_type = ? AND o.object_id = ?`,
      ),
      companyId,
      objectType,
      objectId,
    );
  }

  forgetObject(id: string): void {
    this.db.prepare("DELETE FROM crew_pack_objects WHERE id = ?").run(id);
  }

  /** Removes the pack row; the receipts go with it via ON DELETE CASCADE. */
  remove(companyId: string, packKey: string): void {
    this.db.prepare("DELETE FROM crew_packs WHERE company_id = ? AND pack_key = ?").run(companyId, packKey);
  }
}
