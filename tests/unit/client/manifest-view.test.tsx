import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { ManifestView } from '../../../client/src/components/detail/ManifestView';
import { dumpManifest } from '../../../client/src/components/detail/manifest-tree';
import { useDetailStore } from '../../../client/src/state/detail';

const queries = vi.hoisted(() => ({
  schema: undefined as Record<string, unknown> | undefined,
  apiResources: [] as Array<{ group: string; version: string; kind: string; plural: string; namespaced: boolean; verbs: string[]; custom?: boolean }>,
  applyMutateAsync: vi.fn(),
  dryRunMutate: vi.fn(),
  dryRunData: { ok: true, findings: [] } as { ok: boolean; findings: Array<{ severity: 'error' | 'warning'; message: string }> },
}));
const effects = vi.hoisted(() => ({ toast: vi.fn(), copy: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResourceSchema: () => ({ data: queries.schema }),
  useApiResources: () => ({ data: queries.apiResources }),
  useApplyResource: () => ({ isPending: false, mutateAsync: queries.applyMutateAsync }),
  useDryRunResource: () => ({ isPending: false, isError: false, data: queries.dryRunData, mutate: queries.dryRunMutate }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/clipboard.js', () => ({
  copyToClipboard: (value: string) => {
    effects.copy(value);
    return Promise.resolve(true);
  },
}));
vi.mock('../../../client/src/components/DiffViewer.js', () => ({
  DiffViewer: ({ left, right }: { left: string; right: string }) => (
    <div>
      <pre data-testid="diff-left">{left}</pre>
      <pre data-testid="diff-right">{right}</pre>
    </div>
  ),
}));

const sel = { ctx: 'dev', group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', name: 'web', namespace: 'team-a' };

function deployment(extra: Partial<KubeObject> = {}): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'team-a', uid: 'uid-web', resourceVersion: '1', labels: { app: 'web' }, managedFields: [{ manager: 'kubectl' }] },
    spec: {
      replicas: 2,
      paused: false,
      strategy: { type: 'RollingUpdate' },
      template: { spec: { nodeName: 'node-1', containers: [{ name: 'nginx', image: 'nginx:1.27' }], imagePullSecrets: [{ name: 'pull' }] } },
    },
    status: { readyReplicas: 2, conditions: [{ type: 'Available', status: 'True' }] },
    ...extra,
  } as KubeObject;
}

const schema = {
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      description: 'Desired behavior of the Deployment.',
      properties: {
        replicas: { type: 'integer', description: 'Number of desired pods.' },
        paused: { type: 'boolean' },
        strategy: { type: 'object', properties: { type: { type: 'string', enum: ['Recreate', 'RollingUpdate'] } } },
        minReadySeconds: { type: 'integer', description: 'Minimum seconds a pod must be ready.' },
      },
    },
    status: { type: 'object' },
  },
};

function draftFor(live: KubeObject, obj: KubeObject) {
  const base = structuredClone(live);
  delete (base.metadata as unknown as Record<string, unknown>).managedFields;
  return { selKey: 'k', base, baseText: dumpManifest(base), obj, text: '', mode: 'tree' as const };
}

function renderView(live: KubeObject, opts: { draft?: ReturnType<typeof draftFor>; readOnly?: boolean; secretRedacted?: boolean } = {}) {
  const onDraftChange = vi.fn();
  const onApplied = vi.fn();
  const onConflict = vi.fn();
  const view = render(<ManifestView sel={sel} live={live} draft={opts.draft} readOnly={opts.readOnly} secretRedacted={opts.secretRedacted} onDraftChange={onDraftChange} onApplied={onApplied} onConflict={onConflict} />);
  return { view, onDraftChange, onApplied, onConflict };
}

const row = (name: string) => screen.getAllByRole('treeitem').find((item) => item.textContent?.startsWith(name))!;

beforeEach(() => {
  queries.schema = schema;
  queries.apiResources = [{ group: '', version: 'v1', kind: 'Node', plural: 'nodes', namespaced: false, verbs: ['get'] }];
  queries.applyMutateAsync.mockReset().mockResolvedValue({});
  queries.dryRunMutate.mockReset();
  queries.dryRunData = { ok: true, findings: [] };
  effects.toast.mockReset();
  effects.copy.mockReset();
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dirty: false, draft: undefined, pendingDiscard: undefined });
});

describe('ManifestView', () => {
  it('renders sectioned trees with schema types, descriptions, locks and summaries', () => {
    renderView(deployment());
    expect(screen.getByRole('button', { name: /^Metadata/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^Spec/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('Desired behavior of the Deployment.')).not.toBeInTheDocument();
    expect(within(row('replicas')).getByText('int')).toBeInTheDocument();
    expect(within(row('replicas')).getByText('2')).toBeInTheDocument();
    // Collapsed containers show item names, never counts.
    expect(row('template')).not.toHaveTextContent(/field/);
    expect(within(row('containers')).getByText('nginx')).toBeInTheDocument();
    // Status rows are locked and say why.
    expect(screen.getAllByLabelText(/Status is written by the controller/).length).toBeGreaterThan(0);
    expect(within(row('readyReplicas')).queryByRole('button', { name: 'Delete readyReplicas', hidden: true })).not.toBeInTheDocument();
    expect(within(row('replicas')).getByRole('button', { name: 'Delete replicas', hidden: true })).toBeInTheDocument();
    // Descriptions (field and section) are a toggle away.
    expect(screen.queryByText('Number of desired pods.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show descriptions' }));
    expect(screen.getByText('Number of desired pods.')).toBeInTheDocument();
    expect(screen.getByText('Desired behavior of the Deployment.')).toBeInTheDocument();
  });

  it('edits scalars inline with typed parsing and stages the draft', () => {
    const live = deployment();
    const { onDraftChange } = renderView(live);
    fireEvent.click(within(row('replicas')).getByText('2'));
    const input = screen.getByRole('textbox', { name: 'Value' });
    fireEvent.change(input, { target: { value: 'many' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument();
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDraftChange).toHaveBeenCalledOnce();
    const [next, base] = onDraftChange.mock.calls[0]!;
    expect(next.spec.replicas).toBe(3);
    expect(base.metadata).not.toHaveProperty('managedFields');
    expect(base.spec.replicas).toBe(2);

    // Escape cancels without staging.
    fireEvent.click(within(row('paused')).getByText('false'));
    // The open menu marks the page aria-hidden, so the combobox needs `hidden`.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Value', hidden: true }), { key: 'Escape' });
    expect(onDraftChange).toHaveBeenCalledOnce();
  });

  it('shows change marks, counts, per-row reset, removed ghosts and the review diff', async () => {
    const live = deployment();
    const obj = structuredClone(live);
    delete (obj.metadata as unknown as Record<string, unknown>).managedFields;
    (obj.spec as Record<string, unknown>).replicas = 3;
    delete (obj.spec as Record<string, unknown>).paused;
    (obj.spec as Record<string, unknown>).minReadySeconds = 5;
    ((obj.spec as Record<string, unknown>).strategy as Record<string, unknown>).type = 'Recreate';
    const draft = draftFor(live, obj);
    const { onDraftChange, onApplied } = renderView(live, { draft });

    expect(screen.getByText('4 changes')).toBeInTheDocument();
    expect(within(row('strategy')).getByLabelText('Contains changes')).toBeInTheDocument();
    expect(within(row('replicas')).getByText('changed')).toBeInTheDocument();
    expect(within(row('minReadySeconds')).getByText('added')).toBeInTheDocument();
    expect(within(row('paused')).getByText('removed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset replicas', hidden: true }));
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ spec: expect.objectContaining({ replicas: 2, minReadySeconds: 5 }) }), draft.base);
    fireEvent.click(screen.getByRole('button', { name: 'Restore paused', hidden: true }));
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ spec: expect.objectContaining({ paused: false }) }), draft.base);
    fireEvent.click(screen.getByRole('button', { name: 'Delete minReadySeconds', hidden: true }));
    expect(onDraftChange.mock.lastCall?.[0].spec).not.toHaveProperty('minReadySeconds');

    fireEvent.click(screen.getByRole('button', { name: 'Review & apply' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('diff-left')).toHaveTextContent('replicas: 2');
    expect(within(dialog).getByTestId('diff-right')).toHaveTextContent('replicas: 3');
    expect(queries.dryRunMutate).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'dev', yamlBody: expect.stringContaining('minReadySeconds: 5') }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(queries.applyMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: 'web', namespace: 'team-a', yamlBody: expect.stringContaining('replicas: 3') }));
  }, 15_000);

  it('discards the whole draft after confirmation and rebases when the server moved', () => {
    const live = deployment();
    const obj = structuredClone(live);
    delete (obj.metadata as unknown as Record<string, unknown>).managedFields;
    (obj.spec as Record<string, unknown>).replicas = 3;
    const draft = draftFor(live, obj);
    const moved = deployment({ metadata: { ...live.metadata, resourceVersion: '2' }, spec: { ...(live.spec as object), paused: true } });
    const { onDraftChange } = renderView(moved, { draft });

    expect(screen.getByText(/changed on the server while you were editing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rebase edits' }));
    const [rebased, base] = onDraftChange.mock.lastCall!;
    expect(rebased.spec).toMatchObject({ replicas: 3, paused: true });
    expect(base.metadata.resourceVersion).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDraftChange).toHaveBeenLastCalledWith(undefined, draft.base);
  }, 15_000);

  it('filters rows, expands and collapses everything, and copies values and paths', async () => {
    renderView(deployment());
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter manifest' }), { target: { value: 'nginx' } });
    expect(screen.queryByRole('button', { name: /^Status/ })).not.toBeInTheDocument();
    expect(row('image')).toBeInTheDocument();
    expect(screen.queryAllByRole('treeitem').some((item) => item.textContent?.startsWith('replicas'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByRole('button', { name: /^Status/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryAllByRole('treeitem').some((item) => item.textContent?.startsWith('image'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(row('image')).toBeInTheDocument();

    fireEvent.click(within(row('image')).getByRole('button', { name: 'Copy image', hidden: true }));
    await waitFor(() => expect(effects.copy).toHaveBeenCalledWith('nginx:1.27'));
    fireEvent.click(within(row('image')).getByRole('button', { name: 'More actions for image', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(effects.copy).toHaveBeenCalledWith('.spec.template.spec.containers[0].image'));
  }, 15_000);

  it('links references the cluster serves and opens them in the drawer', () => {
    renderView(deployment());
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(row('nodeName')).getByRole('button', { name: 'node-1' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Node', name: 'node-1', plural: 'nodes', namespace: undefined });
    // Secrets are builtin kinds, resolved without discovery; namespaced refs inherit the object's namespace.
    fireEvent.click(screen.getByRole('button', { name: 'pull' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Secret', name: 'pull', namespace: 'team-a' });
  }, 15_000);

  it('adds fields from schema suggestions, adds list items, and edits subtrees as YAML', () => {
    const { onDraftChange } = renderView(deployment());
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add field to strategy', hidden: true }));
    const picker = screen.getByRole('textbox', { name: 'Field name' });
    fireEvent.change(picker, { target: { value: 'rollingUpdate' } });
    // Unknown to the schema: the typed name is offered as a plain field.
    expect(within(screen.getByLabelText('Fields')).getByRole('button', { name: /Add “rollingUpdate”/ })).toBeInTheDocument();
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(onDraftChange.mock.lastCall?.[0].spec.strategy).toMatchObject({ rollingUpdate: '' });

    fireEvent.click(screen.getByRole('button', { name: 'Add item to containers', hidden: true }));
    expect(onDraftChange.mock.lastCall?.[0].spec.template.spec.containers).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'More actions for strategy', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit as YAML' }));
    const yaml = screen.getByRole('textbox', { name: 'Subtree YAML' });
    fireEvent.change(yaml, { target: { value: 'type: [' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByRole('textbox', { name: 'Subtree YAML' })).toBeInTheDocument();
    fireEvent.change(yaml, { target: { value: 'type: Recreate\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onDraftChange.mock.lastCall?.[0].spec.strategy).toEqual({ type: 'Recreate' });
  }, 15_000);

  it('adds a field directly under a section from its header, seeded by the schema', () => {
    const { onDraftChange } = renderView(deployment());
    expect(screen.queryByRole('button', { name: 'Add field to Status' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add field to Spec' }));
    const options = within(screen.getByLabelText('Fields')).getAllByRole('button');
    // Remaining schema fields only: replicas, paused and strategy already exist.
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining('minReadySeconds')]);
    expect(options[0]).toHaveTextContent('Minimum seconds a pod must be ready.');
    fireEvent.click(options[0]!);
    expect(onDraftChange.mock.lastCall?.[0].spec.minReadySeconds).toBe(0);
  });

  it('navigates rows with the keyboard', () => {
    renderView(deployment());
    const first = row('replicas');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('paused'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('strategy'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(row('strategy')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(row('strategy')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('type'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('strategy'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: 'Value' })).toBeInTheDocument();
  }, 15_000);

  it('locks everything when read-only or when secret data is redacted', () => {
    renderView(deployment(), { readOnly: true });
    expect(screen.queryByRole('button', { name: 'Review & apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete /, hidden: true })).not.toBeInTheDocument();
    fireEvent.click(within(row('replicas')).getByText('2'));
    expect(screen.queryByRole('textbox', { name: 'Value' })).not.toBeInTheDocument();
  });
});
