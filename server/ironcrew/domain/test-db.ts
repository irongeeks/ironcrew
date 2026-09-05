/**
 * In-memory database helper for IronCrew domain tests.
 * Applies the same migration the server runs, so tests exercise the real schema.
 */
import { DatabaseSync } from "node:sqlite";
import { migration as ironCrewDomain } from "../../modules/bootstrap/migrations/0002-iron-crew-domain.ts";
import { migration as crewMilestones } from "../../modules/bootstrap/migrations/0003-crew-milestones.ts";
import { migration as crewSecrets } from "../../modules/bootstrap/migrations/0004-crew-secrets.ts";
import { migration as crewAttachments } from "../../modules/bootstrap/migrations/0005-crew-attachments.ts";
import { migration as renameIcToCrew } from "../../modules/bootstrap/migrations/0006-rename-ic-prefix-to-crew.ts";
import { migration as crewRemoteWorkers } from "../../modules/bootstrap/migrations/0007-crew-remote-workers.ts";
import { migration as crewMeetings } from "../../modules/bootstrap/migrations/0008-crew-meetings.ts";
import { migration as crewMailboxes } from "../../modules/bootstrap/migrations/0009-crew-mailboxes.ts";
import { migration as crewMarketplaces } from "../../modules/bootstrap/migrations/0010-crew-marketplaces.ts";
import { migration as crewVesselsTalents } from "../../modules/bootstrap/migrations/0011-crew-vessels-talents.ts";
import { migration as crewAgentRunLock } from "../../modules/bootstrap/migrations/0012-crew-agent-run-lock.ts";
import { migration as crewExternalEvents } from "../../modules/bootstrap/migrations/0013-crew-external-events.ts";
import { migration as crewChangeProposals } from "../../modules/bootstrap/migrations/0014-crew-change-proposals.ts";
import { migration as crewMessengerPairings } from "../../modules/bootstrap/migrations/0015-crew-messenger-pairings.ts";
import { migration as crewRunRequests } from "../../modules/bootstrap/migrations/0016-crew-run-requests.ts";
import { migration as crewUsers } from "../../modules/bootstrap/migrations/0017-crew-users.ts";
import { migration as crewTools } from "../../modules/bootstrap/migrations/0018-crew-tools.ts";
import { migration as crewToolProjectScope } from "../../modules/bootstrap/migrations/0019-crew-tool-project-scope.ts";
import { migration as crewSecretsKeychain } from "../../modules/bootstrap/migrations/0020-crew-secrets-keychain.ts";
import { migration as crewRoutines } from "../../modules/bootstrap/migrations/0021-crew-routines.ts";
import { migration as crewPacks } from "../../modules/bootstrap/migrations/0022-crew-packs.ts";
import { migration as crewApprovalReviews } from "../../modules/bootstrap/migrations/0023-crew-approval-reviews.ts";
import { migration as crewOidcIdentities } from "../../modules/bootstrap/migrations/0024-crew-oidc-identities.ts";
import { migration as crewCharacterAppearance } from "../../modules/bootstrap/migrations/0025-crew-character-appearance.ts";
import { migration as crewMemorySync } from "../../modules/bootstrap/migrations/0026-crew-memory-sync.ts";
import { migration as crewRuntimeSession } from "../../modules/bootstrap/migrations/0027-crew-runtime-session.ts";
import { newId } from "./ids.ts";

/**
 * A database with the real schema.
 *
 * In memory by default, which is what almost every test wants. A `filePath`
 * makes it a real file on disk — needed by anything that has to reopen the
 * database in a second connection or copy it, such as the backup tests: an
 * in-memory database cannot be snapshotted from outside the process holding
 * it, so testing a backup against one would test nothing.
 */
export function createTestDb(filePath?: string): DatabaseSync {
  const db = new DatabaseSync(filePath ?? ":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ironCrewDomain.up(db);
  crewMilestones.up(db);
  crewSecrets.up(db);
  crewAttachments.up(db);
  renameIcToCrew.up(db);
  crewRemoteWorkers.up(db);
  crewMeetings.up(db);
  crewMailboxes.up(db);
  crewMarketplaces.up(db);
  crewVesselsTalents.up(db);
  crewAgentRunLock.up(db);
  crewExternalEvents.up(db);
  crewChangeProposals.up(db);
  crewMessengerPairings.up(db);
  crewRunRequests.up(db);
  crewUsers.up(db);
  crewTools.up(db);
  crewToolProjectScope.up(db);
  crewSecretsKeychain.up(db);
  crewRoutines.up(db);
  crewPacks.up(db);
  crewApprovalReviews.up(db);
  crewOidcIdentities.up(db);
  crewCharacterAppearance.up(db);
  crewMemorySync.up(db);
  crewRuntimeSession.up(db);
  return db;
}

export function seedCompany(db: DatabaseSync, name = "IronCrew Test"): string {
  const id = newId("cmp");
  db.prepare("INSERT INTO crew_companies (id, name, slug) VALUES (?,?,?)").run(id, name, `test-${id}`);
  return id;
}

/**
 * Seeds one agent as a Vessel × Talent pairing (migration 0011).
 *
 * Each call creates its own talent, so tests that seed several agents get
 * several roles rather than accidentally sharing one; the vessel is shared
 * per company, which is how the real derivation groups them too.
 */
export function seedAgent(db: DatabaseSync, companyId: string, key = "cto"): string {
  const existingVessel = db
    .prepare("SELECT id FROM crew_vessels WHERE company_id = ? AND key = 'mock'")
    .get(companyId) as { id: string } | undefined;

  let vesselId = existingVessel?.id;
  if (!vesselId) {
    vesselId = newId("vsl");
    db.prepare(`INSERT INTO crew_vessels (id, company_id, key, label, runtime_provider) VALUES (?,?,?,?,?)`).run(
      vesselId,
      companyId,
      "mock",
      "mock (Standard)",
      "mock",
    );
  }

  const talentId = newId("tal");
  db.prepare(`INSERT INTO crew_talents (id, company_id, key, professional_role) VALUES (?,?,?,?)`).run(
    talentId,
    companyId,
    key,
    key,
  );

  const id = newId("agt");
  db.prepare(
    `INSERT INTO crew_agents (id, company_id, key, display_name, vessel_id, talent_id)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, companyId, key, key.toUpperCase(), vesselId, talentId);
  return id;
}
