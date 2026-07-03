import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KubeConfig } from '@kubernetes/client-node';
import type { KubeconfigImportResponse, KubeconfigSettings } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';
import { mergeKubeconfig, writeKubeconfig } from '../kube/kubeconfig-file.js';
import { authWarningForUser } from '../kube/auth-diagnostics.js';

/** Credential problems (missing exec plugin, legacy auth-provider) in the users an import brings in. */
function importAuthWarnings(incomingYaml: string, addedUsers: string[]): string[] {
  if (!addedUsers.length) return [];
  const kc = new KubeConfig();
  try {
    kc.loadFromString(incomingYaml);
  } catch {
    return [];
  }
  const warnings: string[] = [];
  for (const name of addedUsers) {
    const warning = authWarningForUser(kc.getUsers().find((u) => u.name === name));
    if (warning) warnings.push(`user "${name}": ${warning}`);
  }
  return warnings;
}

const setKubeconfigSchema = z.object({ path: z.string().min(1).nullable() });
const importSchema = z.object({ yaml: z.string().min(1), overwrite: z.boolean().optional() });

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const kubeconfigSettings = (): KubeconfigSettings => {
    const override = ctx.clusters.getKubeconfigOverride() ?? null;
    const persisted = ctx.settings.load().kubeconfigPath;
    const source = ctx.cliKubeconfig ? 'cli-flag' : persisted ? 'settings-file' : process.env.KUBECONFIG ? 'env' : 'default';
    return {
      paths: ctx.clusters.getKubeconfigPaths(),
      primaryPath: ctx.clusters.primaryKubeconfigPath(),
      override,
      source,
      kubeconfigEnv: process.env.KUBECONFIG ?? null,
    };
  };

  app.get('/api/settings/kubeconfig', async () => kubeconfigSettings());

  app.put('/api/settings/kubeconfig', async (req, reply) => {
    try {
      const parsed = setKubeconfigSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid body', 'BadRequest');
      let p = parsed.data.path;
      if (p !== null) {
        p = p.replace(/^~(?=$|\/)/, os.homedir());
        if (!path.isAbsolute(p)) throw new HttpProblem(400, 'kubeconfig path must be absolute', 'BadRequest');
        if (!fs.existsSync(p)) throw new HttpProblem(400, `file not found: ${p}`, 'BadRequest');
        try {
          new KubeConfig().loadFromFile(p);
        } catch (err) {
          throw new HttpProblem(400, `not a valid kubeconfig: ${err instanceof Error ? err.message : String(err)}`, 'BadRequest');
        }
      }
      ctx.settings.save({ kubeconfigPath: p ?? undefined });
      ctx.clusters.setKubeconfigOverride(p ?? undefined);
      // A cleared override falls back to env/default for this session even if
      // the server was started with --kubeconfig; the flag wins on relaunch.
      if (p === null) ctx.cliKubeconfig = undefined;
      return kubeconfigSettings();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post('/api/settings/kubeconfig/import', async (req, reply) => {
    try {
      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid body', 'BadRequest');
      const target = ctx.clusters.primaryKubeconfigPath();
      if (!target) throw new HttpProblem(400, 'no kubeconfig path could be resolved', 'BadRequest');
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      const result = mergeKubeconfig(existing, parsed.data.yaml, parsed.data.overwrite ?? false);
      if (result.conflicts.length) {
        throw new HttpProblem(409, `entries already exist with different content: ${result.conflicts.join(', ')}`, 'Conflict');
      }
      const backupPath = writeKubeconfig(target, result.merged);
      ctx.clusters.reload();
      const response: KubeconfigImportResponse = {
        added: result.added,
        skipped: result.skipped,
        backupPath,
        contexts: ctx.clusters.listContexts(),
        warnings: importAuthWarnings(parsed.data.yaml, result.added.users),
      };
      return response;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
