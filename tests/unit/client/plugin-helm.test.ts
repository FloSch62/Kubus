import { describe, it, expect } from 'vitest';
import { helmReleaseFor } from '../../../plugins/sdk/src/metadata.js';
import { assertPluginScope } from '../../../client/src/plugins/scope.js';
describe('plugin Helm association', () => {
  it('resolves standard ownership annotations and the c9s chart’s legacy labels', () => {
    expect(
      helmReleaseFor({ namespace: 'lab', annotations: { 'meta.helm.sh/release-name': 'c9s', 'meta.helm.sh/release-namespace': 'system' } }),
    ).toEqual({ name: 'c9s', namespace: 'system' });
    expect(helmReleaseFor({ namespace: 'c9s', labels: { heritage: 'Helm', release: 'network-labs', chart: 'clabernetes-0.9.0' } })).toEqual(
      { name: 'network-labs', namespace: 'c9s' },
    );
  });
  it('does not infer Helm ownership from an arbitrary instance label', () => {
    expect(helmReleaseFor({ namespace: 'lab', labels: { 'app.kubernetes.io/instance': 'not-a-release' } })).toBeUndefined();
  });
  it('requires the referenced release namespace to be in the plugin’s current scope', () => {
    const release = helmReleaseFor({
      namespace: 'lab',
      annotations: { 'meta.helm.sh/release-name': 'c9s', 'meta.helm.sh/release-namespace': 'system' },
    })!;
    expect(() =>
      assertPluginScope(
        { contexts: ['a'], namespacesByContext: { a: ['lab'] }, active: true, theme: 'dark', refreshInterval: false },
        { ctx: 'a', group: '', version: 'v1', plural: 'configmaps', namespace: release.namespace },
        true,
      ),
    ).toThrow();
  });
});
