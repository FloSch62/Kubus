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
    openStore: vi.fn(async () => undefined),
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

it('checks Store availability and offers the Store as a fallback when opening it fails', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'idle', source: 'store' });
  render(<DesktopUpdateControls />);
  expect(await screen.findByText(/Microsoft Store manages updates/)).toBeInTheDocument();
  expect(desktop.checkForUpdates).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  expect(desktop.checkForUpdates).toHaveBeenCalledOnce();
  expect(desktop.openStore).not.toHaveBeenCalled();
  desktop.openStore.mockRejectedValueOnce(new Error('Store unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Open Microsoft Store' }));
  expect(await screen.findByText(/Microsoft Store could not be opened/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument();
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
});

it('shows a Store notification without a target version and only installs after confirmation', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'available', source: 'store' });
  render(<UpdateNotification />);
  expect(await screen.findByText('A new version of Kubus is available in Microsoft Store.')).toBeInTheDocument();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
  expect(screen.getByText(/Save any edits first/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Update now' }).at(-1)!);
  await waitFor(() => expect(desktop.installUpdate).toHaveBeenCalledOnce());
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
  expect(desktop.openStore).not.toHaveBeenCalled();
});

it('dismisses a Store notification without permanently hiding future Store updates', async () => {
  const desktop = bridge({ currentVersion: '0.9.0', status: 'available', source: 'store' });
  const view = render(<UpdateNotification />);
  fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
  await waitFor(() => expect(screen.queryByText(/new version of Kubus/)).not.toBeInTheDocument());
  expect(desktop.installUpdate).not.toHaveBeenCalled();
  view.unmount();
  render(<UpdateNotification />);
  expect(await screen.findByText(/new version of Kubus/)).toBeInTheDocument();
});

it('keeps Store failures and completion visible after an update started from the notification', async () => {
  const initial = { currentVersion: '0.9.0', source: 'store' as const };
  const desktop = bridge({ ...initial, status: 'installing' });
  render(<UpdateNotification />);
  desktop.emit({ ...initial, status: 'error', error: 'Microsoft Store could not complete the update.' });
  expect(await screen.findByText('Microsoft Store could not complete the update.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Microsoft Store' }));
  expect(desktop.openStore).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  desktop.emit({ ...initial, status: 'updated' });
  expect(await screen.findByText(/Reopen Kubus/)).toBeInTheDocument();
});

it('shows Store progress, cancellation, errors, and completion without offering a GitHub download', async () => {
  const initial = { currentVersion: '0.9.0', source: 'store' as const };
  const desktop = bridge({ ...initial, status: 'installing' });
  render(<DesktopUpdateControls />);
  expect(await screen.findByText('Waiting for Microsoft Store…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  desktop.emit({ ...initial, status: 'installing', percent: 50 });
  expect(screen.getByText('Updating Kubus through Microsoft Store… 50%')).toBeInTheDocument();
  desktop.emit({ ...initial, status: 'available' });
  expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
  desktop.emit({ ...initial, status: 'error', error: 'Store is offline.' });
  expect(screen.getByText('Store is offline.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  desktop.emit({ ...initial, status: 'updated' });
  expect(screen.getByText(/Reopen Kubus/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument();
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
