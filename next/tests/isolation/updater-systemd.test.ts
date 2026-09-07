import { test, expect } from "vitest";
import { writeFile, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { executeQueuedUpdate } from "../../packages/operations/src/index.ts";
import { fixture, portableNode, age } from "../fixtures/updater.ts";

test.skipIf(process.env.IRONCREW_TEST_SYSTEMD !== "1" || !existsSync(portableNode) || !existsSync(age))(
  "offline helper cannot read a protected configuration reached through a data-user symlink",
  async () => {
    const f = await fixture(),
      secret = path.join(f.root, "root-private-fixture.json");
    await writeFile(secret, JSON.stringify({ privateFixture: "must-not-enter-service-backup" }), { mode: 0o600 });
    await symlink(secret, path.join(f.config.dataDirectory, "configuration.json"));
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as { jobId: string };
    await f.closeRepo();
    const outcome = await executeQueuedUpdate(f.configPath, queued.jobId);
    expect(outcome.state).toBe("rolled_back");
    expect(outcome.errorCode).toBe("update_backup_failed");
    expect(outcome.backup).toBeUndefined();
    expect(outcome.health?.version).toBe("0.4.0");
    expect((await stat(secret)).uid).toBe(0);
  },
  60000,
);
