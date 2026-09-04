/**
 * IronCrew — marketplace sources and install provenance.
 *
 * Two things live here, and only these two:
 *
 *  - the sources an admin has added (a catalog URL, the MCP registry, a
 *    Claude-Code marketplace, a Git repo), plus the outcome of the last sync;
 *  - a record of what was installed from where.
 *
 * What it deliberately does NOT hold: the installed artefacts. An MCP server
 * belongs in the `settings` row McpManager owns, a skill in
 * `custom-skills/<name>/`. Duplicating them here would create a second source
 * of truth that drifts — so a marketplace-installed server is byte-identical
 * to a hand-added one, and this table only remembers where it came from.
 *
 * Catalog entries themselves are not cached: they are third-party JSON that
 * changes without notice, and a stale cache of installable commands is worse
 * than a fetch. Sources are read live, entry counts are the only trace kept.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import {
  MARKETPLACE_KINDS,
  type MarketplaceEntryType,
  type MarketplaceKind,
} from "../marketplace/marketplace-source.ts";

export { MARKETPLACE_KINDS };
export type { MarketplaceKind, MarketplaceEntryType };

export function isMarketplaceKind(value: unknown): value is MarketplaceKind {
  return (MARKETPLACE_KINDS as readonly string[]).includes(value as string);
}

export interface MarketplaceRow {
  id: string;
  company_id: string;
  name: string;
  kind: MarketplaceKind;
  url: string;
  enabled: number;
  last_synced_at: number | null;
  last_error: string;
  entry_count: number;
  created_at: number;
  updated_at: number;
}

const MARKETPLACE_COLUMNS = `id, company_id, name, kind, url, enabled, last_synced_at, last_error,
  entry_count, created_at, updated_at`;

export interface MarketplaceInstallRow {
  id: string;
  company_id: string;
  marketplace_id: string | null;
  entry_id: string;
  entry_type: MarketplaceEntryType;
  name: string;
  version: string;
  source_url: string;
  installed_by: string;
  manifest: string;
  installed_at: number;
}

const INSTALL_COLUMNS = `id, company_id, marketplace_id, entry_id, entry_type, name, version,
  source_url, installed_by, manifest, installed_at`;

export class MarketplaceMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceMutationError";
  }
}

export interface MarketplaceActor {
  actorType?: ActorType;
  actorId?: string;
}

export class MarketplaceStore {
  constructor(private readonly db: DatabaseSync) {}

  // --- sources -----------------------------------------------------------

  create(
    input: {
      companyId: string;
      name: string;
      kind: MarketplaceKind;
      url: string;
      enabled?: boolean;
    } & MarketplaceActor,
  ): MarketplaceRow {
    const name = input.name.trim();
    const url = input.url.trim();
    if (!name) throw new MarketplaceMutationError("A marketplace needs a name.");
    if (!url) throw new MarketplaceMutationError("A marketplace needs a URL.");
    if (!isMarketplaceKind(input.kind)) {
      throw new MarketplaceMutationError(`Unknown marketplace kind "${String(input.kind)}".`);
    }
    if (this.getByName(input.companyId, name)) {
      throw new MarketplaceMutationError(`A marketplace named "${name}" already exists.`);
    }

    const id = newId("mkt");
    this.db
      .prepare(
        `INSERT INTO crew_marketplaces (id, company_id, name, kind, url, enabled)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, input.companyId, name, input.kind, url, input.enabled === false ? 0 : 1);

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "marketplace.added",
      entityType: "marketplace",
      entityId: id,
      details: { name, kind: input.kind, url },
    });

    return this.get(id)!;
  }

  get(id: string): MarketplaceRow | null {
    return oneRow<MarketplaceRow>(
      this.db.prepare(`SELECT ${MARKETPLACE_COLUMNS} FROM crew_marketplaces WHERE id = ?`),
      id,
    );
  }

  getByName(companyId: string, name: string): MarketplaceRow | null {
    return oneRow<MarketplaceRow>(
      this.db.prepare(`SELECT ${MARKETPLACE_COLUMNS} FROM crew_marketplaces WHERE company_id = ? AND name = ?`),
      companyId,
      name,
    );
  }

  list(companyId: string): MarketplaceRow[] {
    return allRows<MarketplaceRow>(
      this.db.prepare(`SELECT ${MARKETPLACE_COLUMNS} FROM crew_marketplaces WHERE company_id = ? ORDER BY name`),
      companyId,
    );
  }

  update(
    id: string,
    patch: { name?: string; url?: string; enabled?: boolean },
    opts: MarketplaceActor = {},
  ): MarketplaceRow | null {
    const existing = this.get(id);
    if (!existing) return null;

    const name = patch.name?.trim() ?? existing.name;
    const url = patch.url?.trim() ?? existing.url;
    if (!name) throw new MarketplaceMutationError("A marketplace needs a name.");
    if (!url) throw new MarketplaceMutationError("A marketplace needs a URL.");
    const clash = this.getByName(existing.company_id, name);
    if (clash && clash.id !== id) {
      throw new MarketplaceMutationError(`A marketplace named "${name}" already exists.`);
    }
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;

    this.db
      .prepare(
        `UPDATE crew_marketplaces
            SET name = ?, url = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(name, url, enabled, Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: existing.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "marketplace.updated",
      entityType: "marketplace",
      entityId: id,
      details: { name, url, enabled: enabled === 1 },
    });
    return this.get(id);
  }

  delete(id: string, opts: MarketplaceActor = {}): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM crew_marketplaces WHERE id = ?").run(id);
    appendAuditEvent(this.db, {
      companyId: existing.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "marketplace.removed",
      entityType: "marketplace",
      entityId: id,
      details: { name: existing.name, kind: existing.kind },
    });
    return true;
  }

  /**
   * Records the outcome of a sync. Unaudited on purpose: a sync is machinery
   * (it changes nothing an admin approved), and one audit entry per refresh
   * would bury the entries that do matter.
   */
  recordSync(id: string, result: { entryCount?: number; error?: string }): MarketplaceRow | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE crew_marketplaces
            SET last_synced_at = ?, last_error = ?, entry_count = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        Date.now(),
        result.error ?? "",
        result.entryCount ?? (result.error ? existing.entry_count : 0),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  // --- installs ----------------------------------------------------------

  /**
   * Writes the provenance row for an install. Installing the same name twice
   * updates the existing row rather than leaving two records claiming one
   * MCP server name.
   */
  recordInstall(
    input: {
      companyId: string;
      marketplaceId: string | null;
      entryId: string;
      entryType: MarketplaceEntryType;
      name: string;
      version?: string;
      sourceUrl?: string;
      manifest?: unknown;
    } & MarketplaceActor,
  ): MarketplaceInstallRow {
    const installedBy = input.actorId ?? "ceo";
    const manifest = input.manifest === undefined ? "" : JSON.stringify(input.manifest);

    const existing = this.findInstall(input.companyId, input.entryType, input.name);
    const id = existing?.id ?? newId("mki");
    this.db
      .prepare(
        `INSERT INTO crew_marketplace_installs
           (id, company_id, marketplace_id, entry_id, entry_type, name, version, source_url,
            installed_by, manifest, installed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (company_id, entry_type, name) DO UPDATE SET
           marketplace_id = excluded.marketplace_id,
           entry_id       = excluded.entry_id,
           version        = excluded.version,
           source_url     = excluded.source_url,
           installed_by   = excluded.installed_by,
           manifest       = excluded.manifest,
           installed_at   = excluded.installed_at`,
      )
      .run(
        id,
        input.companyId,
        input.marketplaceId,
        input.entryId,
        input.entryType,
        input.name,
        input.version ?? "",
        input.sourceUrl ?? "",
        installedBy,
        manifest,
        Date.now(),
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: installedBy,
      action: "marketplace.installed",
      entityType: "marketplace_install",
      entityId: id,
      details: {
        entryType: input.entryType,
        name: input.name,
        version: input.version ?? "",
        sourceUrl: input.sourceUrl ?? "",
      },
    });

    return this.findInstall(input.companyId, input.entryType, input.name)!;
  }

  findInstall(companyId: string, entryType: MarketplaceEntryType, name: string): MarketplaceInstallRow | null {
    return oneRow<MarketplaceInstallRow>(
      this.db.prepare(
        `SELECT ${INSTALL_COLUMNS} FROM crew_marketplace_installs
          WHERE company_id = ? AND entry_type = ? AND name = ?`,
      ),
      companyId,
      entryType,
      name,
    );
  }

  installs(companyId: string): MarketplaceInstallRow[] {
    return allRows<MarketplaceInstallRow>(
      this.db.prepare(
        `SELECT ${INSTALL_COLUMNS} FROM crew_marketplace_installs
          WHERE company_id = ? ORDER BY installed_at DESC`,
      ),
      companyId,
    );
  }

  removeInstall(
    companyId: string,
    entryType: MarketplaceEntryType,
    name: string,
    opts: MarketplaceActor = {},
  ): boolean {
    const existing = this.findInstall(companyId, entryType, name);
    if (!existing) return false;
    this.db.prepare("DELETE FROM crew_marketplace_installs WHERE id = ?").run(existing.id);
    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "marketplace.uninstalled",
      entityType: "marketplace_install",
      entityId: existing.id,
      details: { entryType, name, sourceUrl: existing.source_url },
    });
    return true;
  }
}
