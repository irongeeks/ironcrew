import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { MarketplaceStore, MarketplaceMutationError } from "./marketplace-store.ts";
import { verifyAuditChain } from "./audit.ts";

describe("MarketplaceStore", () => {
  let db: DatabaseSync;
  let companyId: string;
  let store: MarketplaceStore;

  beforeEach(() => {
    db = createTestDb();
    companyId = seedCompany(db);
    store = new MarketplaceStore(db);
  });

  function addSource(over: Partial<{ name: string; kind: "catalog" | "git"; url: string }> = {}) {
    return store.create({
      companyId,
      name: over.name ?? "acme",
      kind: over.kind ?? "catalog",
      url: over.url ?? "https://example.com/catalog.json",
    });
  }

  describe("sources", () => {
    it("stores a source enabled, unsynced and without an error", () => {
      const source = addSource();
      expect(source.kind).toBe("catalog");
      expect(source.enabled).toBe(1);
      expect(source.last_synced_at).toBeNull();
      expect(source.last_error).toBe("");
      expect(source.entry_count).toBe(0);
    });

    it("refuses a second source with the same name", () => {
      addSource();
      expect(() => addSource()).toThrow(MarketplaceMutationError);
    });

    it("refuses an unknown kind", () => {
      expect(() =>
        store.create({
          companyId,
          name: "weird",
          // Kinds come from the API surface; the store checks anyway.
          kind: "torrent" as unknown as "catalog",
          url: "https://example.com",
        }),
      ).toThrow(MarketplaceMutationError);
    });

    it("refuses an empty name or URL", () => {
      expect(() => store.create({ companyId, name: "  ", kind: "catalog", url: "https://x" })).toThrow(
        MarketplaceMutationError,
      );
      expect(() => store.create({ companyId, name: "x", kind: "catalog", url: "  " })).toThrow(
        MarketplaceMutationError,
      );
    });

    it("renames a source but not onto an existing name", () => {
      const a = addSource({ name: "a" });
      addSource({ name: "b", url: "https://example.com/b.json" });

      expect(store.update(a.id, { name: "a2" })?.name).toBe("a2");
      expect(() => store.update(a.id, { name: "b" })).toThrow(MarketplaceMutationError);
    });

    it("disables a source without deleting it", () => {
      const source = addSource();
      expect(store.update(source.id, { enabled: false })?.enabled).toBe(0);
      expect(store.list(companyId)).toHaveLength(1);
    });

    it("records a successful sync and clears a previous error", () => {
      const source = addSource();
      store.recordSync(source.id, { error: "404" });
      expect(store.get(source.id)?.last_error).toBe("404");

      const synced = store.recordSync(source.id, { entryCount: 12 });
      expect(synced?.last_error).toBe("");
      expect(synced?.entry_count).toBe(12);
      expect(synced?.last_synced_at).not.toBeNull();
    });

    it("keeps the last known entry count when a sync fails", () => {
      const source = addSource();
      store.recordSync(source.id, { entryCount: 7 });
      const failed = store.recordSync(source.id, { error: "unreachable" });
      // The catalog did not shrink to zero — it could not be read at all.
      expect(failed?.entry_count).toBe(7);
      expect(failed?.last_error).toBe("unreachable");
    });

    it("lists only the company's own sources", () => {
      const other = seedCompany(db, "Other");
      addSource();
      store.create({ companyId: other, name: "theirs", kind: "git", url: "https://github.com/o/r" });

      expect(store.list(companyId).map((s) => s.name)).toEqual(["acme"]);
    });
  });

  describe("installs", () => {
    it("records what was installed, from which source", () => {
      const source = addSource();
      const install = store.recordInstall({
        companyId,
        marketplaceId: source.id,
        entryId: "github",
        entryType: "mcp",
        name: "github",
        version: "1.2.0",
        sourceUrl: "https://github.com/acme/mcp",
        manifest: { transport: "stdio", command: "npx" },
      });

      expect(install.entry_type).toBe("mcp");
      expect(install.marketplace_id).toBe(source.id);
      expect(JSON.parse(install.manifest)).toEqual({ transport: "stdio", command: "npx" });
    });

    it("installing the same name again updates the one record", () => {
      const source = addSource();
      const base = {
        companyId,
        marketplaceId: source.id,
        entryId: "github",
        entryType: "mcp" as const,
        name: "github",
      };
      store.recordInstall({ ...base, version: "1.0.0" });
      store.recordInstall({ ...base, version: "2.0.0" });

      const installs = store.installs(companyId);
      expect(installs).toHaveLength(1);
      expect(installs[0].version).toBe("2.0.0");
    });

    it("separates an MCP server from a skill of the same name", () => {
      const source = addSource();
      store.recordInstall({ companyId, marketplaceId: source.id, entryId: "a", entryType: "mcp", name: "review" });
      store.recordInstall({ companyId, marketplaceId: source.id, entryId: "b", entryType: "skill", name: "review" });

      expect(store.installs(companyId)).toHaveLength(2);
      expect(store.findInstall(companyId, "skill", "review")?.entry_id).toBe("b");
    });

    it("keeps the provenance record when the source is removed", () => {
      const source = addSource();
      store.recordInstall({
        companyId,
        marketplaceId: source.id,
        entryId: "github",
        entryType: "mcp",
        name: "github",
        sourceUrl: "https://github.com/acme/mcp",
      });

      store.delete(source.id);

      // The server is still installed on this machine; where it came from
      // must remain answerable.
      const install = store.findInstall(companyId, "mcp", "github");
      expect(install).not.toBeNull();
      expect(install?.marketplace_id).toBeNull();
      expect(install?.source_url).toBe("https://github.com/acme/mcp");
    });

    it("removes an install record on uninstall", () => {
      const source = addSource();
      store.recordInstall({ companyId, marketplaceId: source.id, entryId: "a", entryType: "mcp", name: "github" });

      expect(store.removeInstall(companyId, "mcp", "github")).toBe(true);
      expect(store.removeInstall(companyId, "mcp", "github")).toBe(false);
      expect(store.installs(companyId)).toHaveLength(0);
    });
  });

  it("audits adding, installing and removing, and the chain stays valid", () => {
    const source = addSource();
    store.recordInstall({ companyId, marketplaceId: source.id, entryId: "a", entryType: "mcp", name: "github" });
    store.removeInstall(companyId, "mcp", "github");
    store.delete(source.id);

    const actions = (
      db.prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq").all(companyId) as Array<{
        action: string;
      }>
    ).map((r) => r.action);

    expect(actions).toEqual([
      "marketplace.added",
      "marketplace.installed",
      "marketplace.uninstalled",
      "marketplace.removed",
    ]);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("does not audit a sync — it changes nothing an admin approved", () => {
    const source = addSource();
    store.recordSync(source.id, { entryCount: 3 });

    const count = db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE company_id = ?").get(companyId) as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
