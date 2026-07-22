/* oxlint-disable typescript/unbound-method -- browser APIs are replaced with mocks in this test. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { DataEditor, type DataEditorSelection } from '../../../client/src/components/detail/DataEditor';

const queries = vi.hoisted(() => ({
  latest: undefined as KubeObject | undefined,
  loadError: undefined as unknown,
  refetch: vi.fn(),
  applyPending: false,
  applyMode: 'success' as 'success' | 'conflict' | 'error' | 'string',
  applyMutateAsync: vi.fn(),
  dryRunPending: false,
  dryRunError: false,
  dryRunFailure: undefined as unknown,
  dryRunData: { ok: true, findings: [] } as {
    ok: boolean;
    findings: Array<{ severity: 'error' | 'warning' | 'info' | 'success'; field?: string; message: string }>;
  },
  dryRunMutate: vi.fn(),
}));

const effects = vi.hoisted(() => ({
  toast: vi.fn(),
  copyResult: true,
  copy: vi.fn(),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResource: () => ({ data: queries.latest, error: queries.loadError, refetch: queries.refetch }),
  useApplyResource: () => ({ isPending: queries.applyPending, mutateAsync: queries.applyMutateAsync }),
  useDryRunResource: () => ({
    isPending: queries.dryRunPending,
    isError: queries.dryRunError,
    error: queries.dryRunFailure,
    data: queries.dryRunData,
    mutate: queries.dryRunMutate,
  }),
}));

vi.mock('../../../client/src/clipboard.js', () => ({
  copyToClipboard: (value: string) => {
    effects.copy(value);
    return Promise.resolve(effects.copyResult);
  },
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/DiffViewer.js', () => ({
  DiffViewer: ({ left, right }: { left: string; right: string }) => (
    <div>
      <pre data-testid="diff-left">{left}</pre>
      <pre data-testid="diff-right">{right}</pre>
    </div>
  ),
}));

const configMapSelection: DataEditorSelection = {
  ctx: 'dev',
  group: '',
  version: 'v1',
  plural: 'configmaps',
  kind: 'ConfigMap',
  name: 'settings',
  namespace: 'team-a',
};

const secretSelection: DataEditorSelection = {
  ...configMapSelection,
  plural: 'secrets',
  kind: 'Secret',
  name: 'credentials',
};

function configMap(extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'settings', namespace: 'team-a', uid: 'settings', resourceVersion: '7', managedFields: [{ manager: 'kubus' }] },
    data: { alpha: 'one', multiline: 'first\nsecond' },
    binaryData: { blob: 'AQID' },
    ...extra,
  } as KubeObject;
}

function secret(extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'credentials', namespace: 'team-a', uid: 'credentials', resourceVersion: '3' },
    data: { password: btoa('hunter2'), binary: '/w==' },
    ...extra,
  } as KubeObject;
}

beforeEach(() => {
  queries.latest = configMap();
  queries.loadError = undefined;
  queries.refetch.mockReset();
  queries.applyPending = false;
  queries.applyMode = 'success';
  queries.applyMutateAsync.mockReset();
  queries.applyMutateAsync.mockImplementation(async () => {
    if (queries.applyMode === 'conflict') {
      const error = new Error('resource conflict') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    if (queries.applyMode === 'error') throw new Error('apply denied');
    if (queries.applyMode === 'string') throw 'apply rejected';
    return queries.latest ?? configMap();
  });
  queries.dryRunPending = false;
  queries.dryRunError = false;
  queries.dryRunFailure = undefined;
  queries.dryRunData = { ok: true, findings: [] };
  queries.dryRunMutate.mockReset();
  effects.toast.mockClear();
  effects.copy.mockClear();
  effects.copyResult = true;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

describe('DataEditor', () => {
  it('loads a ConfigMap, reviews a valid edit, and applies the returned object', async () => {
    const dirty = vi.fn();
    render(<DataEditor sel={configMapSelection} isSecret={false} onDirtyChange={dirty} />);

    const alphaSummary = await screen.findByRole('button', { name: /alpha one/ });
    expect(screen.getByText(/Text keys are stored as plain UTF-8/)).toBeInTheDocument();
    expect(screen.getByText(/first … \(2 lines\)/)).toBeInTheDocument();
    expect(screen.getAllByText('binary').length).toBeGreaterThan(0);

    fireEvent.click(alphaSummary);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'two' } });
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    expect(screen.getByText('edited')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review & apply' }));
    const dialog = await screen.findByRole('dialog', { name: /Review changes/ });
    expect(within(dialog).getByText('Server dry-run accepted this change.')).toBeInTheDocument();
    expect(screen.getByTestId('diff-left')).toHaveTextContent('alpha: one');
    expect(screen.getByTestId('diff-right')).toHaveTextContent('alpha: two');
    expect(queries.dryRunMutate).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'dev', yamlBody: expect.stringContaining('alpha: two') }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(queries.applyMutateAsync).toHaveBeenCalled());
    expect(effects.toast).toHaveBeenCalledWith('success', 'ConfigMap settings updated');
    expect(queries.refetch).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Review changes/ })).not.toBeInTheDocument();
  });

  it('supports add, validate, rename, mode, copy, file, delete, restore, and reset controls', async () => {
    render(<DataEditor sel={configMapSelection} isSecret={false} />);
    await screen.findByRole('button', { name: /alpha one/ });

    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('Key name is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review & apply' })).toBeDisabled();

    const keyInputs = screen.getAllByLabelText('Key');
    const valueInputs = screen.getAllByLabelText('Value');
    fireEvent.change(keyInputs.at(-1)!, { target: { value: 'created' } });
    fireEvent.change(valueInputs.at(-1)!, { target: { value: 'hello' } });
    expect(screen.getByRole('button', { name: 'Review & apply' })).toBeEnabled();

    const base64Buttons = screen.getAllByRole('button', { name: 'Base64' });
    fireEvent.click(base64Buttons.at(-1)!);
    expect(screen.getByDisplayValue('aGVsbG8=')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Text' }).at(-1)!);
    expect(screen.getByDisplayValue('hello')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy value of created' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('success', 'Copied value of created'));
    expect(effects.copy).toHaveBeenCalledWith('hello');
    effects.copyResult = false;
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of created' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('error', 'Copy to clipboard failed'));

    const uploadButton = screen.getByRole('button', { name: 'Upload file into created' });
    const input = uploadButton.querySelector('input')!;
    const file = new File(['ignored'], 'payload.bin');
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(Uint8Array.from([1, 2, 3]).buffer) });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByDisplayValue('AQID')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Download value of created' }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');

    fireEvent.change(screen.getByLabelText('Value (base64)'), { target: { value: '%%%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download value of created' }));
    expect(effects.toast).toHaveBeenCalledWith('error', 'Value is not valid base64');
    fireEvent.change(screen.getByLabelText('Value (base64)'), { target: { value: '/w==' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Text' }).at(-1)!);
    expect(effects.toast).toHaveBeenCalledWith('warning', expect.stringContaining('not valid UTF-8'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete created' }));
    expect(screen.queryByRole('button', { name: 'Delete created' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete alpha' }));
    expect(screen.getByText('deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore alpha' }));

    fireEvent.click(screen.getByRole('button', { name: /alpha one/ }));
    fireEvent.change(screen.getAllByLabelText('Key')[0]!, { target: { value: 'renamed' } });
    expect(screen.getAllByText('renamed').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const resetDialog = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(resetDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByText('renamed').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('button', { name: /alpha one/ });
  }, 15_000);

  it('masks Secret values and handles dry-run findings, conflicts, and apply failures', async () => {
    queries.latest = secret();
    queries.dryRunError = true;
    queries.dryRunFailure = 'webhook unavailable';
    queries.dryRunData = {
      ok: true,
      findings: [
        { severity: 'warning', field: 'data.password', message: 'Check this value' },
        { severity: 'error', message: 'Policy warning' },
      ],
    };
    render(<DataEditor sel={secretSelection} isSecret />);

    const passwordSummary = await screen.findByRole('button', { name: /password ••••••••/ });
    expect(screen.getByText(/Secret values are stored base64-encoded/)).toBeInTheDocument();
    fireEvent.click(passwordSummary);
    expect(screen.getByText('Value is hidden.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal to view or edit' }));
    expect(screen.getByDisplayValue('hunter2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide value of password' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal values' }));
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'changed' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review & apply' }));
    const dialog = await screen.findByRole('dialog', { name: /Review changes/ });
    expect(within(dialog).getByText('Dry-run failed: unknown error')).toBeInTheDocument();
    expect(within(dialog).getByText('data.password: Check this value')).toBeInTheDocument();
    expect(within(dialog).getByText('Policy warning')).toBeInTheDocument();
    expect(within(dialog).getByText(/Unrevealed Secret values are shown as/)).toBeInTheDocument();

    queries.applyMode = 'conflict';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(dialog).getByText(/resource conflict.*changed on the server/)).toBeInTheDocument());
    expect(queries.refetch).toHaveBeenCalled();

    queries.applyMode = 'error';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(dialog).getByText('apply denied')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByLabelText('Close'));

    queries.applyMode = 'string';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(dialog).getByText('apply rejected')).toBeInTheDocument());

    queries.applyMode = 'success';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('success', 'Secret credentials updated'));
  });

  it('shows loading, load errors, empty data, and immutable resources', async () => {
    queries.latest = undefined;
    const loading = render(<DataEditor sel={configMapSelection} isSecret={false} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    loading.unmount();

    queries.loadError = new Error('read denied');
    const error = render(<DataEditor sel={configMapSelection} isSecret={false} />);
    expect(screen.getByText('read denied')).toBeInTheDocument();
    error.unmount();

    queries.loadError = 'failure';
    const unknownError = render(<DataEditor sel={configMapSelection} isSecret={false} />);
    expect(screen.getByText('Failed to load resource data')).toBeInTheDocument();
    unknownError.unmount();

    queries.loadError = undefined;
    queries.latest = configMap({ data: {}, binaryData: {}, immutable: true });
    render(<DataEditor sel={configMapSelection} isSecret={false} />);
    expect(await screen.findByText('No data keys.')).toBeInTheDocument();
    expect(screen.getByText(/ConfigMap is immutable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add key' })).not.toBeInTheDocument();
  });
});
