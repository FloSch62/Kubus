import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { coverageKey, daemonNodeExclusions, groupExclusions, nodeCoverage, tolerates, type DaemonPodSpec } from '../../../client/src/components/detail/daemon-placement';

function node(name: string, labels: Record<string, string> = {}, taints: Array<{ key: string; value?: string; effect: string }> = []): KubeObject {
  return { apiVersion: 'v1', kind: 'Node', metadata: { name, uid: `node-${name}`, labels: { 'kubernetes.io/hostname': name, ...labels } }, spec: { taints } } as KubeObject;
}

function daemonPod(name: string, nodeName: string | undefined, status: Record<string, unknown>, pinned?: string): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'infra', uid: `uid-${name}`, ownerReferences: [{ kind: 'DaemonSet', name: 'agent', uid: 'ds', controller: true }] },
    spec: {
      containers: [{ name: 'agent' }],
      ...(nodeName && { nodeName }),
      ...(pinned && { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [pinned] }] }] } } } }),
    },
    status,
  } as unknown as KubeObject;
}

const running = { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true, state: { running: {} } }] };

describe('tolerates', () => {
  it('follows the Kubernetes matching rules', () => {
    const taint = { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' };
    expect(tolerates({ key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }, taint)).toBe(true);
    expect(tolerates({ key: 'dedicated', value: 'gpu' }, taint)).toBe(true);
    expect(tolerates({ key: 'dedicated', value: 'cpu' }, taint)).toBe(false);
    expect(tolerates({ key: 'dedicated', operator: 'Exists' }, taint)).toBe(true);
    expect(tolerates({ operator: 'Exists' }, taint)).toBe(true);
    expect(tolerates({ key: 'dedicated', operator: 'Exists', effect: 'NoExecute' }, taint)).toBe(false);
    expect(tolerates({ value: 'gpu' }, taint)).toBe(false);
  });
});

describe('daemonNodeExclusions', () => {
  it('names the selector, affinity and taints that leave a node out', () => {
    const spec: DaemonPodSpec = {
      nodeSelector: { disk: 'ssd' },
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'zone', operator: 'In', values: ['a', 'b'] }] }] } } },
    };
    expect(daemonNodeExclusions(node('n1', { disk: 'ssd', zone: 'a' }), spec)).toEqual([]);
    expect(daemonNodeExclusions(node('n2', { disk: 'hdd', zone: 'c' }, [{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }]), spec)).toEqual([
      'nodeSelector disk=ssd not matched',
      'required node affinity not matched',
      'taint dedicated=gpu:NoSchedule not tolerated',
    ]);
  });

  it('applies the tolerations every daemon pod gets, and ignores soft taints', () => {
    const cordoned = node('n3', {}, [
      { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' },
      { key: 'node.kubernetes.io/not-ready', effect: 'NoExecute' },
      { key: 'spot', effect: 'PreferNoSchedule' },
    ]);
    expect(daemonNodeExclusions(cordoned, {})).toEqual([]);
    const controlPlane = node('cp', {}, [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }]);
    expect(daemonNodeExclusions(controlPlane, {})).toEqual(['taint node-role.kubernetes.io/control-plane:NoSchedule not tolerated']);
    expect(daemonNodeExclusions(controlPlane, { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }] })).toEqual([]);
  });

  it('evaluates matchFields, NotIn, DoesNotExist and Gt terms', () => {
    const terms = (req: Record<string, unknown>, field = false) => ({
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [field ? { matchFields: [req] } : { matchExpressions: [req] }] } } },
    });
    const n = node('n4', { cores: '16', arch: 'arm64' });
    expect(daemonNodeExclusions(n, terms({ key: 'metadata.name', operator: 'NotIn', values: ['n4'] }, true))).toEqual(['required node affinity not matched']);
    expect(daemonNodeExclusions(n, terms({ key: 'arch', operator: 'NotIn', values: ['amd64'] }))).toEqual([]);
    expect(daemonNodeExclusions(n, terms({ key: 'gpu', operator: 'DoesNotExist' }))).toEqual([]);
    expect(daemonNodeExclusions(n, terms({ key: 'cores', operator: 'Gt', values: ['8'] }))).toEqual([]);
    expect(daemonNodeExclusions(n, terms({ key: 'cores', operator: 'Lt', values: ['8'] }))).toEqual(['required node affinity not matched']);
  });
});

describe('nodeCoverage', () => {
  it('sorts nodes needing attention first and says what each is doing', () => {
    const nodes = [node('a-ok'), node('b-pending'), node('c-missing'), node('d-tainted', {}, [{ key: 'dedicated', effect: 'NoSchedule' }]), node('e-crash'), node('f-stray', {}, [{ key: 'dedicated', effect: 'NoExecute' }])];
    const pods = [
      daemonPod('agent-a', 'a-ok', running),
      daemonPod('agent-b', undefined, { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/6 nodes are available: 1 Insufficient memory.' }] }, 'b-pending'),
      daemonPod('agent-e', 'e-crash', { phase: 'Running', containerStatuses: [{ name: 'agent', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }),
      daemonPod('agent-f', 'f-stray', running),
    ];
    const coverage = nodeCoverage(nodes, pods, {});
    expect(coverage.map((c) => [c.node, c.state])).toEqual([
      ['b-pending', 'pending'],
      ['c-missing', 'missing'],
      ['e-crash', 'not-ready'],
      ['f-stray', 'misscheduled'],
      ['d-tainted', 'excluded'],
      ['a-ok', 'running'],
    ]);
    expect(coverage[0]!.issue?.short).toBe('Insufficient memory');
    expect(coverage[2]!.podStatus).toBe('CrashLoopBackOff');
    expect(coverage[3]!.exclusions).toEqual(['taint dedicated:NoExecute not tolerated']);
    expect(coverage[4]!.exclusions).toEqual(['taint dedicated:NoSchedule not tolerated']);
  });
});

describe('groupExclusions', () => {
  it('folds excluded nodes by their shared reasons, largest group first', () => {
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`cpu-${i}`)),
      node('infra-0', { gpu: 'true' }, [{ key: 'dedicated', value: 'infra', effect: 'NoSchedule' }]),
      node('gpu-0', { gpu: 'true' }),
    ];
    const coverage = nodeCoverage(nodes, [daemonPod('agent-g', 'gpu-0', running)], { nodeSelector: { gpu: 'true' } });
    expect(groupExclusions(coverage)).toEqual([
      { reasons: ['nodeSelector gpu=true not matched'], nodes: ['cpu-0', 'cpu-1', 'cpu-2', 'cpu-3', 'cpu-4'] },
      { reasons: ['taint dedicated=infra:NoSchedule not tolerated'], nodes: ['infra-0'] },
    ]);
  });
});

describe('coverageKey', () => {
  it('changes only when what the row shows changes', () => {
    const nodes = [node('n1')];
    const pending = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available: 1 Insufficient cpu.' }] };
    const first = nodeCoverage(nodes, [daemonPod('agent-1', undefined, pending, 'n1')], {})[0]!;
    // A later poll: fresh objects, same content.
    const again = nodeCoverage(nodes, [daemonPod('agent-1', undefined, { ...pending }, 'n1')], {})[0]!;
    expect(again).not.toBe(first);
    expect(coverageKey(again)).toBe(coverageKey(first));
    const scheduled = nodeCoverage(nodes, [daemonPod('agent-1', 'n1', running)], {})[0]!;
    expect(coverageKey(scheduled)).not.toBe(coverageKey(first));
  });
});
