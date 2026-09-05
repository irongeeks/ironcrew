import { migration as crewObjectiveEvaluations } from "./0037-crew-objective-evaluations.ts";
import { migration as crewCompanyConfiguration } from "./0036-crew-company-configuration.ts";
import { migration as crewCompanyPolicy } from "./0035-crew-company-policy.ts";
import { migration as crewCareerReviews } from "./0034-crew-career-reviews.ts";
import { migration as crewRoutingProfiles } from "./0033-crew-routing-profiles.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migration-types.ts";
import { migration as baseline } from "./0000-baseline.ts";
import { migration as m0001DropPresentationTaskType } from "./0001-drop-presentation-task-type.ts";
import { migration as m0002IronCrewDomain } from "./0002-iron-crew-domain.ts";
import { migration as m0003CrewMilestones } from "./0003-crew-milestones.ts";
import { migration as m0004CrewSecrets } from "./0004-crew-secrets.ts";
import { migration as m0005CrewAttachments } from "./0005-crew-attachments.ts";
import { migration as m0006RenameIcToCrew } from "./0006-rename-ic-prefix-to-crew.ts";
import { migration as m0007CrewRemoteWorkers } from "./0007-crew-remote-workers.ts";
import { migration as m0008CrewMeetings } from "./0008-crew-meetings.ts";
import { migration as m0009CrewMailboxes } from "./0009-crew-mailboxes.ts";
import { migration as m0010CrewMarketplaces } from "./0010-crew-marketplaces.ts";
import { migration as m0011CrewVesselsTalents } from "./0011-crew-vessels-talents.ts";
import { migration as m0012CrewAgentRunLock } from "./0012-crew-agent-run-lock.ts";
import { migration as m0013CrewExternalEvents } from "./0013-crew-external-events.ts";
import { migration as m0014CrewChangeProposals } from "./0014-crew-change-proposals.ts";
import { migration as m0015CrewMessengerPairings } from "./0015-crew-messenger-pairings.ts";
import { migration as m0016CrewRunRequests } from "./0016-crew-run-requests.ts";
import { migration as m0017CrewUsers } from "./0017-crew-users.ts";
import { migration as m0018CrewTools } from "./0018-crew-tools.ts";
import { migration as m0019CrewToolProjectScope } from "./0019-crew-tool-project-scope.ts";
import { migration as m0020CrewSecretsKeychain } from "./0020-crew-secrets-keychain.ts";
import { migration as m0021CrewRoutines } from "./0021-crew-routines.ts";
import { migration as m0022CrewPacks } from "./0022-crew-packs.ts";
import { migration as m0023CrewApprovalReviews } from "./0023-crew-approval-reviews.ts";
import { migration as m0024CrewOidcIdentities } from "./0024-crew-oidc-identities.ts";
import { migration as m0025CrewCharacterAppearance } from "./0025-crew-character-appearance.ts";
import { migration as m0026CrewMemorySync } from "./0026-crew-memory-sync.ts";
import { migration as m0027CrewRuntimeSession } from "./0027-crew-runtime-session.ts";

import { migration as crewRunnerFleet } from "./0028-crew-runner-fleet.ts";
import { migration as crewSandboxConsumption } from "./0029-crew-sandbox-consumption.ts";
import { migration as crewCharacterMedia } from "./0030-crew-character-media.ts";
import { migration as crewCoaching } from "./0031-crew-coaching.ts";

import { migration as crewProjectPlans } from "./0032-crew-project-plans.ts";

// Import future migrations here:
// import { migration as m0022 } from "./0022-example.ts";

/**
 * Entry in the registry — pairs each Migration with the on-disk filename that
 * declares it. The filename is used by the startup auto-scan (below) to detect
 * migration files that exist on disk but were never added to the registry.
 */
interface MigrationEntry {
  filename: string;
  migration: Migration;
}

const MIGRATION_ENTRIES: MigrationEntry[] = [
  { filename: "0000-baseline.ts", migration: baseline },
  { filename: "0001-drop-presentation-task-type.ts", migration: m0001DropPresentationTaskType },
  { filename: "0002-iron-crew-domain.ts", migration: m0002IronCrewDomain },
  { filename: "0003-crew-milestones.ts", migration: m0003CrewMilestones },
  { filename: "0004-crew-secrets.ts", migration: m0004CrewSecrets },
  { filename: "0005-crew-attachments.ts", migration: m0005CrewAttachments },
  { filename: "0006-rename-ic-prefix-to-crew.ts", migration: m0006RenameIcToCrew },
  { filename: "0007-crew-remote-workers.ts", migration: m0007CrewRemoteWorkers },
  { filename: "0008-crew-meetings.ts", migration: m0008CrewMeetings },
  { filename: "0009-crew-mailboxes.ts", migration: m0009CrewMailboxes },
  { filename: "0010-crew-marketplaces.ts", migration: m0010CrewMarketplaces },
  { filename: "0011-crew-vessels-talents.ts", migration: m0011CrewVesselsTalents },
  { filename: "0012-crew-agent-run-lock.ts", migration: m0012CrewAgentRunLock },
  { filename: "0013-crew-external-events.ts", migration: m0013CrewExternalEvents },
  { filename: "0014-crew-change-proposals.ts", migration: m0014CrewChangeProposals },
  { filename: "0015-crew-messenger-pairings.ts", migration: m0015CrewMessengerPairings },
  { filename: "0016-crew-run-requests.ts", migration: m0016CrewRunRequests },
  { filename: "0017-crew-users.ts", migration: m0017CrewUsers },
  { filename: "0018-crew-tools.ts", migration: m0018CrewTools },
  { filename: "0019-crew-tool-project-scope.ts", migration: m0019CrewToolProjectScope },
  { filename: "0020-crew-secrets-keychain.ts", migration: m0020CrewSecretsKeychain },
  { filename: "0021-crew-routines.ts", migration: m0021CrewRoutines },
  { filename: "0022-crew-packs.ts", migration: m0022CrewPacks },
  { filename: "0023-crew-approval-reviews.ts", migration: m0023CrewApprovalReviews },
  { filename: "0024-crew-oidc-identities.ts", migration: m0024CrewOidcIdentities },
  { filename: "0025-crew-character-appearance.ts", migration: m0025CrewCharacterAppearance },
  { filename: "0026-crew-memory-sync.ts", migration: m0026CrewMemorySync },
  { filename: "0027-crew-runtime-session.ts", migration: m0027CrewRuntimeSession },
  { filename: "0028-crew-runner-fleet.ts", migration: crewRunnerFleet },
  { filename: "0029-crew-sandbox-consumption.ts", migration: crewSandboxConsumption },
  { filename: "0030-crew-character-media.ts", migration: crewCharacterMedia },
  { filename: "0031-crew-coaching.ts", migration: crewCoaching },
  { filename: "0032-crew-project-plans.ts", migration: crewProjectPlans },
  { filename: "0033-crew-routing-profiles.ts", migration: crewRoutingProfiles },
  { filename: "0034-crew-career-reviews.ts", migration: crewCareerReviews },
  { filename: "0035-crew-company-policy.ts", migration: crewCompanyPolicy },
  { filename: "0036-crew-company-configuration.ts", migration: crewCompanyConfiguration },
  { filename: "0037-crew-objective-evaluations.ts", migration: crewObjectiveEvaluations },
];

export function validateMigrations(migrations: Migration[]): void {
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    if (m.version < prev) {
      throw new Error(`Migration versions not in ascending order: ${m.version} after ${prev}`);
    }
    seen.add(m.version);
    prev = m.version;
  }
}

/**
 * Scans the migrations directory for `NNNN-*.ts` files and throws if any such
 * file exists on disk but is absent from `registered`. Catches the common
 * "forgot to register the migration" bug at startup.
 *
 * Exported for test use. Skips test files (`*.test.ts`), `registry.ts`,
 * `runner.ts`, and `migration-types.ts`.
 */
export function assertAllMigrationFilesRegistered(migrationsDir: string, registered: Iterable<string>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(migrationsDir);
  } catch {
    // If the directory can't be read (e.g. bundled/built distribution), skip.
    return;
  }

  const migrationFilePattern = /^\d{4}-[a-z0-9-]+\.ts$/i;
  const onDisk = entries.filter((f) => migrationFilePattern.test(f) && !f.endsWith(".test.ts"));
  const registeredSet = new Set(registered);

  for (const f of onDisk) {
    if (!registeredSet.has(f)) {
      throw new Error(
        `Migration file ${f} exists on disk but is not registered in registry.ts — add an import + MIGRATION_ENTRIES entry, or rename it.`,
      );
    }
  }
}

// --- startup-time sanity checks ---

const allMigrations: Migration[] = MIGRATION_ENTRIES.map((e) => e.migration);
validateMigrations(allMigrations);

// Auto-scan: warn/throw if a NNNN-*.ts file exists on disk but was never added
// to MIGRATION_ENTRIES. Only run when we can resolve the directory (not when
// loaded in a test-only bundle).
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assertAllMigrationFilesRegistered(
    here,
    MIGRATION_ENTRIES.map((e) => e.filename),
  );
} catch (err) {
  // If the error is our own "not registered" error, let it propagate so it's
  // loud at startup. Any other error (e.g. fileURLToPath failure in a
  // non-file-URL context) is silently ignored.
  if (err instanceof Error && err.message.startsWith("Migration file ")) {
    throw err;
  }
}

export { allMigrations, MIGRATION_ENTRIES };
