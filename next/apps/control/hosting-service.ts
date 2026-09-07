import path from "node:path";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { HostingWorkflow } from "../../packages/domain/workflows/hosting.ts";
import { HostingHttpClient, type HostingPort } from "../../packages/integrations/src/hosting.ts";
import { ProtonPassResolver, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { readConfiguration } from "./configuration.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
export class HostingService extends HostingWorkflow {
  constructor(options: { repo: Repository; directory: string; port?: HostingPort; secrets?: SecretResolver }) {
    const secrets: SecretResolver = options.secrets ?? {
      resolve: async (ref, reason) => {
        const config = await readConfiguration(options.directory);
        if (!config.proton) throw new DomainError("hosting_secret_unconfigured");
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
    super({ ...options, port: options.port ?? new HostingHttpClient(secrets) });
  }
}
