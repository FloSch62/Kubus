import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { NodeDetail } from '../../../client/src/components/detail/NodeDetail';
import { ConfigMapDetail, PREVIEW_LINES } from '../../../client/src/components/detail/ConfigMapDetail';

const fixtures = vi.hoisted(() => ({
  pods: [] as KubeObject[],
  metrics: undefined as Map<string, unknown> | undefined,
  usedBy: [] as Array<{ ref: { kind: string; name: string }; relation: string }>,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  DETAIL_LIST_LIVE_MS: 5000,
  useResourceList: () => ({ data: { items: fixtures.pods }, isLoading: false }),
  useResourceMetrics: () => ({ data: fixtures.metrics }),
  useUsedBy: () => ({ data: { items: fixtures.usedBy, unavailable: [] }, isLoading: false, isError: false }),
  useReferences: () => ({ data: { items: [], unavailable: [] }, isLoading: false, isError: false }),
}));

function pod(
  name: string,
  phase: string,
  extra: { daemon?: boolean; cpu?: string; memory?: string; ephemeral?: string; status?: Record<string, unknown> } = {},
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'team-a',
      uid: `uid-${name}`,
      ownerReferences: extra.daemon ? [{ kind: 'DaemonSet', name: 'agent', controller: true, uid: 'ds', apiVersion: 'apps/v1' }] : [],
    },
    spec: {
      nodeName: 'node-a',
      containers: [
        {
          name: 'c',
          resources: { requests: { cpu: extra.cpu ?? '100m', memory: extra.memory ?? '64Mi', ...(extra.ephemeral && { 'ephemeral-storage': extra.ephemeral }) } },
        },
      ],
    },
    status: {
      phase,
      containerStatuses: [{ name: 'c', ready: phase === 'Running', state: phase === 'Running' ? { running: {} } : { terminated: { reason: 'Completed', exitCode: 0 } } }],
      ...extra.status,
    },
  } as unknown as KubeObject;
}

function node(capacity: Record<string, string>, allocatable: Record<string, string>): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: 'node-a', uid: 'node-uid', labels: { 'node-role.kubernetes.io/control-plane': '' } },
    spec: { podCIDR: '10.244.0.0/24' },
    status: {
      capacity,
      allocatable,
      nodeInfo: { kubeletVersion: 'v1.36.1', osImage: 'Debian GNU/Linux 13', architecture: 'amd64', containerRuntimeVersion: 'containerd://2.3.1', kernelVersion: '7.0' },
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  } as unknown as KubeObject;
}

const tile = (label: string) => {
  const term = screen.getAllByRole('term').find((el) => el.textContent === label);
  if (!term) throw new Error(`no summary tile labelled ${label}`);
  return term.nextElementSibling;
};

beforeEach(() => {
  fixtures.pods = [pod('a', 'Running'), pod('b', 'Running', { daemon: true, cpu: '1', memory: '1Gi' }), pod('c', 'Pending'), pod('done', 'Succeeded')];
  fixtures.metrics = new Map([['dev', { available: true, items: [{ name: 'node-a', cpuMilli: 250, memBytes: 2 * 1024 ** 3 }] }]]);
  fixtures.usedBy = [];
});

describe('NodeDetail', () => {
  const same = { cpu: '4', memory: '8Gi', pods: '110' };

  it('counts the pods that occupy the node the same way everywhere', () => {
    render(<NodeDetail obj={node(same, same)} ctx="dev" />);
    // Running and pending pods hold a slot; the completed one is a hint.
    expect(tile('Pods')).toHaveTextContent('3 / 110');
    expect(tile('Pods')?.nextElementSibling).toHaveTextContent('1 completed');
    const podsSection = screen.getByRole('button', { name: /Pods on this node/ });
    expect(podsSection).toHaveTextContent('3');
    expect(podsSection).toHaveTextContent('1 from DaemonSet');
    expect(screen.queryByText('done')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 completed' }));
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('Including 1 completed pod.')).toBeInTheDocument();
  });

  it('lists failed pods with why they stopped, without counting them against the node', () => {
    fixtures.pods = [
      pod('a', 'Running'),
      pod('evicted', 'Failed', { status: { reason: 'Evicted', message: 'The node was low on resource: memory. Threshold quantity: 100Mi, available: 20Mi.' } }),
      pod('oom', 'Failed', { status: { containerStatuses: [{ name: 'c', ready: false, state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } }),
      pod('done', 'Succeeded'),
    ];
    render(<NodeDetail obj={node(same, same)} ctx="dev" />);
    expect(tile('Pods')).toHaveTextContent('1 / 110');
    expect(tile('Pods')?.nextElementSibling).toHaveTextContent('2 failed');
    expect(screen.getByRole('button', { name: /Pods on this node/ })).toHaveTextContent('2 failed');
    expect(screen.getByText('evicted')).toBeInTheDocument();
    expect(screen.getByText('The node was low on resource: memory.')).toBeInTheDocument();
    expect(screen.getByText('c ran out of memory (OOMKilled)')).toBeInTheDocument();
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });

  it('shows ephemeral storage against allocatable even when nothing is reserved', () => {
    fixtures.pods = [pod('a', 'Running', { ephemeral: '1Gi' }), pod('b', 'Running', { ephemeral: '512Mi' })];
    const withDisk = { ...same, 'ephemeral-storage': '100Gi' };
    render(<NodeDetail obj={node(withDisk, withDisk)} ctx="dev" />);
    const allocation = screen.getByRole('columnheader', { name: 'Requested' }).closest('table')!;
    const row = within(allocation).getByText('Ephemeral storage').closest('tr')!;
    expect(row).toHaveTextContent('1.5Gi');
    expect(row).toHaveTextContent('100.0Gi');
    expect(within(row).getByTitle('metrics-server does not report disk use')).toHaveTextContent('—');
  });

  it('shows requested and used against allocatable, and drops a capacity table that repeats it', () => {
    render(<NodeDetail obj={node(same, same)} ctx="dev" />);
    expect(screen.getByRole('button', { name: /Allocation/ })).toHaveTextContent('nothing is reserved for the system');
    const allocation = screen.getByRole('columnheader', { name: 'Requested' }).closest('table')!;
    const cpuRow = within(allocation).getByText('CPU').closest('tr')!;
    // 100m + 1 core + 100m requested by the three active pods; 250m used.
    expect(cpuRow).toHaveTextContent('1.20 cores');
    expect(cpuRow).toHaveTextContent('250m');
    expect(cpuRow).toHaveTextContent('4 cores');
    const podsRow = within(allocation).getByText('Pods').closest('tr')!;
    expect(podsRow).toHaveTextContent('110');
    expect(screen.queryByRole('button', { name: /Capacity/ })).not.toBeInTheDocument();
    // System facts collapse to a one-line summary.
    expect(screen.getByRole('button', { name: /System/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('Debian GNU/Linux 13 · amd64 · containerd://2.3.1 · 10.244.0.0/24');
  });

  it('keeps the capacity table when the kubelet reserves some for the system, and copes without metrics', () => {
    fixtures.metrics = new Map([['dev', { available: false, items: [] }]]);
    render(<NodeDetail obj={node(same, { cpu: '3800m', memory: '7Gi', pods: '110' })} ctx="dev" />);
    expect(screen.getByRole('button', { name: /Capacity/ })).toBeInTheDocument();
    const cpuRow = screen.getByText('CPU').closest('tr')!;
    expect(within(cpuRow).getByTitle('No usage data: metrics-server is not reachable')).toHaveTextContent('—');
  });
});

describe('ConfigMapDetail', () => {
  const cm = (data: Record<string, string>, binaryData?: Record<string, string>): KubeObject =>
    ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'coredns', namespace: 'kube-system', uid: 'cm', creationTimestamp: '2026-07-22T10:00:00Z' }, data, binaryData }) as unknown as KubeObject;

  it('previews each value and expands it on request', () => {
    const corefile = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    render(<ConfigMapDetail obj={cm({ Corefile: corefile, short: 'on' }, { blob: 'AAAA' })} ctx="dev" />);
    expect(tile('Keys')).toHaveTextContent('3');
    expect(screen.getByText('Corefile')).toBeInTheDocument();
    expect(screen.getByText(/· 23 lines/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`line ${PREVIEW_LINES}$`, 'm'))).toBeInTheDocument();
    expect(screen.queryByText(/line 8/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 23 lines' }));
    expect(screen.getByText(/line 23/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(/line 23/)).not.toBeInTheDocument();
    // Short values have nothing to expand; binary keys list name and size only.
    expect(screen.getByText('on')).toBeInTheDocument();
    expect(screen.getByText('blob')).toBeInTheDocument();
    expect(screen.getByText('binary · 3B')).toBeInTheDocument();
  });

  it('summarizes who uses it, workloads first', () => {
    fixtures.usedBy = [
      { ref: { kind: 'Deployment', name: 'coredns' }, relation: 'mounts' },
      { ref: { kind: 'Pod', name: 'coredns-1' }, relation: 'mounts' },
      { ref: { kind: 'Pod', name: 'coredns-2' }, relation: 'mounts' },
    ];
    render(<ConfigMapDetail obj={cm({ Corefile: '.:53 {}' })} ctx="dev" />);
    expect(tile('Used by')).toHaveTextContent('1 Deployment');
    expect(screen.getByText('2 Pods')).toBeInTheDocument();
    // Metadata keeps what the drawer header does not show.
    expect(screen.getByText('API version')).toBeInTheDocument();
    expect(screen.queryByText('Cluster')).not.toBeInTheDocument();
  });
});
