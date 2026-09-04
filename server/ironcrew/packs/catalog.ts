/**
 * IronCrew — the packs this build ships, and the adapters behind them.
 *
 * One list, in code, reviewed like code. There is no remote pack source and
 * no download: `crew_marketplaces` already covers "fetch something from
 * elsewhere and run it" and carries its own threat model (T-12), and a second
 * such surface would double the attack surface for a feature nobody asked
 * for.
 *
 * THE CROSS-CHECK THAT KEEPS PHASE 4 HONEST
 *
 * The roadmap's line for this phase is "every integration ships behind a
 * feature flag as a real adapter — no fake buttons". A pack *declares* the
 * integrations it needs; the composition root *registers* adapters for the
 * ones an operator configured. Those are two lists, written in two places, by
 * two different people six months apart — which is exactly how a button ends
 * up in the UI with nothing behind it.
 *
 * `INTEGRATION_ADAPTERS` is the third list that makes the other two provable:
 * every key here has a real adapter module in `integrations/`, and
 * `catalog.test.ts` asserts that every integration any pack declares appears
 * here. A pack that invents an integration fails the test suite rather than
 * shipping a switch that does nothing.
 */

import type { BusinessPack } from "./business-pack.ts";
import { mspPack } from "./definitions/msp.ts";
import { webAgencyPack } from "./definitions/web-agency.ts";
import { financePack } from "./definitions/finance.ts";
import { legalPack } from "./definitions/legal.ts";
import { knowledgePack } from "./definitions/knowledge.ts";

/** Every pack this build knows, in the order an operator should meet them. */
export const BUSINESS_PACKS: readonly BusinessPack[] = [
  mspPack,
  webAgencyPack,
  financePack,
  legalPack,
  knowledgePack,
] as const;

/**
 * Integration keys that have a real adapter module in this build.
 *
 * Not derived by scanning the directory: a constant is what a test can assert
 * against, and a scan would happily "find" a file that exports nothing usable.
 */
export const INTEGRATION_ADAPTERS = [
  "proxmox",
  "tactical-rmm",
  "unifi",
  "lexware-office",
  "sevdesk",
  "paperless-ngx",
  "nextcloud",
] as const;

export type IntegrationAdapterKey = (typeof INTEGRATION_ADAPTERS)[number];

export function findPack(key: string): BusinessPack | null {
  return BUSINESS_PACKS.find((pack) => pack.key === key) ?? null;
}

export function listPackKeys(): string[] {
  return BUSINESS_PACKS.map((pack) => pack.key);
}
