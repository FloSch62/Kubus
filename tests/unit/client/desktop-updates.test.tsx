import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '@kubus/shared';
import { DesktopUpdateControls } from '../../../client/src/components/DesktopUpdateControls.js';

function bridge(initial: DesktopUpdateState) {
  let listener: (state: DesktopUpdateState) => void = () => {};
  const unsubscribe = vi.fn();
  const desktop = {
    getUpdateState: vi.fn(async () => initial),
    checkForUpdates: vi.fn(async () => initial),
    installUpdate: vi.fn(async () => true),
    onUpdateState: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }),
  };
  window.kubusDesktop = desktop as unknown as NonNullable<typeof window.kubusDesktop>;
  return { ...desktop, unsubscribe, emit: (state: DesktopUpdateState) => act(() => listener(state)) };
}

afterEach(() => { delete window.kubusDesktop; });

it('shows shared download progress and asks to save work before restarting all windows', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'downloading', version: '1.0.0', percent: 30 });
  const { unmount } = render(<DesktopUpdateControls />);
  expect(await screen.findByText('Downloading Kubus 1.0.0… 30%')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  desktop.emit({ currentVersion: '0.9.0', status: 'ready', version: '1.0.0' });
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
  expect(screen.getByText(/Save any edits first/)).toBeInTheDocument();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Restart to update' }).at(-1)!);
  await waitFor(() => expect(desktop.installUpdate).toHaveBeenCalledOnce());
  unmount();
  expect(desktop.unsubscribe).toHaveBeenCalledOnce();
});

it('keeps Store builds on managed updates', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'disabled', reason: 'store' });
  render(<DesktopUpdateControls />);
  expect(await screen.findByText(/managed by Microsoft Store/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument();
  expect(desktop.checkForUpdates).not.toHaveBeenCalled();
});

it('does not overwrite a pushed update with a stale initial snapshot', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'idle' });
  let resolve!: (state: DesktopUpdateState) => void;
  desktop.getUpdateState.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<DesktopUpdateControls />);
  desktop.emit({ currentVersion: '0.9.0', status: 'ready', version: '1.0.0' });
  await act(async () => resolve({ currentVersion: '0.9.0', status: 'idle' }));
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeInTheDocument();
});

it('allows retry after a failed check and surfaces an IPC error', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'error', error: 'Download failed.' });
  render(<DesktopUpdateControls />);
  expect(await screen.findByText('Download failed.')).toBeInTheDocument();
  desktop.checkForUpdates.mockRejectedValueOnce(new Error('IPC unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() => expect(desktop.checkForUpdates).toHaveBeenCalledOnce());
});
