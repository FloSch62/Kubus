import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  ResourceDetailDrawer,
  ResourceDetailPanel,
  type ResourceSelection,
} from '../../../client/src/components/ResourceDetailDrawer';
import { useDetailStore } from '../../../client/src/state/detail';

const queries = vi.hoisted(() => ({
  current: undefined as KubeObject | undefined,
  backing: undefined as KubeObject | undefined,
  events: [] as KubeObject[],
  resourceCalls: [] as Array<{ selection: Record<string, unknown> | undefined; options?: Record<string, unknown> }>,
  eventsCalls: [] as Array<Record<string, unknown> | undefined>,
  refetch: vi.fn(),
  applyMode: 'success' as 'success' | 'conflict' | 'error',
  applyMutateAsync: vi.fn(),
  dryRunMutateAsync: vi.fn(),
}));

const effects = vi.hoisted(() => ({
  yamlSchema: vi.fn(),
  yamlError: vi.fn(),
  detailProps: [] as Array<{ name: string; kind: string }>,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResource: (selection: Record<string, unknown> | undefined, options?: Record<string, unknown>) => {
    queries.resourceCalls.push({ selection, options });
    const data = !selection
      ? undefined
      : selection.name === queries.current?.metadata.name
        ? queries.current
        : selection.plural === 'customresourcedefinitions'
          ? queries.backing
          : queries.current;
    return { data, refetch: queries.refetch };
  },
  useResourceEvents: (selection: Record<string, unknown> | undefined) => {
    queries.eventsCalls.push(selection);
    return { data: { items: queries.events } };
  },
  useApplyResource: () => ({ mutateAsync: queries.applyMutateAsync }),
  useDryRunResource: () => ({ mutateAsync: queries.dryRunMutateAsync }),
}));

vi.mock('../../../client/src/components/YamlEditor.js', () => ({
  useYamlSchema: (selection: unknown) => effects.yamlSchema(selection),
  YamlEditor: ({
    value,
    applyLabel,
    onApply,
    onDryRun,
    toolbar,
  }: {
    value: string;
    applyLabel?: string;
    onApply?: (value: string) => Promise<unknown>;
    onDryRun?: (value: string) => Promise<unknown>;
    toolbar?: ReactNode;
  }) => (
    <div data-testid="yaml-editor">
      {toolbar}
      <textarea aria-label="YAML input" value={value} readOnly />
      <span>{applyLabel}</span>
      <button onClick={() => void onApply?.(value).catch((error: unknown) => effects.yamlError(error))}>Apply YAML mock</button>
      <button onClick={() => void onDryRun?.(value)}>Dry run YAML mock</button>
    </div>
  ),
}));

vi.mock('../../../client/src/components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, title, onConfirm, onClose }: { open: boolean; title: string; onConfirm: () => void; onClose: () => void }) =>
    open ? (
      <dialog open aria-label={title}>
        {title}
        <button onClick={onConfirm}>Confirm discard mock</button>
        <button onClick={onClose}>Cancel discard mock</button>
      </dialog>
    ) : null,
}));

vi.mock('../../../client/src/components/detail/GenericDetail.js', () => ({
  GenericDetail: ({ obj }: { obj: KubeObject }) => <div>Generic overview {obj.metadata.name}</div>,
}));
vi.mock('../../../client/src/components/detail/ConfigMapDetail.js', () => ({ ConfigMapDetail: ({ obj }: { obj: KubeObject }) => <div>ConfigMap overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/DataEditor.js', () => ({
  DataEditor: ({ sel, isSecret, onDirtyChange }: { sel: ResourceSelection; isSecret: boolean; onDirtyChange: (dirty: boolean) => void }) => (
    <div>
      Data editor {sel.name} secret={String(isSecret)}
      <button onClick={() => onDirtyChange(true)}>Make data dirty</button>
      <button onClick={() => onDirtyChange(false)}>Make data clean</button>
    </div>
  ),
}));
vi.mock('../../../client/src/components/detail/DeploymentDetail.js', () => ({ DeploymentDetail: ({ obj }: { obj: KubeObject }) => <div>Deployment overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/PodDetail.js', () => ({ PodDetail: ({ obj }: { obj: KubeObject }) => <div>Pod overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/NodeDetail.js', () => ({ NodeDetail: ({ obj }: { obj: KubeObject }) => <div>Node overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/ServiceDetail.js', () => ({ ServiceDetail: ({ obj }: { obj: KubeObject }) => <div>Service overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/SecretDetail.js', () => ({ SecretDetail: ({ obj }: { obj: KubeObject }) => <div>Secret overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/CertificateDetail.js', () => ({ CertificateDetail: ({ obj }: { obj: KubeObject }) => <div>Certificate overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/CustomResourceDetail.js', () => ({ CustomResourceDetail: ({ obj }: { obj: KubeObject }) => <div>Custom overview {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/detail/CrdDetail.js', () => ({
  crdVersions: (obj: KubeObject | undefined) => ((obj?.spec as { versions?: unknown[] } | undefined)?.versions ?? []),
  CrdDetail: ({ obj }: { obj: KubeObject }) => <div>CRD overview {obj.metadata.name}</div>,
  CrdSchemaDetail: ({ versionName }: { versionName: string }) => <div>CRD schema {versionName}</div>,
}));
vi.mock('../../../client/src/components/detail/RolloutHistory.js', () => ({ RolloutHistory: ({ obj }: { obj: KubeObject }) => <div>Rollout history {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/MetricsChart.js', () => ({ MetricsChart: ({ kind, name }: { kind: string; name: string }) => <div>Metrics {kind} {name}</div> }));
vi.mock('../../../client/src/components/TopologyGraph.js', () => ({ TopologyGraph: ({ focus }: { focus: { name: string } }) => <div>Topology {focus.name}</div> }));
vi.mock('../../../client/src/components/RowActions.js', () => ({
  RowLogsButton: ({ target }: { target: { obj: KubeObject } }) => <button>Logs {target.obj.metadata.name}</button>,
  RowActions: ({ target }: { target: { obj: KubeObject } }) => <button>Actions {target.obj.metadata.name}</button>,
}));
vi.mock('../../../client/src/components/AgeCell.js', () => ({ AgeCell: ({ timestamp }: { timestamp?: string }) => <span>{timestamp ? 'age' : 'unknown age'}</span> }));
vi.mock('../../../client/src/components/truncation.js', () => ({ TruncationTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));

function selection(kind: string, overrides: Partial<ResourceSelection> = {}): ResourceSelection {
  const byKind: Record<string, Pick<ResourceSelection, 'group' | 'version' | 'plural'>> = {
    Pod: { group: '', version: 'v1', plural: 'pods' },
    Node: { group: '', version: 'v1', plural: 'nodes' },
    Service: { group: '', version: 'v1', plural: 'services' },
    ConfigMap: { group: '', version: 'v1', plural: 'configmaps' },
    Secret: { group: '', version: 'v1', plural: 'secrets' },
    Deployment: { group: 'apps', version: 'v1', plural: 'deployments' },
    StatefulSet: { group: 'apps', version: 'v1', plural: 'statefulsets' },
    DaemonSet: { group: 'apps', version: 'v1', plural: 'daemonsets' },
    CustomResourceDefinition: { group: 'apiextensions.k8s.io', version: 'v1', plural: 'customresourcedefinitions' },
  };
  return {
    ctx: 'dev',
    ...(byKind[kind] ?? { group: 'example.io', version: 'v1', plural: 'widgets' }),
    kind,
    name: kind === 'Node' ? 'node-a' : `${kind.toLowerCase()}-a`,
    namespace: kind === 'Node' || kind === 'CustomResourceDefinition' ? undefined : 'team-a',
    ...overrides,
  };
}

function objectFor(sel: ResourceSelection, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: sel.group ? `${sel.group}/${sel.version}` : sel.version,
    kind: sel.kind,
    metadata: {
      name: sel.name,
      namespace: sel.namespace,
      uid: `uid-${sel.name}`,
      creationTimestamp: '2026-07-22T10:00:00Z',
    },
    ...extra,
  } as KubeObject;
}

function event(name: string, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name, uid: `uid-${name}`, creationTimestamp: '2026-07-22T10:00:00Z' },
    ...extra,
  } as KubeObject;
}

beforeEach(() => {
  const pod = selection('Pod');
  queries.current = objectFor(pod);
  queries.backing = undefined;
  queries.events = [];
  queries.resourceCalls = [];
  queries.eventsCalls = [];
  queries.refetch.mockReset();
  queries.applyMode = 'success';
  queries.applyMutateAsync.mockReset();
  queries.applyMutateAsync.mockImplementation(async () => {
    if (queries.applyMode === 'conflict') {
      const error = new Error('stale object') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    if (queries.applyMode === 'error') throw new Error('apply failed');
    return {};
  });
  queries.dryRunMutateAsync.mockReset().mockResolvedValue({ ok: true, findings: [] });
  effects.yamlSchema.mockClear();
  effects.yamlError.mockClear();
  effects.detailProps = [];
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, pendingDiscard: undefined });
});

describe('ResourceDetailDrawer', () => {
  it('routes a pod through map, YAML, events, metrics, fullscreen, keyboard, and error paths', async () => {
    const sel = selection('Pod');
    queries.current = objectFor(sel, { spec: { containers: [{ name: 'app' }] } });
    queries.events = [
      event('warning', { type: 'Warning', reason: 'FailedMount', message: 'volume missing', count: 3, lastTimestamp: '2026-07-22T10:10:00Z' }),
      event('normal', { type: 'Normal', reason: 'Started', message: 'container started', count: 1 }),
    ];
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(<ResourceDetailPanel sel={sel} onBack={onBack} onClose={onClose} />);

    expect(screen.getByText('Pod overview pod-a')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Metrics' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Full screen')).not.toBeInTheDocument();
    expect(effects.yamlSchema).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Pod' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    expect(screen.getByText('Topology pod-a')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Full screen'));
    expect(screen.getByLabelText('Restore drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Restore drawer'));

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(screen.getByTestId('yaml-editor')).toHaveTextContent('Replace');
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).toContain('name: pod-a');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run YAML mock' }));
    expect(queries.dryRunMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'dev' }));

    queries.applyMode = 'conflict';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(effects.yamlError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('view has been refreshed') })));
    expect(queries.refetch).toHaveBeenCalled();
    queries.applyMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(effects.yamlError).toHaveBeenCalledWith(expect.objectContaining({ message: 'apply failed' })));
    queries.applyMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));

    fireEvent.keyDown(screen.getByLabelText('YAML input'), { key: 'ArrowLeft', altKey: true });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText('pod-a'), { key: 'ArrowLeft', altKey: true, ctrlKey: true });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText('pod-a'), { key: 'ArrowLeft', altKey: true });
    expect(onBack).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByText(/FailedMount ×3/)).toBeInTheDocument();
    expect(screen.getByText('volume missing')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByText('Metrics pod pod-a')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Back'));
    fireEvent.click(screen.getByLabelText('Close resource details'));
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);

  it('guards dirty ConfigMap data before changing tabs or closing', () => {
    const sel = selection('ConfigMap');
    queries.current = objectFor(sel, { data: { key: 'value' } });
    const onClose = vi.fn();
    render(<ResourceDetailDrawer sel={sel} onClose={onClose} inline />);

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(screen.getByText('Data editor configmap-a secret=false')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make data dirty' }));
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(screen.getByText('Data editor configmap-a secret=false')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Discard data changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel discard mock' }));
    expect(screen.queryByRole('dialog', { name: 'Discard data changes?' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard mock' }));
    expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make data clean' }));
    fireEvent.click(screen.getByLabelText('Close resource details'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reveals Secret YAML and resets the per-selection view state', () => {
    const secretSel = selection('Secret');
    queries.current = objectFor(secretSel, { data: { password: btoa('secret') } });
    const view = render(<ResourceDetailDrawer sel={secretSel} onClose={vi.fn()} />);

    expect(screen.getByText('Secret overview secret-a')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Full screen'));
    expect(screen.getByLabelText('Restore drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret data' }));
    expect(queries.resourceCalls.some(({ selection: call }) => call?.reveal === true)).toBe(true);

    const next = selection('Secret', { name: 'other-secret' });
    queries.current = objectFor(next, { data: {} });
    view.rerender(<ResourceDetailDrawer sel={next} onClose={vi.fn()} />);
    expect(screen.getByText('Secret overview other-secret')).toBeInTheDocument();
    view.rerender(<ResourceDetailDrawer sel={undefined} onClose={vi.fn()} />);
    expect(screen.queryByText('other-secret')).not.toBeInTheDocument();
  });

  it('shows CRD schemas and navigates custom resources to their backing definition', () => {
    const crdSel = selection('CustomResourceDefinition', { name: 'widgets.example.io' });
    queries.current = objectFor(crdSel, { spec: { versions: [{ name: 'v1', served: true, storage: true }] } });
    const first = render(<ResourceDetailPanel sel={crdSel} onClose={vi.fn()} />);
    expect(screen.getByText('CRD overview widgets.example.io')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Map' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'v1' }));
    expect(screen.getByText('CRD schema v1')).toBeInTheDocument();
    first.unmount();

    const customSel = selection('Widget', { custom: true, name: 'blue-widget' });
    queries.current = objectFor(customSel);
    queries.backing = objectFor(crdSel, { spec: { versions: [{ name: 'v1' }] } });
    render(<ResourceDetailPanel sel={customSel} onClose={vi.fn()} />);
    expect(screen.getByText('Custom overview blue-widget')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Open CRD widgets.example.io'));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({
      kind: 'CustomResourceDefinition',
      name: 'widgets.example.io',
    });
  });

  it('selects every registered overview and custom fallback, including release history and certificates', () => {
    const cases = [
      ['Deployment', 'Deployment overview deployment-a'],
      ['Node', 'Node overview node-a'],
      ['Service', 'Service overview service-a'],
      ['ConfigMap', 'ConfigMap overview configmap-a'],
      ['Secret', 'Secret overview secret-a'],
      ['StatefulSet', 'Generic overview statefulset-a'],
      ['DaemonSet', 'Generic overview daemonset-a'],
    ] as const;

    for (const [kind, expected] of cases) {
      const sel = selection(kind);
      queries.current = objectFor(sel);
      const view = render(<ResourceDetailPanel sel={sel} onClose={vi.fn()} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
      if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) {
        fireEvent.click(screen.getByRole('tab', { name: 'History' }));
        expect(screen.getByText(`Rollout history ${sel.name}`)).toBeInTheDocument();
      }
      view.unmount();
    }

    const certificateSel = selection('Certificate', { custom: true, group: 'cert-manager.io', plural: 'certificates', name: 'site-tls' });
    const certificateCrd = selection('CustomResourceDefinition', { name: 'certificates.cert-manager.io' });
    queries.current = objectFor(certificateSel);
    queries.backing = objectFor(certificateCrd, { spec: { versions: [{ name: 'v1' }] } });
    const certificate = render(<ResourceDetailPanel sel={certificateSel} onClose={vi.fn()} />);
    expect(screen.getByText('Certificate overview site-tls')).toBeInTheDocument();
    certificate.unmount();

    const unknown = selection('Unknown', { custom: false, name: 'plain' });
    queries.current = objectFor(unknown);
    queries.backing = undefined;
    render(<ResourceDetailPanel sel={unknown} onClose={vi.fn()} />);
    expect(screen.getByText('Generic overview plain')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByText('No events.')).toBeInTheDocument();
  });
});
