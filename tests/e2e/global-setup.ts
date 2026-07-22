import fs from 'node:fs';
import path from 'node:path';
import {
  clusterName,
  ensureKubeconfig,
  fixturesDir,
  kubectl,
  namespace,
  repoRoot,
} from './helpers/cluster.mjs';

export default function globalSetup() {
  for (const artifact of ['server/dist/index.js', 'client/dist/index.html']) {
    if (!fs.existsSync(path.join(repoRoot, artifact))) {
      throw new Error(`e2e: ${artifact} missing — run \`pnpm build\` first.`);
    }
  }

  // Also validates the kind cluster exists before any spec runs.
  ensureKubeconfig();

  kubectl(['apply', '-f', path.join(fixturesDir, 'e2e-workloads.yaml')]);
  kubectl([
    'rollout',
    'status',
    'deployment/web',
    '-n',
    namespace,
    '--timeout=180s',
  ]);
  kubectl(['wait', '--for=condition=Ready', 'pod/logger', '-n', namespace, '--timeout=180s']);
  // The crasher pod is intentionally never Ready. Wait for its backoff state
  // so the overview's warning event and deep link are deterministic.
  kubectl([
    'wait',
    '--for=jsonpath={.status.containerStatuses[0].state.waiting.reason}=CrashLoopBackOff',
    'pod/crasher',
    '-n',
    namespace,
    '--timeout=180s',
  ]);

  console.log(`e2e: fixtures ready in namespace "${namespace}" on kind cluster "${clusterName}"`);
}
