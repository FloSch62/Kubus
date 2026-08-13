import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogsResponse } from '@kubus/shared';
import { LogViewerDialog } from '../../../client/src/components/LogViewerDialog';
import { formatLogEntry } from '../../../client/src/api/logs';
import { useUiStore } from '../../../client/src/state/ui';

const harness = vi.hoisted(() => ({
  clear: vi.fn(async () => ({ cleared: true })),
  copy: vi.fn(async () => true),
  refetch: vi.fn(async () => undefined),
  save: vi.fn(),
  data: {
    debugEnabled: false,
    capacity: 5000,
    entries: [
      { ts: 1_753_862_400_000, level: 'info', source: 'app', msg: 'Kubus started' },
      { ts: 1_753_862_401_000, level: 'error', source: 'server', msg: 'cluster probe failed', context: { ctx: 'cluster-a' } },
    ],
  } as AppLogsResponse,
}));

vi.mock('../../../client/src/api/logs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../client/src/api/logs')>();
  return {
    ...actual,
    clearAppLogs: harness.clear,
    useAppLogs: () => ({ data: harness.data, refetch: harness.refetch }),
  };
});
vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: harness.copy }));
vi.mock('../../../client/src/save-file.js', () => ({ exportFilename: () => 'kubus-debug.log', saveTextFile: harness.save }));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ logViewerOpen: true });
});

describe('diagnostic log viewer', () => {
  it('formats structured entries consistently', () => {
    expect(formatLogEntry(harness.data.entries[1]!)).toBe(
      '2025-07-30T08:00:01.000Z ERROR server cluster probe failed {"ctx":"cluster-a"}',
    );
  });

  it('filters, copies, exports, clears, and closes the in-memory log', async () => {
    render(<LogViewerDialog />);

    expect(screen.getByRole('heading', { name: 'Diagnostic logs' })).toBeInTheDocument();
    expect(screen.getByText(/Kubus started/)).toBeInTheDocument();
    expect(screen.getByText(/cluster probe failed/)).toBeInTheDocument();
    expect(screen.getByText(/Debug logging is off/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'cluster-a' } });
    expect(screen.queryByText(/Kubus started/)).not.toBeInTheDocument();
    expect(screen.getByText(/cluster probe failed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(harness.copy).toHaveBeenCalledWith(expect.stringContaining('cluster probe failed')));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(harness.save).toHaveBeenCalledWith('kubus-debug.log', expect.stringContaining('cluster probe failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(harness.clear).toHaveBeenCalledOnce());
    expect(harness.refetch).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().logViewerOpen).toBe(false);
  });
});
