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
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const queries = vi.hoisted(() => ({
  current: undefined as KubeObject | undefined,
  backing: undefined as KubeObject | undefined,
  events: [] as KubeObject[],
  resourceCalls: [] as Array<{ selection: Record<string, unknown> | undefined; options?: Record<string, unknown> }>,
  eventsCalls: [] as Array<Record<string, unknown> | undefined>,
  refetch: vi.fn(),
  refetchRevealed: vi.fn(),
  resourceError: null as Error | null,
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
  useUsedBy: () => ({ data: { items: [], unavailable: [], truncated: 0 }, isLoading: false, isError: false }),
  useResource: (selection: Record<string, unknown> | undefined, options?: Record<string, unknown>) => {
    queries.resourceCalls.push({ selection, options });
    const data = !selection
      ? undefined
      : selection.name === queries.current?.metadata.name
        ? queries.current
        : selection.plural === 'customresourcedefinitions'
          ? queries.backing
          : queries.current;
    return { data, refetch: selection?.reveal ? queries.refetchRevealed : queries.refetch, error: queries.resourceError };
  },
  isResourceGone: (error: unknown) => (error as { status?: number } | null)?.status === 404,
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
    draft,
    readOnly,
    applyLabel,
    onApply,
    onDryRun,
    onChange,
    toolbar,
  }: {
    value: string;
    draft?: string;
    readOnly?: boolean;
    applyLabel?: string;
    onApply?: (value: string) => Promise<unknown>;
    onDryRun?: (value: string) => Promise<unknown>;
    onChange?: (value: string) => void;
    toolbar?: ReactNode;
  }) => (
    <div data-testid="yaml-editor">
      {toolbar}
      <span>{readOnly ? 'read-only editor' : 'editable editor'}</span>
      <textarea aria-label="YAML input" value={value} readOnly />
      <textarea aria-label="YAML draft" value={draft ?? ''} readOnly />
      <span>{applyLabel}</span>
      <button onClick={() => void onApply?.(draft ?? value).catch((error: unknown) => effects.yamlError(error))}>Apply YAML mock</button>
      <button onClick={() => void onDryRun?.(value)}>Dry run YAML mock</button>
      <button onClick={() => onChange?.('kind: [')}>Type broken YAML</button>
      <button onClick={() => onChange?.('kind: Pod\nmetadata:\n  name: pod-a\nspec:\n  hostname: edited\n')}>Type valid YAML</button>
    </div>
  ),
}));

vi.mock('../../../client/src/components/detail/ManifestView.js', () => ({
  ManifestView: ({
    live,
    draft,
    readOnly,
    toolbarStart,
    toolbar,
    onDraftChange,
    onApplied,
    onConflict,
  }: {
    live: KubeObject;
    draft?: { obj: KubeObject };
    readOnly?: boolean;
    toolbarStart?: ReactNode;
    toolbar?: ReactNode;
    onDraftChange: (obj: KubeObject | undefined, base: KubeObject) => void;
    onApplied: (updated: KubeObject) => void;
    onConflict: () => void;
  }) => (
    <div data-testid="manifest-view">
      {toolbarStart}
      {toolbar}
      <span>Manifest {draft ? `draft ${JSON.stringify(draft.obj.spec)}` : 'clean'}</span>
      <span>{readOnly ? 'read-only' : 'editable'}</span>
      <button onClick={() => onDraftChange({ ...live, spec: { ...live.spec, replicas: 3 } }, live)}>Stage manifest edit</button>
      <button onClick={() => onDraftChange(undefined, live)}>Discard manifest draft</button>
      <button onClick={() => onApplied(live)}>Applied manifest mock</button>
      <button onClick={onConflict}>Manifest conflict mock</button>
    </div>
  ),
}));

vi.mock('../../../client/src/components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, title, message, onConfirm, onClose }: { open: boolean; title: string; message: string; onConfirm: () => void; onClose: () => void }) =>
    open ? (
      <dialog open aria-label={title}>
        {title}
        <p>{message}</p>
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
  CrdSchemaDetail: ({ versionName }: { versionName?: string }) => <div>CRD schema {versionName ?? 'default'}</div>,
}));
vi.mock('../../../client/src/components/detail/RolloutHistory.js', () => ({ RolloutHistory: ({ obj }: { obj: KubeObject }) => <div>Rollout history {obj.metadata.name}</div> }));
vi.mock('../../../client/src/components/MetricsChart.js', () => ({ MetricsChart: ({ kind, name }: { kind: string; name: string }) => <div>Metrics {kind} {name}</div> }));
vi.mock('../../../client/src/components/TopologyGraph.js', () => ({ TopologyGraph: ({ focus }: { focus: { name: string } }) => <div>Topology {focus.name}</div> }));
vi.mock('../../../client/src/components/RowActions.js', () => ({
  DetailQuickActions: ({ target }: { target: { obj: KubeObject } }) => <button>Quick actions {target.obj.metadata.name}</button>,
}));
vi.mock('../../../client/src/components/AgeCell.js', () => ({ useNow: () => Date.now(), AgeCell: ({ timestamp }: { timestamp?: string }) => <span>{timestamp ? 'age' : 'unknown age'}</span> }));
vi.mock('../../../client/src/components/truncation.js', () => ({ TruncationTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));

/** The YAML editor lives behind the Manifest tab's Tree/YAML toggle. */
function showYaml() {
  fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
  fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
}
const showTree = () => fireEvent.click(screen.getByRole('button', { name: 'Tree' }));

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
  queries.refetchRevealed.mockReset();
  queries.resourceError = null;
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
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
  useUiPrefsStore.setState({ manifestView: 'tree' });
});

describe('ResourceDetailDrawer', () => {
  it('counts only recent warnings for the current object and expires them as time passes', () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const sel = selection('Pod');
    queries.current = objectFor(sel);
    const timestamp = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    queries.events = [
      event('recent', { type: 'Warning', lastTimestamp: timestamp(59), involvedObject: { uid: queries.current.metadata.uid } }),
      event('stale', { type: 'Warning', lastTimestamp: timestamp(61) }),
      event('boundary', { type: 'Warning', lastTimestamp: timestamp(60) }),
      event('predecessor', { type: 'Warning', eventTime: timestamp(5), involvedObject: { uid: 'previous' } }),
      event('invalid', { type: 'Warning', lastTimestamp: 'invalid' }),
      event('normal', { type: 'Normal', lastTimestamp: timestamp(1) }),
    ];
    try {
      const view = render(<ResourceDetailPanel sel={sel} onClose={() => undefined} />);
      expect(screen.getByRole('tab', { name: /^Events/ })).toHaveAccessibleName('Events 1');
      clock.mockReturnValue(now + 61_000);
      view.rerender(<ResourceDetailPanel sel={sel} onClose={() => undefined} />);
      expect(screen.getByRole('tab', { name: /^Events/ })).toHaveAccessibleName('Events');
    } finally { clock.mockRestore(); }
  });

  it('routes a pod through map, YAML, events, metrics, fullscreen, keyboard, and error paths', async () => {
    const sel = selection('Pod');
    queries.current = objectFor(sel, { spec: { containers: [{ name: 'app' }] } });
    queries.events = [
      event('warning', { type: 'Warning', reason: 'FailedMount', message: 'volume missing', count: 3, lastTimestamp: new Date().toISOString() }),
      event('normal', { type: 'Normal', reason: 'Started', message: 'container started', count: 1 }),
    ];
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(<ResourceDetailPanel sel={sel} onBack={onBack} onClose={onClose} />);

    expect(screen.getByText('Pod overview pod-a')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Metrics' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Full screen')).not.toBeInTheDocument();
    expect(effects.yamlSchema).not.toHaveBeenCalled();
    const podCalls = () => queries.resourceCalls.filter(({ selection: call }) => call?.name === 'pod-a');
    // Overview is live: watch-fed with the poll as fallback.
    expect(podCalls().at(-1)?.options).toMatchObject({ liveMs: 5000, watch: true });

    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    expect(screen.getByText('Topology pod-a')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Full screen'));
    expect(screen.getByLabelText('Restore drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Restore drawer'));

    showYaml();
    expect(screen.getByTestId('yaml-editor')).toHaveTextContent('Replace');
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).toContain('name: pod-a');
    // In the YAML view the object freezes so live updates cannot reload the editor.
    expect(podCalls().at(-1)?.options).toMatchObject({ liveMs: undefined, watch: false });
    expect(useUiPrefsStore.getState().manifestView).toBe('yaml');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run YAML mock' }));
    expect(queries.dryRunMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'dev' }));

    queries.applyMode = 'conflict';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(effects.yamlError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('has been refreshed') })));
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

    // The tab carries its warning count as a badge, so its accessible name
    // reads "Events 1" while the fixture holds one Warning event.
    const eventsTab = screen.getByRole('tab', { name: /^Events/ });
    expect(eventsTab).toHaveAccessibleName('Events 1');
    fireEvent.click(eventsTab);
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

  it('carries a manifest draft into the YAML view and back, and keeps it across a close', async () => {
    const sel = selection('Deployment');
    queries.current = objectFor(sel, { spec: { replicas: 2 } });
    const onClose = vi.fn();
    const key = `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace}|${sel.name}`;
    const view = render(<ResourceDetailPanel sel={sel} onClose={onClose} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText('Manifest clean')).toBeInTheDocument();
    expect(screen.getByText('editable')).toBeInTheDocument();
    // Manifest stays live like Overview.
    const deploymentCalls = queries.resourceCalls.filter(({ selection: call }) => call?.name === sel.name);
    expect(deploymentCalls.at(-1)?.options).toMatchObject({ liveMs: 5000, watch: true });

    fireEvent.click(screen.getByRole('button', { name: 'Stage manifest edit' }));
    expect(screen.getByText('Manifest draft {"replicas":3}')).toBeInTheDocument();
    expect(useDetailStore.getState().drafts[key]?.mode).toBe('tree');

    // No guard between the tree and the YAML view: the draft travels along, serialized.
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((screen.getByLabelText('YAML draft') as HTMLTextAreaElement).value).toContain('replicas: 3');
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).toContain('replicas: 2');
    expect(useDetailStore.getState().drafts[key]?.mode).toBe('yaml');

    showTree();
    expect(screen.getByText('Manifest draft {"replicas":3}')).toBeInTheDocument();
    expect(useDetailStore.getState().drafts[key]?.mode).toBe('tree');

    // Closing keeps the draft with its resource: no prompt, and reopening shows it again.
    fireEvent.click(screen.getByLabelText('Close resource details'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
    expect(useDetailStore.getState().drafts[key]?.obj.spec).toEqual({ replicas: 3 });
    view.unmount();
    render(<ResourceDetailPanel sel={sel} onClose={onClose} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText('Manifest draft {"replicas":3}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard manifest draft' }));
    expect(useDetailStore.getState().drafts[key]).toBeUndefined();

    // A successful apply from the tree clears the draft and refreshes.
    fireEvent.click(screen.getByRole('button', { name: 'Stage manifest edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Applied manifest mock' }));
    await waitFor(() => expect(useDetailStore.getState().drafts[key]).toBeUndefined());
    expect(queries.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manifest conflict mock' }));
    expect(queries.refetch).toHaveBeenCalledTimes(2);
  });

  it('keeps unparsable YAML in the editor and parses valid YAML into the tree', async () => {
    const sel = selection('Pod');
    queries.current = objectFor(sel, { spec: { hostname: 'orig' } });
    render(<ResourceDetailPanel sel={sel} onClose={vi.fn()} />);

    const podKey = `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace}|${sel.name}`;
    showYaml();
    fireEvent.click(screen.getByRole('button', { name: 'Type broken YAML' }));
    expect(useDetailStore.getState().drafts[podKey]?.mode).toBe('yaml');
    showTree();
    expect(screen.getByText(/The YAML does not parse/)).toBeInTheDocument();
    expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('manifest-view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Type valid YAML' }));
    showTree();
    expect(screen.queryByText(/The YAML does not parse/)).not.toBeInTheDocument();
    expect(screen.getByText('Manifest draft {"hostname":"edited"}')).toBeInTheDocument();

    // Applying the YAML text (a 409 first) replays the edits onto the refreshed object, keeping them.
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
    queries.refetch.mockResolvedValue({ data: objectFor(sel, { spec: { hostname: 'server', nodeName: 'n1' }, metadata: { ...objectFor(sel).metadata, resourceVersion: '2' } }) });
    queries.applyMode = 'conflict';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(effects.yamlError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('replayed onto the latest version') })));
    await waitFor(() => expect(useDetailStore.getState().drafts[podKey]?.base.metadata.resourceVersion).toBe('2'));
    const rebased = useDetailStore.getState().drafts[podKey]!;
    expect(rebased.text).toContain('hostname: edited');
    expect(rebased.text).toContain('nodeName: n1');
    expect(rebased.text).toContain("resourceVersion: '2'");
    expect((screen.getByLabelText('YAML draft') as HTMLTextAreaElement).value).toContain('hostname: edited');
    queries.applyMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(useDetailStore.getState().drafts[podKey]).toBeUndefined());
  });

  it('marks a deleted resource and hides its actions, keeping the last state', () => {
    const sel = selection('Pod');
    queries.current = objectFor(sel, { status: { phase: 'Running' } });
    queries.resourceError = Object.assign(new Error('pods "pod-a" not found'), { status: 404 });
    render(<ResourceDetailPanel sel={sel} onClose={vi.fn()} />);

    expect(screen.getByText('Deleted from the cluster — showing the last known state.')).toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quick actions pod-a' })).not.toBeInTheDocument();
    expect(screen.getByText('Pod overview pod-a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });

  it('guards dirty ConfigMap data before changing tabs or closing', () => {
    const sel = selection('ConfigMap');
    queries.current = objectFor(sel, { data: { key: 'value' } });
    const onClose = vi.fn();
    render(<ResourceDetailDrawer sel={sel} onClose={onClose} inline />);

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(screen.getByText('Data editor configmap-a secret=false')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make data dirty' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText('Data editor configmap-a secret=false')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel discard mock' }));
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard mock' }));
    expect(screen.getByTestId('manifest-view')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make data clean' }));
    fireEvent.click(screen.getByLabelText('Close resource details'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a manifest draft when only the Data edits are discarded', () => {
    const sel = selection('ConfigMap');
    queries.current = objectFor(sel, { data: { key: 'value' } });
    render(<ResourceDetailDrawer sel={sel} onClose={vi.fn()} inline />);

    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage manifest edit' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make data dirty' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toHaveTextContent('The Data tab has key edits');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard mock' }));
    expect(screen.getByText('Manifest draft {"replicas":3}')).toBeInTheDocument();
    expect(useDetailStore.getState().dataDirty).toBe(false);
    expect(Object.keys(useDetailStore.getState().drafts)).toHaveLength(1);
  });

  it('reveals Secret YAML and resets the per-selection view state', () => {
    const secretSel = selection('Secret');
    queries.current = objectFor(secretSel, { data: { password: btoa('secret') } });
    const view = render(<ResourceDetailDrawer sel={secretSel} onClose={vi.fn()} />);

    expect(screen.getByText('Secret overview secret-a')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Full screen'));
    expect(screen.getByLabelText('Restore drawer')).toBeInTheDocument();
    showYaml();
    // The manifest is built from the revealed object, but stays masked and read-only until revealed.
    expect(queries.resourceCalls.some(({ selection: call }) => call?.reveal === true)).toBe(true);
    expect(screen.getByText('read-only editor')).toBeInTheDocument();
    expect(screen.getByText('Read-only until revealed')).toBeInTheDocument();
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).toContain('••••••••');
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).not.toContain(btoa('secret'));
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret data' }));
    expect(screen.getByText('editable editor')).toBeInTheDocument();
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).toContain(btoa('secret'));
    // Broken YAML typed while revealed cannot be masked: hiding it hides the draft entirely.
    fireEvent.click(screen.getByRole('button', { name: 'Type broken YAML' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret data' }));
    expect(screen.getByText(/YAML edits are hidden while the Secret is masked/)).toBeInTheDocument();
    expect((screen.getByLabelText('YAML draft') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('YAML input') as HTMLTextAreaElement).value).not.toContain(btoa('secret'));
    expect(screen.getByText('read-only editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret data' }));
    expect((screen.getByLabelText('YAML draft') as HTMLTextAreaElement).value).toBe('kind: [');
    // A tree conflict on a Secret refreshes the revealed object the tree is built from.
    fireEvent.click(screen.getByRole('button', { name: 'Type valid YAML' }));
    showTree();
    fireEvent.click(screen.getByRole('button', { name: 'Manifest conflict mock' }));
    expect(queries.refetchRevealed).toHaveBeenCalled();
    expect(queries.refetch).not.toHaveBeenCalled();

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
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }));
    expect(screen.getByText('CRD schema default')).toBeInTheDocument();
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
