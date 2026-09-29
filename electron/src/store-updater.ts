import type { DesktopUpdateState } from '@kubus/shared';
import type { StoreBridge } from './store-bridge.js';
import { mainLog } from './main-log.js';

/** Store owns download, consent and installation; electron-updater is never used. */
export class StoreUpdater {
  private state: DesktopUpdateState;
  private pending?: Promise<DesktopUpdateState>;
  private initialTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;

  constructor(private readonly options: {
    version: string;
    bridge: StoreBridge;
    broadcast(state: DesktopUpdateState): void;
    beforeInstall(): void;
  }) {
    this.state = { currentVersion: options.version, source: 'store', status: 'idle' };
  }

  getState(): DesktopUpdateState { return this.state; }

  start(): void {
    if (this.interval) return;
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
    if (this.state.status === 'updated') return Promise.resolve(this.state);
    this.pending = this.run('check').finally(() => { this.pending = undefined; });
    return this.pending;
  }

  requestInstall(): boolean {
    if (this.pending || this.state.status !== 'available') return false;
    this.pending = this.run('install').finally(() => { this.pending = undefined; });
    return true;
  }

  private async run(command: 'check' | 'install'): Promise<DesktopUpdateState> {
    this.set({ status: command === 'check' ? 'checking' : 'installing' });
    try {
      if (command === 'install') this.options.beforeInstall();
      const result = await this.options.bridge.run(command, (percent) => {
        if (this.state.percent !== percent) this.set({ status: 'installing', percent });
      });
      this.set({ status: result === 'canceled' ? 'available' : result });
    } catch (error) {
      mainLog('error', 'Microsoft Store update failed', error);
      this.set({ status: 'error', error: command === 'check'
        ? 'Microsoft Store could not check for updates. Try again or open Microsoft Store.'
        : 'Microsoft Store could not complete the update. Check for updates again or open Microsoft Store.' });
    }
    return this.state;
  }

  private set(state: Pick<DesktopUpdateState, 'status' | 'percent' | 'error'>): void {
    this.state = { currentVersion: this.options.version, source: 'store', ...state };
    this.options.broadcast(this.state);
  }
}
