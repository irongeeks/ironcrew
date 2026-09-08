import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Repository } from "../../packages/persistence/src/index.ts";
for (const canonical of [true, false]) {
  it(`consolidates legacy setup progress without losing canonical data (canonical=${canonical})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-progress-"));
    const file = path.join(directory, "company.sqlite");
    let repo = await Repository.open(file);
    try {
      const setup = await repo.setup({
        companyName: "Progress fixture",
        ceoName: "Progress owner",
        passwordHash: "fixture-hash",
        timezone: "UTC",
        budgetLimitUsdMicros: "0",
      });
      const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
      expect(await repo.listDocuments(scope, "setup_progress")).toEqual([]);
      await repo.putDocument(
        scope,
        "setup-progress",
        setup.company.id,
        { step: 8, data: { modelPlan: "later" } },
        { expectedRevision: 1 },
      );
      await repo.putDocument(scope, "setup_progress", setup.company.id, { version: 1, completedStep: 1 });
      await repo.close();
      if (!canonical) {
        const db = new DatabaseSync(file);
        db.exec("DELETE FROM documents WHERE kind='setup-progress'");
        db.close();
      }
      repo = await Repository.open(file);
      const progress = await repo.getDocument(scope, "setup-progress", setup.company.id);
      expect(progress?.data).toEqual(canonical ? { step: 8, data: { modelPlan: "later" } } : { step: 1, data: {} });
      expect(progress?.revision).toBe(canonical ? 2 : 1);
      expect(await repo.listDocuments(scope, "setup_progress")).toEqual([]);
      expect((await repo.snapshot(setup.company.id)).setupProgress.completedStep).toBe(canonical ? 8 : 1);
      await repo.close();
      repo = await Repository.open(file);
      expect(await repo.getDocument(scope, "setup-progress", setup.company.id)).toEqual(progress);
    } finally {
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
