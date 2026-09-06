import type { AppUpdater } from 'electron-updater';
import type { DesktopUpdateState } from '@kubus/shared';
import { mainLog } from './main-log.js';

export function updateDisabledReason({ packaged, platform, arch, store, appImage }: {
  packaged: boolean; platform: string; arch: string; store: boolean; appImage: boolean;
}): DesktopUpdateState['reason'] {
  if (!packaged) return 'development';
  if (store) return 'store';
  if (platform === 'darwin' && arch !== 'arm64') return 'unsupported-architecture';
  if (platform === 'linux' && !appImage) return 'package-manager';
  return undefined;
}

/** Owns one update operation for the entire app, independent of window lifetimes. */
export class DesktopUpdater {
  private state: DesktopUpdateState;
  private pending?: Promise<DesktopUpdateState>;
  private initialTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;

  constructor(private readonly options: {
    version: string;
    reason?: DesktopUpdateState['reason'];
    updater?: AppUpdater;
    /** Squirrel.Mac validates the signature after electron-updater downloads the ZIP. */
    nativeMacUpdater?: { on(event: 'update-downloaded', listener: () => void): unknown };
    broadcast(state: DesktopUpdateState): void;
    prepareInstall(): void;
    recoverInstall(): void;
  }) {
    this.state = { currentVersion: options.version, status: options.reason ? 'disabled' : 'idle', reason: options.reason };
    const updater = options.updater;
    if (!updater || options.reason) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = {
      info: (message: unknown) => mainLog('info', `updater: ${String(message)}`),
      warn: (message: unknown) => mainLog('warn', `updater: ${String(message)}`),
      error: (message: unknown) => mainLog('error', `updater: ${String(message)}`),
    };
    updater.on('error', (error) => this.fail(error));
    updater.on('update-not-available', () => this.set({ status: 'up-to-date' }));
    updater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    updater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
      if (percent !== this.state.percent) this.set({ ...this.state, percent });
    });
    updater.on('update-downloaded', (info) => {
      this.set({ status: options.nativeMacUpdater ? 'downloading' : 'ready', version: info.version, percent: 100 });
    });
    options.nativeMacUpdater?.on('update-downloaded', () => {
      this.set({ status: 'ready', version: this.state.version, percent: 100 });
    });
  }

  getState(): DesktopUpdateState { return this.state; }

  start(): void {
    if (this.state.status === 'disabled' || this.interval) return;
    // Let the first window and cluster connections settle before network/disk work.
    this.initialTimer = setTimeout(() => void this.check(), 15_000);
    this.interval = setInterval(() => void this.check(), 4 * 60 * 60 * 1000);
    this.initialTimer.unref();
    this.interval.unref();
  }

  stop(): void {
    clearTimeout(this.initialTimer);
    clearInterval(this.interval);
    this.initialTimer = undefined;
    this.interval = undefined;
  }

  check(): Promise<DesktopUpdateState> {
    if (this.pending) return this.pending;
    if (['disabled', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.state);
    this.pending = this.runCheck().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  requestInstall(): boolean {
    if (this.state.status !== 'ready') return false;
    this.set({ ...this.state, status: 'installing' });
    this.stop();
    this.options.prepareInstall();
    return true;
  }

  /** Called only after the embedded server and persisted state have been closed. */
  finishInstall(): void {
    try {
      this.options.updater!.quitAndInstall(false, true);
    } catch (error) {
      this.fail(error);
    }
  }

  private async runCheck(): Promise<DesktopUpdateState> {
    this.set({ status: 'checking' });
    try {
      const result = await this.options.updater!.checkForUpdates();
      if (!result) throw new Error('The update service is unavailable.');
      if (this.getState().status === 'downloading') await this.options.updater!.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  private fail(error: unknown): void {
    const installing = this.state.status === 'installing';
    mainLog('error', 'desktop update failed', error);
    this.set({ status: 'error', error: 'The update could not be completed. Check your connection and try again.' });
    // The server has already shut down; reopen the installed version if its
    // installer fails so the user does not remain in a disconnected window.
    if (installing) this.options.recoverInstall();
  }

  private set(state: Omit<DesktopUpdateState, 'currentVersion'>): void {
    this.state = { currentVersion: this.options.version, ...state };
    this.options.broadcast(this.state);
  }
}
