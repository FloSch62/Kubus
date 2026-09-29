import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { computeOperatorRollups } from '../../../server/src/kube/operator-rollups';

function crd(plural: string, group: string, kind: string, version = 'v1'): KubeObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${group}`, uid: plural },
    spec: { group, scope: 'Namespaced', names: { plural, kind }, versions: [{ name: version, served: true, storage: true }] },
  } as KubeObject;
}

const ready = (name: string, status: string, reason?: string): KubeObject =>
  ({ metadata: { name, namespace: 'apps', uid: name }, status: { conditions: [{ type: 'Ready', status, reason, message: reason && `${reason} happened` }] } }) as KubeObject;

describe('operator rollups', () => {
  it('rolls up External Secrets once its CRDs are installed', async () => {
    const items: Record<string, KubeObject[]> = {
      externalsecrets: [ready('db', 'True'), ready('api-keys', 'False', 'SecretSyncedError')],
      secretstores: [ready('vault', 'True')],
    };
    const handle = {
      watchers: {
        acquire: (_group: string, _version: string, plural: string) => ({
          watcher: { ready: async () => undefined, items: () => items[plural] ?? [], currentState: () => 'live' },
          release: () => undefined,
        }),
      },
    } as unknown as ClusterHandle;
    const rollups = await computeOperatorRollups(handle, [
      crd('externalsecrets', 'external-secrets.io', 'ExternalSecret'),
      crd('secretstores', 'external-secrets.io', 'SecretStore'),
    ]);
    expect(rollups.map((op) => op.id)).toEqual(['external-secrets']);
    expect(rollups[0]!.resources.map((r) => [r.kind, r.total, r.ready])).toEqual([
      ['ExternalSecret', 2, 1],
      ['SecretStore', 1, 1],
    ]);
    expect(rollups[0]!.resources[0]!.issues).toEqual([{ kind: 'ExternalSecret', namespace: 'apps', name: 'api-keys', reason: 'SecretSyncedError', message: 'SecretSyncedError happened' }]);
  });
});
