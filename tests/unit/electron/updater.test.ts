import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdater } from '../../../electron/node_modules/electron-updater/out/main.js';
import { DesktopUpdater, updateDisabledReason } from '../../../electron/src/updater.js';
import { distributionConfig } from '../../../electron/scripts/build-config.js';

vi.mock('../../../electron/src/main-log.js', () => ({ mainLog: vi.fn() }));

function setup(mac = false) {
  const transport = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async (): Promise<unknown> => {
      transport.emit('update-available', { version: '1.0.0' });
      return { updateInfo: { version: '1.0.0' } };
    }),
    downloadUpdate: vi.fn(async () => { transport.emit('update-downloaded', { version: '1.0.0' }); }),
    quitAndInstall: vi.fn(),
  });
  const native = new EventEmitter();
  const broadcast = vi.fn();
  const prepareInstall = vi.fn();
  const recoverInstall = vi.fn();
  const updater = new DesktopUpdater({ version: '0.9.0', updater: transport as unknown as AppUpdater,
    nativeMacUpdater: mac ? native : undefined, broadcast, prepareInstall, recoverInstall });
  return { updater, transport, native, broadcast, prepareInstall, recoverInstall };
}

afterEach(() => vi.useRealTimers());

describe('desktop updates', () => {
  it('shares a check/download between windows, downloads automatically and prevents duplicate installs', async () => {
    const { updater, transport, prepareInstall } = setup();
    const first = updater.check();
    expect(updater.check()).toBe(first);
    await first;
    expect(transport.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.getState()).toMatchObject({ status: 'ready', version: '1.0.0' });
    await updater.check();
    expect(transport.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.requestInstall()).toBe(true);
    expect(updater.requestInstall()).toBe(false);
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(transport.quitAndInstall).not.toHaveBeenCalled();
    updater.finishInstall();
    expect(transport.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it('waits for Squirrel.Mac signature validation before enabling restart', async () => {
    const { updater, native } = setup(true);
    await updater.check();
    expect(updater.getState().status).toBe('downloading');
    expect(updater.requestInstall()).toBe(false);
    native.emit('update-downloaded');
    expect(updater.getState().status).toBe('ready');
  });

  it('recovers from network and signature errors and only broadcasts whole percentage changes', async () => {
    const { updater, transport, broadcast } = setup();
    transport.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await updater.check();
    expect(updater.getState().status).toBe('error');
    await updater.check();
    expect(updater.getState().status).toBe('ready');
    transport.emit('error', new Error('invalid signature'));
    expect(updater.requestInstall()).toBe(false);
    transport.emit('download-progress', { percent: 10.3 });
    const count = broadcast.mock.calls.length;
    transport.emit('download-progress', { percent: 10.8 });
    expect(broadcast).toHaveBeenCalledTimes(count);
  });

  it('shows up-to-date, handles a disabled transport and reopens after an installer error', async () => {
    const { updater, transport, recoverInstall } = setup();
    transport.checkForUpdates.mockImplementationOnce(async () => {
      transport.emit('update-not-available');
      return {};
    });
    await updater.check();
    expect(updater.getState().status).toBe('up-to-date');
    transport.checkForUpdates.mockResolvedValueOnce(null);
    await updater.check();
    expect(updater.getState().status).toBe('error');
    await updater.check();
    updater.requestInstall();
    transport.quitAndInstall.mockImplementationOnce(() => { throw new Error('installer failed'); });
    updater.finishInstall();
    expect(recoverInstall).toHaveBeenCalledOnce();
  });

  it('checks after startup and periodically, and stops timers on shutdown', async () => {
    vi.useFakeTimers();
    const { updater, transport } = setup();
    transport.checkForUpdates.mockImplementation(async () => { transport.emit('update-not-available'); return {}; });
    updater.start(); updater.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(transport.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(transport.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.stop();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(transport.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('leaves development, Store and system package installs to their update owner', async () => {
    const base = { packaged: true, platform: 'win32', arch: 'x64', store: false, appImage: false };
    expect(updateDisabledReason(base)).toBeUndefined();
    expect(updateDisabledReason({ ...base, packaged: false })).toBe('development');
    expect(updateDisabledReason({ ...base, store: true })).toBe('store');
    expect(updateDisabledReason({ ...base, platform: 'darwin' })).toBe('unsupported-architecture');
    expect(updateDisabledReason({ ...base, platform: 'darwin', arch: 'arm64' })).toBeUndefined();
    expect(updateDisabledReason({ ...base, platform: 'linux' })).toBe('package-manager');
    expect(updateDisabledReason({ ...base, platform: 'linux', appImage: true })).toBeUndefined();
    const broadcast = vi.fn();
    const updater = new DesktopUpdater({ version: '0.9.0', reason: 'store', broadcast, prepareInstall: vi.fn(), recoverInstall: vi.fn() });
    updater.start();
    expect((await updater.check()).status).toBe('disabled');
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('release signing configuration', () => {
  it('requires Apple credentials in release builds and keeps local packaging usable', () => {
    expect(distributionConfig({}, 'darwin').mac).toBeUndefined();
    expect(() => distributionConfig({ KUBUS_RELEASE: '1' }, 'darwin')).toThrow('CSC_LINK');
    const config = distributionConfig({ KUBUS_RELEASE: '1', CSC_LINK: 'certificate', CSC_KEY_PASSWORD: 'password',
      APPLE_ID: 'id', APPLE_TEAM_ID: 'team', APPLE_APP_SPECIFIC_PASSWORD: 'password' }, 'darwin');
    expect(config).toMatchObject({ forceCodeSigning: true, mac: { notarize: true, hardenedRuntime: true } });
  });

  it('keeps Windows signing optional but fails closed when a signing mode is selected', () => {
    expect(distributionConfig({}, 'win32').forceCodeSigning).toBeUndefined();
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'azure' }, 'win32')).toThrow('WINDOWS_PUBLISHER_NAME');
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'certificate', WINDOWS_PUBLISHER_NAME: 'Publisher' }, 'win32')).toThrow('WIN_CSC_LINK');
    expect(distributionConfig({ WINDOWS_SIGNING: 'certificate', WINDOWS_PUBLISHER_NAME: 'Publisher', WIN_CSC_LINK: 'cert' }, 'win32'))
      .toMatchObject({ forceCodeSigning: true, win: { signtoolOptions: { publisherName: 'Publisher' } } });
    expect(distributionConfig({ WINDOWS_SIGNING: 'custom', WINDOWS_PUBLISHER_NAME: 'Publisher', WINDOWS_SIGN_SCRIPT: './sign.cjs' }, 'win32'))
      .toMatchObject({ forceCodeSigning: true, win: { signtoolOptions: { sign: './sign.cjs' } } });
    expect(distributionConfig({ WINDOWS_SIGNING: 'azure', WINDOWS_PUBLISHER_NAME: 'Publisher', AZURE_SIGNING_ENDPOINT: 'https://example.com',
      AZURE_SIGNING_ACCOUNT: 'account', AZURE_SIGNING_PROFILE: 'profile' }, 'win32')).toMatchObject({ win: { azureSignOptions: { certificateProfileName: 'profile' } } });
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'typo', WINDOWS_PUBLISHER_NAME: 'Publisher' }, 'win32')).toThrow('Unknown');
  });

  it('requires the reserved Store identity and emits a separate package without a GitHub update feed', () => {
    expect(() => distributionConfig({ KUBUS_WINDOWS_TARGET: 'store' }, 'win32')).toThrow('WINDOWS_STORE_IDENTITY_NAME');
    const config = distributionConfig({ KUBUS_WINDOWS_TARGET: 'store', WINDOWS_STORE_IDENTITY_NAME: '123.Kubus',
      WINDOWS_STORE_PUBLISHER: 'CN=publisher-id', WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: 'Publisher' }, 'win32');
    expect(config).toMatchObject({ publish: null, extraMetadata: { kubusUpdateMode: 'store' }, directories: { output: 'release-store' } });
  });
});
