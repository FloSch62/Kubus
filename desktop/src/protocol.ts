import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** macOS registration is part of the bundle; other platforms register per user. */
export function registerProtocol(launcher: string, icon: string): void {
  if (process.platform === 'linux') {
    const applications = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'applications');
    mkdirSync(applications, { recursive: true });
    const quote = (value: string) => `"${value.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`;
    writeFileSync(path.join(applications, 'io.github.flosch62.kubus.desktop'),
      `[Desktop Entry]\nType=Application\nName=Kubus\nExec=${quote(launcher)} %u\nIcon=${icon}\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/kubus;\nStartupWMClass=Kubus\n`);
    execFileSync('xdg-mime', ['default', 'io.github.flosch62.kubus.desktop', 'x-scheme-handler/kubus']);
  } else if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Classes\\kubus';
    const add = (suffix: string, args: string[]) => execFileSync('reg.exe', ['add', key + suffix, ...args, '/f'], { windowsHide: true });
    add('', ['/ve', '/d', 'URL:Kubus']);
    add('', ['/v', 'URL Protocol', '/d', '']);
    add('\\shell\\open\\command', ['/ve', '/d', `"${launcher}" "%1"`]);
  }
}
