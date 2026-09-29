import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { POD_ROW_LIMIT, PodMiniList } from '../../../client/src/components/detail/PodMiniList';
import { useDetailStore } from '../../../client/src/state/detail';

vi.mock('../../../client/src/api/queries.js', () => ({ useResourceMetrics: () => ({ data: undefined }) }));

function pod(name: string, owner: { kind: string; name: string } | undefined, status: Record<string, unknown> = { phase: 'Running', containerStatuses: [{ name: 'c', ready: true, state: { running: {} } }] }, spec: Record<string, unknown> = { nodeName: 'node-a' }): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'kube-system', uid: `uid-${name}`, ownerReferences: owner ? [{ ...owner, uid: `owner-${owner.name}`, controller: true }] : [] },
    spec: { containers: [{ name: 'c' }], ...spec },
    status,
  } as unknown as KubeObject;
}

beforeEach(() => {
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
});

describe('PodMiniList', () => {
  it('marks DaemonSet pods on a node and filters them apart', () => {
    const pods = [pod('kube-proxy-x', { kind: 'DaemonSet', name: 'kube-proxy' }), pod('kindnet-y', { kind: 'DaemonSet', name: 'kindnet' }), pod('coredns-z', { kind: 'ReplicaSet', name: 'coredns-1' })];
    render(<PodMiniList ctx="dev" pods={pods} daemonSets />);

    expect(screen.getAllByText('DS')).toHaveLength(2);
    expect(screen.getByLabelText('Managed by DaemonSet kube-proxy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'DaemonSet 2' }));
    expect(screen.queryByText('coredns-z')).not.toBeInTheDocument();
    expect(screen.getByText('kube-proxy-x')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Other 1' }));
    expect(screen.getByText('coredns-z')).toBeInTheDocument();
    expect(screen.queryByText('kube-proxy-x')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All 3' }));
    expect(screen.getByText('kindnet-y')).toBeInTheDocument();
  });

  it('offers no owner chips without DaemonSet pods', () => {
    render(<PodMiniList ctx="dev" pods={[pod('web-1', { kind: 'ReplicaSet', name: 'web' })]} daemonSets />);
    expect(screen.queryByRole('button', { name: /^All/ })).not.toBeInTheDocument();
    expect(screen.queryByText('DS')).not.toBeInTheDocument();
  });

  it('caps a long list, leading with the pods that need attention, and shows all on request', () => {
    const healthy = Array.from({ length: POD_ROW_LIMIT + 10 }, (_, i) => pod(`web-${i}`, { kind: 'ReplicaSet', name: 'web' }));
    const crashing = pod('web-99', { kind: 'ReplicaSet', name: 'web' }, { phase: 'Running', containerStatuses: [{ name: 'c', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] });
    render(<PodMiniList ctx="dev" pods={[...healthy, crashing]} hideNamespace />);

    const names = () => screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td')!.textContent);
    expect(names()).toHaveLength(POD_ROW_LIMIT);
    // The crashlooping pod sorts last by name but leads the cut-down list.
    expect(names()[0]).toBe('web-99');
    expect(screen.getByText(`Showing ${POD_ROW_LIMIT} of ${POD_ROW_LIMIT + 11} pods, those needing attention first.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Show all ${POD_ROW_LIMIT + 11}` }));
    // Everything shown: back to natural order.
    expect(names()).toHaveLength(POD_ROW_LIMIT + 11);
    expect(names().slice(0, 3)).toEqual(['web-0', 'web-1', 'web-2']);
    expect(names().at(-1)).toBe('web-99');
  });

  it('keeps short lists in natural order without a cap', () => {
    const pods = ['web-10', 'web-2', 'web-1'].map((name) => pod(name, { kind: 'ReplicaSet', name: 'web' }));
    render(<PodMiniList ctx="dev" pods={pods} hideNamespace />);
    expect(screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td')!.textContent)).toEqual(['web-1', 'web-2', 'web-10']);
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  it('puts the scheduler’s short reason under a Pending pod and links the node it waits for', () => {
    const pending = pod(
      'agent-p',
      { kind: 'DaemonSet', name: 'agent' },
      { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 1 Insufficient memory.' }] },
      { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-b'] }] }] } } } },
    );
    render(<PodMiniList ctx="dev" pods={[pending]} hideNamespace />);

    expect(screen.getByText(/Insufficient memory/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'node-b' }));
    // The node link opens the node, not the pod row it sits in.
    expect(useDetailStore.getState().stack).toHaveLength(1);
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Node', name: 'node-b' });
  });
});
