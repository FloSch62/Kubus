import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '@kubus/shared';
import { DesktopUpdateControls } from '../../../client/src/components/DesktopUpdateControls.js';
import { UpdateNotification } from '../../../client/src/components/UpdateNotification.js';

function bridge(initial: DesktopUpdateState) {
  let listener: (state: DesktopUpdateState) => void = () => {};
  const unsubscribe = vi.fn();
  const desktop = {
    getUpdateState: vi.fn(async () => initial),
    checkForUpdates: vi.fn(async () => initial),
    downloadUpdate: vi.fn(async () => initial),
    installUpdate: vi.fn(async () => true),
    onUpdateState: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }),
  };
  window.kubusDesktop = desktop as unknown as NonNullable<typeof window.kubusDesktop>;
  return { ...desktop, unsubscribe, emit: (state: DesktopUpdateState) => act(() => listener(state)) };
}

afterEach(() => { delete window.kubusDesktop; window.localStorage.clear(); });

it('only downloads an available update when the user clicks Download update', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'available', version: '1.0.0' });
  render(<DesktopUpdateControls />);
  const download = await screen.findByRole('button', { name: 'Download update' });
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(download);
  await waitFor(() => expect(desktop.downloadUpdate).toHaveBeenCalledOnce());
  expect(desktop.installUpdate).not.toHaveBeenCalled();
});

it('lets the user dismiss availability without downloading and still notifies when their later download is ready', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'available', version: '1.0.0' });
  render(<UpdateNotification />);
  expect(await screen.findByText('Kubus 1.0.0 is available.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  await waitFor(() => expect(screen.queryByText('Kubus 1.0.0 is available.')).not.toBeInTheDocument());
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
  desktop.emit({ currentVersion: '0.9.0', status: 'ready', version: '1.0.0' });
  expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeInTheDocument();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
});

it('shows shared download progress and asks to save work before restarting all windows', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'downloading', version: '1.0.0', percent: 30 });
  const { unmount } = render(<DesktopUpdateControls />);
  expect(await screen.findByText('Downloading Kubus 1.0.0… 30%')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  desktop.emit({ currentVersion: '0.9.0', status: 'ready', version: '1.0.0' });
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
  expect(screen.getByText(/Save any edits first/)).toBeInTheDocument();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
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
