import { homedir } from 'node:os';
import path from 'node:path';

/** Stable desktop state location, independent of a random HTTP origin or app version. */
export function userDataPath(): string {
  if (process.env.KUBUS_DESKTOP_DATA) return path.resolve(process.env.KUBUS_DESKTOP_DATA);
  const home = homedir();
  const base = process.platform === 'darwin' ? path.join(home, 'Library/Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData/Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'kubus', 'desktop');
}
