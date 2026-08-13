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

  it('preserves a non-default kubeconfig path', () => {
    expect(
      kubectlGetCommand(
        { ctx: 'dev', group: '', plural: 'pods', name: 'web', namespace: 'team-a' },
        { kubeconfigPaths: ['/work/kubeconfigs/team dev.yaml'] },
      ),
    ).toBe("kubectl get pods/web --namespace team-a --context dev --kubeconfig '/work/kubeconfigs/team dev.yaml'");
  });

  it('uses Windows-compatible double quotes on Windows', () => {
    expect(
      kubectlGetCommand(
        { ctx: "team's dev", group: '', plural: 'nodes', name: 'worker-1' },
        { kubeconfigPaths: [String.raw`C:\Users\Me\team dev.yaml`], shell: 'windows' },
      ),
    ).toBe(String.raw`kubectl get nodes/worker-1 --context "team's dev" --kubeconfig "C:\Users\Me\team dev.yaml"`);
  });

  it('preserves merged kubeconfig files with the platform path delimiter', () => {
    expect(
      kubectlGetCommand(
        { ctx: 'dev', group: '', plural: 'pods', name: 'web' },
        { kubeconfigPaths: ['/work/base.yaml', '/work/team config.yaml'] },
      ),
    ).toBe("KUBECONFIG='/work/base.yaml:/work/team config.yaml' kubectl get pods/web --context dev");

    expect(
      kubectlGetCommand(
        { ctx: 'dev', group: '', plural: 'pods', name: 'web' },
        { kubeconfigPaths: [String.raw`C:\Kube\base.yaml`, String.raw`D:\Team Config\team.yaml`], shell: 'windows' },
      ),
    ).toBe(String.raw`set "KUBECONFIG=C:\Kube\base.yaml;D:\Team Config\team.yaml" && kubectl get pods/web --context dev`);
  });
});
