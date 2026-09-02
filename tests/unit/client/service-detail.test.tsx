import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { ServiceDetail, endpointRows } from '../../../client/src/components/detail/ServiceDetail';
import { useDetailStore } from '../../../client/src/state/detail';

const queries = vi.hoisted(() => ({
  pods: [] as KubeObject[],
  slices: undefined as KubeObject[] | undefined,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResourceList: (selection: { plural?: string } | undefined) => {
    if (selection) queries.requests.push(selection);
    if (!selection) return { data: undefined, isLoading: false };
    if (selection.plural === 'endpointslices') return { data: queries.slices ? { items: queries.slices } : undefined, isLoading: !queries.slices };
    return { data: { items: queries.pods }, isLoading: false };
  },
  useResourceMetrics: () => ({ data: undefined }),
}));
vi.mock('../../../client/src/components/PortForwardDialog.js', () => ({
  PortForwardDialog: ({ initialRemotePort }: { initialRemotePort?: number }) => <div>Forward dialog {initialRemotePort}</div>,
}));

function service(spec: Record<string, unknown>, status: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'web', namespace: 'team-a', uid: 'svc-uid', labels: { app: 'web' } },
    spec,
    status,
  } as KubeObject;
}

function slice(endpoints: Array<Record<string, unknown>>): KubeObject {
  return { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: { name: 'web-abc', uid: 'slice', namespace: 'team-a' }, endpoints } as KubeObject;
}

function pod(name: string, ready: boolean): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'team-a', uid: `uid-${name}` },
    spec: { containers: [{ name: 'app' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'app', ready, state: { running: {} } }] },
  } as unknown as KubeObject;
}

/** Value tile of the summary strip, addressed by its label (a <dt> has no accessible name of its own). */
const tile = (label: string) => {
  const term = screen.getAllByRole('term').find((el) => el.textContent === label);
  if (!term) throw new Error(`no summary tile labelled ${label}`);
  return term.nextElementSibling;
};

beforeEach(() => {
  queries.pods = [pod('web-a', true), pod('web-b', false)];
  queries.slices = [
    slice([
      { addresses: ['10.0.0.1'], conditions: { ready: true }, targetRef: { kind: 'Pod', name: 'web-a' }, nodeName: 'node-1' },
      { addresses: ['10.0.0.2'], conditions: { ready: false }, targetRef: { kind: 'Pod', name: 'web-b' }, nodeName: 'node-2' },
    ]),
  ];
  queries.requests = [];
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, pendingDiscard: undefined });
});

describe('endpointRows', () => {
  it('flattens slices and sorts problems first', () => {
    const rows = endpointRows([
      slice([
        { addresses: ['10.0.0.9'], conditions: { ready: true }, targetRef: { kind: 'Pod', name: 'p9' } },
        { addresses: ['10.0.0.3'], conditions: { ready: true, terminating: true }, targetRef: { kind: 'Pod', name: 'p3' } },
      ]),
      slice([{ addresses: ['10.0.0.1', 'fd00::1'], conditions: { ready: false }, targetRef: { kind: 'Node', name: 'n1' } }]),
    ]);
    expect(rows).toEqual([
      { address: '10.0.0.1, fd00::1', state: 'NotReady', pod: undefined, node: undefined },
      { address: '10.0.0.3', state: 'Terminating', pod: 'p3', node: undefined },
      { address: '10.0.0.9', state: 'Ready', pod: 'p9', node: undefined },
    ]);
  });
});

describe('ServiceDetail', () => {
  it('shows the address, ports, endpoints and backing pods of a ClusterIP service', () => {
    render(
      <ServiceDetail
        obj={service({
          type: 'ClusterIP',
          clusterIP: '10.96.0.10',
          selector: { app: 'web' },
          ports: [
            { name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' },
            { name: 'dns', port: 53, targetPort: 53, protocol: 'UDP' },
          ],
          ipFamilies: ['IPv4'],
        })}
        ctx="dev"
      />,
    );

    expect(queries.requests.find((r) => r.plural === 'endpointslices')).toMatchObject({
      group: 'discovery.k8s.io',
      namespace: 'team-a',
      labelSelector: 'kubernetes.io/service-name=web',
    });
    expect(tile('Endpoints')).toHaveTextContent('1/2');
    expect(screen.getByText('web.team-a.svc.cluster.local')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy DNS name' })).toBeInTheDocument();
    expect(screen.getByText('→ http')).toBeInTheDocument();
    expect(screen.getByText('1 ready · 1 not ready')).toBeInTheDocument();
    expect(screen.getByText('NotReady')).toBeInTheDocument();
    // The selector doubles as the Matching pods summary.
    expect(screen.getByText('Matching pods').parentElement).toHaveTextContent('app=web');
    expect(screen.queryByText('No ready endpoints')).not.toBeInTheDocument();

    // Only TCP ports can be forwarded.
    expect(screen.queryByRole('button', { name: 'Forward port 53' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forward port 80' }));
    expect(screen.getByText('Forward dialog 80')).toBeInTheDocument();

    // Endpoint rows navigate to their pod.
    fireEvent.click(screen.getAllByRole('button', { name: 'web-b' })[0]!);
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Pod', name: 'web-b', namespace: 'team-a' });
  });

  it('warns when the selector matches nothing', () => {
    queries.pods = [];
    queries.slices = [];
    render(<ServiceDetail obj={service({ type: 'ClusterIP', clusterIP: '10.96.0.10', selector: { app: 'nothing' } })} ctx="dev" />);

    expect(tile('Endpoints')).toHaveTextContent('0/0');
    expect(screen.getByText('No endpoints')).toBeInTheDocument();
    expect(screen.getByText('The selector matches no pods')).toBeInTheDocument();
  });

  it('warns when pods exist but none is ready', () => {
    queries.slices = [slice([{ addresses: ['10.0.0.2'], conditions: { ready: false }, targetRef: { kind: 'Pod', name: 'web-b' } }])];
    render(<ServiceDetail obj={service({ type: 'ClusterIP', clusterIP: '10.96.0.10', selector: { app: 'web' } })} ctx="dev" />);

    expect(screen.getByText('No ready endpoints')).toBeInTheDocument();
    expect(screen.getByText('1 endpoint, none ready')).toBeInTheDocument();
  });

  it('describes ExternalName and selector-less services without endpoint noise', () => {
    const { unmount } = render(<ServiceDetail obj={service({ type: 'ExternalName', externalName: 'db.example.com' })} ctx="dev" />);
    expect(tile('External name')).toHaveTextContent('db.example.com');
    expect(screen.getAllByRole('term').some((el) => el.textContent === 'Endpoints')).toBe(false);
    expect(queries.requests.some((r) => r.plural === 'endpointslices')).toBe(false);
    unmount();

    queries.slices = [];
    render(<ServiceDetail obj={service({ type: 'ClusterIP', clusterIP: 'None' })} ctx="dev" />);
    expect(screen.getByText('ClusterIP · headless')).toBeInTheDocument();
    expect(screen.getByText(/No selector — endpoints for this Service are managed manually/)).toBeInTheDocument();
    expect(screen.queryByText('No endpoints')).not.toBeInTheDocument();
  });

  it('surfaces load balancer and external addresses', () => {
    render(
      <ServiceDetail
        obj={service(
          { type: 'LoadBalancer', clusterIP: '10.96.1.1', externalIPs: ['203.0.113.5'], selector: { app: 'web' }, ports: [{ port: 443, nodePort: 30443 }] },
          { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } },
        )}
        ctx="dev"
      />,
    );
    expect(tile('External')).toHaveTextContent('203.0.113.5, lb.example.com');
    expect(screen.getByText('Node port')).toBeInTheDocument();
    expect(screen.getByText('30443')).toBeInTheDocument();
  });
});
