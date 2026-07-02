import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { SshInfoResponse } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { defaultSshConfigPath, parseSshConfigHosts } from '../ssh/ssh-config.js';
import { isValidSshDestination } from '../ssh/tunnel-manager.js';

export function registerSshRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Everything the cluster editor needs to offer SSH jump hosts safely. */
  app.get('/api/ssh/info', async (): Promise<SshInfoResponse> => {
    const configPath = defaultSshConfigPath();
    const configExists = fs.existsSync(configPath);
    const parsed = configExists ? parseSshConfigHosts(configPath) : { hosts: [] as SshInfoResponse['hosts'] };
    const binary = await ctx.sshTunnels.binaryInfo();
    return {
      sshAvailable: binary.available,
      sshVersion: binary.version,
      platform: process.platform,
      configPath,
      configExists,
      // Only offer aliases we'd accept as a tunnel destination (e.g. no spaces).
      hosts: parsed.hosts.filter((h) => isValidSshDestination(h.alias)),
      parseError: parsed.error,
    };
  });
}
