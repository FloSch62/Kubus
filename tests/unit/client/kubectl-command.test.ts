import { describe, expect, it } from 'vitest';
import { kubectlGetCommand } from '../../../client/src/kubectl-command';

describe('kubectlGetCommand', () => {
  it('includes resource group, namespace, and context for a namespaced resource', () => {
    expect(
      kubectlGetCommand({
        ctx: 'kind-dev',
        group: 'apps',
        plural: 'deployments',
        name: 'web',
        namespace: 'team-a',
      }),
    ).toBe('kubectl get deployments.apps/web --namespace team-a --context kind-dev');
  });

  it('omits the namespace and group for a cluster-scoped core resource', () => {
    expect(kubectlGetCommand({ ctx: 'prod', group: '', plural: 'nodes', name: 'worker-1' })).toBe(
      'kubectl get nodes/worker-1 --context prod',
    );
  });

  it('quotes shell-sensitive context names', () => {
    expect(kubectlGetCommand({ ctx: "team's dev", group: 'example.io', plural: 'widgets', name: 'sample' })).toBe(
      `kubectl get widgets.example.io/sample --context 'team'"'"'s dev'`,
    );
  });
});
