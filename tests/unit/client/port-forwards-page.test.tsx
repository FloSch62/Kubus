import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { PortForwardsPage } from '../../../client/src/pages/PortForwardsPage';
import { forwardTargets } from '../../../client/src/components/PortForwardPicker';
import { useClustersStore } from '../../../client/src/state/clusters';

const fixtures = vi.hoisted(() => ({
  services: [] as Array<{ ctx: string; obj: unknown }>,
  pods: [] as Array<{ ctx: string; obj: unknown }>,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  usePortForwards: () => ({ data: [], isLoading: false }),
  useStopPortForward: () => ({ mutate: vi.fn() }),
  useStopAllPortForwards: () => ({ mutate: vi.fn(), isPending: false }),
  useWatchedList: (_contexts: string[], _group: string, _version: string, plural: string) => ({
    rows: plural === 'services' ? fixtures.services : fixtures.pods,
    status: {},
  }),
}));
vi.mock('../../../client/src/components/PortForwardDialog.js', () => ({
  PortForwardDialog: ({ kind, obj }: { kind: string; obj: KubeObject }) => (
    <p>
      Forward {kind}/{obj.metadata.name}
    </p>
  ),
}));

function service(name: string, namespace: string, ports: Array<{ port: number; name?: string; protocol?: string }>, type = 'ClusterIP') {
  return { ctx: 'kind-a', obj: { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, uid: `svc-${name}` }, spec: { type, ports } } as KubeObject };
}
function pod(name: string, phase: string, ports: Array<{ containerPort: number; name?: string }> = []) {
  return {
    ctx: 'kind-a',
    obj: { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'demo', uid: `pod-${name}` }, spec: { containers: [{ name: 'app', ports }] }, status: { phase } } as KubeObject,
  };
}

beforeEach(() => {
  useClustersStore.setState({ selected: ['kind-a'], namespaces: [], namespacesByContext: {} });
  fixtures.services = [service('web', 'demo', [{ port: 80, name: 'http' }, { port: 53, protocol: 'UDP' }]), service('ext', 'demo', [], 'ExternalName')];
  fixtures.pods = [pod('web-1', 'Running', [{ containerPort: 8080, name: 'http' }]), pod('job-1', 'Succeeded')];
});

describe('forwardTargets', () => {
  it('lists services first, then running pods, with their TCP ports', () => {
    const targets = forwardTargets(fixtures.services as never, fixtures.pods as never);
    expect(targets.map((t) => `${t.kind}/${t.obj.metadata.name}: ${t.ports}`)).toEqual(['Service/web: 80 · http', 'Pod/web-1: 8080 · http']);
  });
});

describe('PortForwardsPage', () => {
  it('starts a forward straight from the empty state', () => {
    render(<PortForwardsPage />);
    expect(screen.getByText('No active forwards')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start a forward…' }));
    expect(screen.getByText('Start a port forward')).toBeInTheDocument();
    expect(screen.getByText('80 · http')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Find a service or pod to forward'), { target: { value: 'web-1' } });
    expect(screen.queryByText('80 · http')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Find a service or pod to forward'), { key: 'Enter' });
    expect(screen.getByText('Forward Pod/web-1')).toBeInTheDocument();
  });
});
