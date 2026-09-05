import { beforeEach, expect, it, vi } from 'vitest';
import type { UpdateStatusEntry } from 'electrobun/main';
import { AppUpdater } from '../../../desktop/src/updater.js';

const native = vi.hoisted(() => ({
  getLocalInfo: vi.fn(), checkForUpdate: vi.fn(), downloadUpdate: vi.fn(), updateInfo: vi.fn(),
  onStatusChange: vi.fn(),
}));
vi.mock('electrobun/main', () => ({ Updater: native }));
const available = { version: '1.0.0', updateAvailable: true, updateReady: false, error: '' };
beforeEach(() => {
  vi.resetAllMocks();
  native.getLocalInfo.mockResolvedValue({ version: '0.9.0', channel: 'stable', baseUrl: 'https://example.com' });
  native.checkForUpdate.mockResolvedValue(available);
  native.updateInfo.mockReturnValue({ ...available, updateReady: true });
});

it('serializes commands through a slow download and forwards progress and native fallback', async () => {
  const publish = vi.fn(), install = vi.fn(async () => true);
  const updater = new AppUpdater('0.9.0', publish, install);
  await updater.apply();
  expect(install).not.toHaveBeenCalled();
  await updater.check();
  let finish!: () => void;
  native.downloadUpdate.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const downloading = updater.download();
  await updater.check(); await updater.download(); await updater.apply();
  expect(native.checkForUpdate).toHaveBeenCalledOnce();
  expect(native.downloadUpdate).toHaveBeenCalledOnce();
  const status = native.onStatusChange.mock.calls[0]![0] as (entry: Partial<UpdateStatusEntry>) => void;
  status({ status: 'download-progress', details: { progress: 42 } });
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'downloading', progress: 42 }));
  status({ status: 'patch-failed' });
  expect(updater.state.status).toBe('downloading');
  finish(); await downloading;
  expect(updater.state.status).toBe('ready');
  await updater.apply();
  expect(install).toHaveBeenCalledOnce();
  expect(updater.state.status).toBe('installing');
});

it('handles returned errors and rejected downloads, with a retry that reaches ready', async () => {
  const updater = new AppUpdater('0.9.0', vi.fn(), vi.fn(async () => false));
  native.checkForUpdate.mockResolvedValueOnce({ ...available, error: 'Offline' });
  await updater.check();
  expect(updater.state).toMatchObject({ status: 'error', retry: 'check', message: 'Offline' });
  await updater.check();
  native.downloadUpdate.mockRejectedValueOnce(new Error('Interrupted'));
  await updater.download();
  expect(updater.state).toMatchObject({ status: 'error', retry: 'download' });
  native.updateInfo.mockReturnValueOnce({ ...available, error: 'Invalid archive' });
  await updater.download();
  expect(updater.state).toMatchObject({ status: 'error', message: 'Invalid archive' });
  await updater.download();
  expect(updater.state.status).toBe('ready');
  await updater.apply();
  expect(updater.state.status).toBe('ready');
});

it('restores prepared updates from the native check without downloading again', async () => {
  native.checkForUpdate.mockResolvedValue({ ...available, updateReady: true });
  const updater = new AppUpdater('0.9.0', vi.fn(), vi.fn(async () => true));
  await updater.check(); await updater.download();
  expect(updater.state.status).toBe('ready');
  expect(native.downloadUpdate).not.toHaveBeenCalled();
});

it('reports current builds and disables development and package-managed installations', async () => {
  native.checkForUpdate.mockResolvedValue({ ...available, updateAvailable: false });
  const updater = new AppUpdater('0.9.0', vi.fn(), vi.fn(async () => true));
  await updater.check();
  expect(updater.state.status).toBe('up-to-date');
  native.getLocalInfo.mockResolvedValue({ channel: 'dev' });
  await updater.check();
  expect(updater.state.status).toBe('disabled');
  const deb = new AppUpdater('0.9.0', vi.fn(), vi.fn(async () => true), 'Use a Debian package.');
  await deb.check(); await deb.download(); await deb.apply();
  expect(native.checkForUpdate).toHaveBeenCalledOnce();
  expect(deb.state).toMatchObject({ status: 'disabled', message: 'Use a Debian package.' });
});
