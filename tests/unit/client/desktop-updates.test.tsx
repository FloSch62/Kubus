import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppUpdateState } from '@kubus/shared';
import { DesktopUpdateControls } from '../../../client/src/components/DesktopUpdateControls.js';
import { UpdateNotification } from '../../../client/src/components/UpdateNotification.js';

let state: AppUpdateState;
const listeners = new Set<() => void>();
const check = vi.fn(), download = vi.fn(), apply = vi.fn();
function publish(next: Partial<AppUpdateState>) {
  act(() => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); });
}
beforeEach(() => {
  vi.clearAllMocks(); listeners.clear(); localStorage.clear();
  state = { status: 'available', currentVersion: '0.9.0', latestVersion: '1.0.0' };
  window.kubusDesktop = {
    getUpdateState: () => state,
    onUpdateStateChanged: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    checkForUpdate: check, downloadUpdate: download, applyUpdate: apply,
  } as unknown as typeof window.kubusDesktop;
});
afterEach(() => { delete window.kubusDesktop; });

it('shares download progress with settings, requires an explicit restart, and disables conflicting checks', () => {
  render(<><DesktopUpdateControls /><UpdateNotification /></>);
  fireEvent.click(screen.getAllByRole('button', { name: 'Download update' })[0]!);
  expect(download).toHaveBeenCalledOnce();
  publish({ status: 'downloading', progress: 42 });
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  expect(screen.getAllByText(/Downloading Kubus 1.0.0/)).toHaveLength(2);
  publish({ status: 'ready', progress: undefined });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Restart and install' })[0]!);
  expect(apply).toHaveBeenCalledOnce();
});

it('offers download retry after failure and surfaces ready updates after an earlier dismissal', () => {
  render(<UpdateNotification />);
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  publish({ status: 'error', message: 'Download interrupted', retry: 'download' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry download' }));
  expect(download).toHaveBeenCalledOnce();
  publish({ status: 'ready', message: undefined });
  expect(screen.getByRole('button', { name: 'Restart and install' })).toBeVisible();
});

it('explains package-managed updates without offering an unusable install button', () => {
  state = { status: 'disabled', currentVersion: '0.9.0', message: 'Update this installation using a new Debian package.' };
  render(<DesktopUpdateControls />);
  expect(screen.getByText(/using a new Debian package/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Restart and install' })).toBeNull();
});
