import { Updater } from 'electrobun/main';
import type { AppUpdateState } from '@kubus/shared';

/** Commands return immediately over RPC; native operations report through state pushes. */
export class AppUpdater {
  state: AppUpdateState;
  private active = false;

  constructor(
    version: string,
    private readonly publish: (state: AppUpdateState) => void,
    private readonly install: () => Promise<boolean>,
    disabledReason?: string,
  ) {
    this.state = { status: disabledReason ? 'disabled' : 'idle', currentVersion: version, message: disabledReason };
    Updater.onStatusChange((entry) => {
      // Patch failure is recoverable: Electrobun falls back to the full archive.
      if (this.state.status === 'downloading') {
        this.set({ progress: entry.status === 'download-progress' ? entry.details?.progress : undefined });
      }
    });
  }

  private set(next: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...next };
    this.publish(this.state);
  }

  private async run(action: NonNullable<AppUpdateState['retry']>, operation: () => Promise<void>): Promise<void> {
    if (this.active || this.state.status === 'disabled') return;
    this.active = true;
    this.set({ status: action === 'check' ? 'checking' : action === 'download' ? 'downloading' : 'installing', message: undefined, progress: undefined, retry: undefined });
    try { await operation(); }
    catch (error) {
      this.set({ status: 'error', message: error instanceof Error ? error.message : String(error), retry: action === 'install' && !Updater.updateInfo().updateReady ? 'download' : action, progress: undefined });
    } finally { this.active = false; }
  }

  check(): Promise<void> {
    return this.run('check', async () => {
      const local = await Updater.getLocalInfo();
      if (local.channel === 'dev' || !local.baseUrl) {
        this.set({ status: 'disabled', message: 'Updates are available in installed release builds.' });
        return;
      }
      const info = await Updater.checkForUpdate();
      if (info.error) throw new Error(info.error);
      this.set({ currentVersion: local.version, latestVersion: info.version, status: info.updateAvailable ? (info.updateReady ? 'ready' : 'available') : 'up-to-date' });
    });
  }

  download(): Promise<void> {
    if (this.state.status !== 'available' && !(this.state.status === 'error' && this.state.retry === 'download')) return Promise.resolve();
    return this.run('download', async () => {
      await Updater.downloadUpdate();
      const info = Updater.updateInfo();
      if (info.error || !info.updateReady) throw new Error(info.error || 'The update could not be prepared. Try downloading again.');
      this.set({ status: 'ready', progress: undefined });
    });
  }

  apply(): Promise<void> {
    if (this.state.status !== 'ready' && !(this.state.status === 'error' && this.state.retry === 'install')) return Promise.resolve();
    return this.run('install', async () => {
      const handedOff = await this.install();
      const info = Updater.updateInfo();
      if (!handedOff && info.error) throw new Error(info.error);
      // Normally the process exits. A quit veto leaves the download available.
      if (!handedOff) this.set({ status: 'ready' });
    });
  }
}
