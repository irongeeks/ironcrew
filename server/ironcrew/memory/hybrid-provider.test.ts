import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migration } from "../../modules/bootstrap/migrations/0026-crew-memory-sync.ts";
import { ObsidianProvider } from "./obsidian-provider.ts";
import { HonchoConfigSchema, HonchoMemoryProvider } from "./honcho-provider.ts";
import { HybridMemoryProvider } from "./hybrid-provider.ts";
import type { MemoryWriteInput } from "./memory-provider.ts";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const entry: MemoryWriteInput = {
  kind: "fact",
  title: "Backup",
  content: "Nightly backup at 22:00",
  provenance: { companyId: "company", sensitivity: "public", source: "owner", taskId: "task-1" },
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crew-memory-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE crew_companies(id TEXT PRIMARY KEY); INSERT INTO crew_companies VALUES('company')");
  migration.up(db);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const local = new ObsidianProvider({ vaultPath: dir });
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(url.endsWith("/messages") ? [{ content: "stored" }] : {});
  });
  const semantic = new HonchoMemoryProvider({ companyId: "company", config: { enabled: true }, fetchImpl: transport });
  let now = 1000;
  const hybrid = () => new HybridMemoryProvider({ db, local, semantic, now: () => now });
  return {
    dir,
    db,
    local,
    semantic,
    requests,
    transport,
    hybrid,
    advance: () => {
      now += 3600000;
    },
  };
}
describe("optional semantic memory", () => {
  it("writes local canonical content without waiting for any network and persists only references", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    expect(f.transport).not.toHaveBeenCalled();
    expect(await h.read(written.externalId)).toContain(entry.content);
    expect(h.syncStatus().pending).toBe(1);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM crew_memory_sync").all())).not.toContain(entry.content);
    await h.syncPending();
    expect(h.syncStatus()).toMatchObject({ synced: 1, pending: 0 });
    const message = f.requests.find((r) => r.url.endsWith("/messages"))!;
    expect(message.body).toMatchObject({
      messages: [
        {
          peer_id: "owner",
          configuration: { reasoning: { enabled: false } },
          metadata: { company_id: "company", external_id: written.externalId },
        },
      ],
    });
  });
  it("preserves pending writes after provider recreation and retries only after backoff", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    f.transport.mockRejectedValueOnce(new Error("Authorization: Bearer secret-password"));
    await h.syncPending();
    expect(h.syncStatus().failed).toBe(1);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM crew_memory_sync").all())).not.toContain("secret-password");
    expect(await h.read(written.externalId)).toContain(entry.content);
    const next = f.hybrid();
    await next.syncPending();
    expect(f.transport).toHaveBeenCalledTimes(1);
    f.advance();
    await next.syncPending();
    expect(next.syncStatus().synced).toBe(1);
  });
  it.each([undefined, "internal", "confidential", "restricted"])(
    "does not enqueue unapproved sensitivity %s",
    async (sensitivity) => {
      const f = fixture();
      const h = f.hybrid();
      await h.write({ ...entry, provenance: { companyId: "company", sensitivity } });
      await h.syncPending();
      expect(f.transport).not.toHaveBeenCalled();
      expect(h.syncStatus().pending).toBe(0);
    },
  );
  it("rejects another company before any filesystem or network mutation", async () => {
    const f = fixture();
    await expect(
      f.hybrid().write({ ...entry, provenance: { companyId: "other", sensitivity: "public" } }),
    ).rejects.toThrow("scope");
    expect(await f.local.search("Backup")).toEqual([]);
  });
  it("redacts secrets in stored content, metadata and external payload", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write({ ...entry, title: "token=not-a-real-token", content: "password=super-secret-123" });
    await h.syncPending();
    expect(await h.read(written.externalId)).not.toContain("super-secret-123");
    expect(JSON.stringify(f.requests)).not.toContain("not-a-real-token");
  });
  it("keeps a failed deletion as a tombstone, hides results, retries across restart", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    await h.delete(written.externalId);
    f.transport.mockRejectedValueOnce(new Error("offline"));
    await h.syncPending();
    expect(await h.read(written.externalId)).toBeNull();
    expect(await h.search("Backup")).toEqual([]);
    expect(h.syncStatus().pendingDeletion).toBe(1);
    f.advance();
    await f.hybrid().syncPending();
    expect(h.syncStatus().pendingDeletion).toBe(0);
  });
  it("does not resurrect a deletion that occurs while upload is in flight", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    let resolve!: (r: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    f.transport.mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((r) => {
        resolve = r;
      });
    });
    const sync = h.syncPending();
    await start;
    await h.delete(written.externalId);
    resolve(Response.json({}));
    await sync;
    expect(h.syncStatus().pendingDeletion).toBe(1);
    expect(h.syncStatus().synced).toBe(0);
    f.advance();
    await h.syncPending();
    expect(h.syncStatus().pendingDeletion).toBe(0);
  });
  it("does not send ordinary search text externally, and degrades explicit semantic search to local", async () => {
    const f = fixture();
    const h = f.hybrid();
    await h.write(entry);
    expect(await h.search("Backup")).toHaveLength(1);
    expect(f.transport).not.toHaveBeenCalled();
    f.transport.mockRejectedValueOnce(new Error("offline"));
    expect(await h.searchSemantic("Backup", "public")).toHaveLength(1);
  });
  it("exports authoritative notes and omits forgotten entries", async () => {
    const f = fixture();
    const h = f.hybrid();
    const a = await h.write(entry);
    const b = await h.write({ ...entry, title: "second" });
    await h.delete(b.externalId);
    expect(await h.exportEntries([a.externalId, b.externalId])).toEqual([
      { externalId: a.externalId, content: await h.read(a.externalId) },
    ]);
  });
  it("rejects credentials in endpoints and unsafe cleartext defaults", () => {
    expect(HonchoConfigSchema.safeParse({ baseUrl: "https://user:password@api.honcho.dev" }).success).toBe(false);
    expect(HonchoConfigSchema.safeParse({ baseUrl: "http://127.0.0.1:8000" }).success).toBe(false);
    expect(HonchoConfigSchema.safeParse({ baseUrl: "http://127.0.0.1:8000", allowLocal: true }).success).toBe(true);
  });
  it("bounds external response size and never follows redirects", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(Response.json("x".repeat(1024 * 1024)));
    await expect(f.semantic.search("x")).rejects.toThrow("limit");
    expect(f.transport.mock.calls[0][1].redirect).toBe("error");
  });
  it("times out a hanging credential resolver without making an external request", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn();
      const semantic = new HonchoMemoryProvider({
        companyId: "company",
        config: { enabled: true, timeoutMs: 100 },
        resolveApiKey: () => new Promise(() => undefined),
        fetchImpl: transport,
      });
      const outcome = expect(semantic.search("x")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(101);
      await outcome;
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("requeues tracked local edits while ignoring unknown files", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    h.localChanged("unknown/entry");
    expect(h.syncStatus().pending).toBe(0);
    h.localChanged(written.externalId);
    expect(h.syncStatus().pending).toBe(1);
    await h.syncPending();
    expect(h.syncStatus().synced).toBe(1);
  });
  it("does not return unknown or cross-company remote memories", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    f.transport.mockResolvedValueOnce(
      Response.json([
        { content: "remote", metadata: { company_id: "company", external_id: written.externalId, title: "matched" } },
        { content: "foreign", metadata: { company_id: "other", external_id: written.externalId } },
        { content: "unknown", metadata: { company_id: "company", external_id: "missing" } },
      ]),
    );
    expect(await h.searchSemantic("unmatched-query", "public")).toEqual([
      { externalId: written.externalId, title: "matched", snippet: "remote", path: null },
    ]);
  });
  it("revokes the remote copy when an external edit changes the sensitivity", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    const file = join(f.dir, written.path!);
    writeFileSync(file, readFileSync(file, "utf8").replace("sensitivity: public", "sensitivity: restricted"));
    h.localChanged(written.externalId);
    const before = f.transport.mock.calls.length;
    await h.syncPending();
    expect(f.transport.mock.calls.slice(before).map((call) => call[1].method)).toEqual(["DELETE"]);
    expect(h.syncStatus().synced).toBe(0);
    expect(await h.read(written.externalId)).toContain("restricted");
  });
  it.each([
    ["removed frontmatter", (content: string) => content.replace(/^---\n[\s\S]*?\n---\n/, "")],
    ["missing sensitivity", (content: string) => content.replace(/^sensitivity:.*\n/m, "")],
    ["invalid sensitivity", (content: string) => content.replace("sensitivity: public", "sensitivity: [public]")],
    ["malformed YAML", (content: string) => content.replace("sensitivity: public", "sensitivity: [")],
    ["another company", (content: string) => content.replace("companyId: company", "companyId: other")],
    ["another task", (content: string) => content.replace("taskId: task-1", "taskId: task-2")],
    ["removed task scope", (content: string) => content.replace(/^taskId:.*\n/m, "")],
    [
      "new project scope",
      (content: string) => content.replace("taskId: task-1", "taskId: task-1\nprojectId: project-2"),
    ],
    [
      "new agent scope",
      (content: string) => content.replace("taskId: task-1", "taskId: task-1\nagentId: another-agent"),
    ],
  ] as const)("revokes semantic access after %s, before and after synchronization", async (_name, edit) => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    const file = join(f.dir, written.path!);
    writeFileSync(file, edit(readFileSync(file, "utf8")));
    f.transport.mockResolvedValueOnce(
      Response.json([
        { content: "remote stale copy", metadata: { company_id: "company", external_id: written.externalId } },
      ]),
    );
    // No watcher callback is required to hide a now unauthorized remote hit.
    expect(await h.searchSemantic("unmatched-query", "public")).toEqual([]);
    h.localChanged(written.externalId);
    const before = f.transport.mock.calls.length;
    await h.syncPending();
    expect(f.transport.mock.calls.slice(before).map((call) => call[1].method)).toEqual(["DELETE"]);
    expect(h.syncStatus()).toMatchObject({ synced: 0, pending: 0 });
    expect(await h.read(written.externalId)).not.toBeNull();
  });

  it("keeps revocation retryable after a failed remote delete without uploading invalid content", async () => {
    const f = fixture();
    const h = f.hybrid();
    const written = await h.write(entry);
    await h.syncPending();
    writeFileSync(join(f.dir, written.path!), "Private replacement with no transmission grant.");
    h.localChanged(written.externalId);
    const before = f.transport.mock.calls.length;
    f.transport.mockRejectedValueOnce(new Error("offline"));
    await h.syncPending();
    expect(h.syncStatus().failed).toBe(1);
    f.advance();
    await f.hybrid().syncPending();
    expect(f.transport.mock.calls.slice(before).map((call) => call[1].method)).toEqual(["DELETE", "DELETE"]);
    expect(h.syncStatus().pending).toBe(0);
  });
});
