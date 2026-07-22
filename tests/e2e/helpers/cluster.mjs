// Shared between global-setup.ts and start-server.mjs, so it stays plain JS —
// start-server.mjs runs under bare Node as the Playwright webServer command.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const repoRoot = path.resolve(e2eDir, '..', '..');
export const stateDir = path.join(e2eDir, '.state');
export const kubeconfigPath = path.join(stateDir, 'kubeconfig');
export const fixturesDir = path.join(e2eDir, 'fixtures');

export const clusterName = process.env.KUBUS_E2E_KIND_CLUSTER ?? 'kubus-a';
export const contextName = `kind-${clusterName}`;
// An extra context whose apiserver is unreachable, for error-state tests.
export const ghostContextName = 'kubus-ghost';

export const namespace = 'kubus-e2e';

/**
 * Write .state/kubeconfig: the kind cluster's kubeconfig plus an unreachable
 * "ghost" context. Regenerating on every call keeps runs deterministic even
 * after a test mutated the kubeconfig through the app.
 */
export function ensureKubeconfig() {
  let raw;
  try {
    raw = execFileSync('kind', ['get', 'kubeconfig', '--name', clusterName], {
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(
      `e2e: could not get kubeconfig for kind cluster "${clusterName}". ` +
        `Create it with hack/dev-clusters.sh (or set KUBUS_E2E_KIND_CLUSTER). ` +
        `Underlying error: ${err.message}`,
    );
  }

  const config = load(raw);
  config.clusters.push({
    name: ghostContextName,
    cluster: { server: 'https://127.0.0.1:59999' },
  });
  config.users.push({ name: ghostContextName, user: {} });
  config.contexts.push({
    name: ghostContextName,
    context: { cluster: ghostContextName, user: ghostContextName },
  });
  config['current-context'] = contextName;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(kubeconfigPath, dump(config));
  return kubeconfigPath;
}

export function kubectl(args, opts = {}) {
  return execFileSync('kubectl', ['--context', contextName, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KUBECONFIG: kubeconfigPath },
    ...opts,
  });
}
