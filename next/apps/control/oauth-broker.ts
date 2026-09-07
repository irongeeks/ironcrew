import path from "node:path";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { OAuthTokenBroker } from "../../packages/integrations/src/oauth.ts";
import type { SecretResolver } from "../../packages/integrations/src/secrets.ts";
export async function recoveryGeneration(repo: Repository, scope: Scope): Promise<string | null> {
  const setup = await repo.snapshot(scope.companyId);
  const companyScope = { companyId: scope.companyId, areaId: setup.areas.find((a) => a.visibility === "company")!.id };
  return (
    (await repo.getDocument<{ generation: string }>(companyScope, "recovery-state", scope.companyId))?.data
      .generation ?? null
  );
}
export function oauthBrokerOptions(repo: Repository, directory: string, secrets: SecretResolver) {
  return {
    oauth: new OAuthTokenBroker({ directory: path.resolve(directory, "oauth-vault"), secrets }),
    oauthGeneration: (scope: Scope) => recoveryGeneration(repo, scope),
  };
}
