import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

export interface PersistedSettings {
  /** Explicit kubeconfig path chosen in the UI; overrides $KUBECONFIG. */
  kubeconfigPath?: string;
  /** Kubus-managed SSH tunnels: scoped kubeconfig context key -> ssh destination (config alias or user@host). */
  sshTunnels?: Record<string, string>;
}

/**
 * Server-side settings persisted across runs. Lives in the XDG config dir so
 * the CLI server and the Electron-embedded server share the same file.
 */
export class SettingsStore {
  readonly filePath: string;

  constructor(private log: FastifyBaseLogger) {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.filePath = path.join(configHome, 'kubus', 'settings.json');
  }

  load(): PersistedSettings {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as PersistedSettings;
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn({ err: String(err), file: this.filePath }, 'failed to read settings file');
      }
      return {};
    }
  }

  save(patch: PersistedSettings): void {
    const next: Record<string, unknown> = { ...this.load(), ...patch };
    // Explicit undefined in the patch deletes the key.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
