import path from "node:path";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { ProtonPassResolver, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { MailInboxService } from "./mail-inbox-service.ts";
import { oauthBrokerOptions } from "./oauth-broker.ts";
import { readConfiguration } from "./configuration.ts";
export function configuredMailInboxService(repo: Repository, directory: string) {
  const configuration = () => readConfiguration(directory);
  const secrets: SecretResolver = {
    resolve: async (ref, reason) => {
      const config = await configuration();
      if (!config.liveExecutionEnabled || !config.proton) throw new DomainError("mail_not_configured");
      return new ProtonPassResolver({
        executable: config.proton.executable,
        environment: {
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          SYSTEMROOT: process.env.SYSTEMROOT,
          PATH: path.dirname(config.proton.executable),
          ...(config.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton.sessionDirectory } : {}),
        },
      }).resolve(ref, reason);
    },
  };
  return new MailInboxService({
    repo,
    directory,
    configuration,
    secrets,
    oauth: oauthBrokerOptions(repo, directory, secrets).oauth,
  });
}
