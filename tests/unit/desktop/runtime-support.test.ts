import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), log: vi.fn(), claim: vi.fn(), close: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('@kubus/server', () => ({ appendAppLog: mocks.log }));
vi.mock('../../../desktop/src/instance.js', () => ({ claimInstance: mocks.claim }));
const platform = process.platform;
let dir: string;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), 'kubus-support-'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

it('registers quoted per-user URL handlers on Linux and Windows', async () => {
  const { registerProtocol } = await import('../../../desktop/src/protocol.js');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('XDG_DATA_HOME', dir);
  registerProtocol('/a space/"$%/kubus-link', '/icon.png');
  const entry = readFileSync(path.join(dir, 'applications/io.github.flosch62.kubus.desktop'), 'utf8');
  expect(entry).toContain('Exec="/a space/\\"\\$%%/kubus-link" %u');
  expect(mocks.exec).toHaveBeenCalledWith('xdg-mime', ['default', 'io.github.flosch62.kubus.desktop', 'x-scheme-handler/kubus']);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  registerProtocol('C:\\Program Files\\Kubus\\kubus-link.exe', 'icon');
  expect(mocks.exec).toHaveBeenLastCalledWith('reg.exe', ['add', 'HKCU\\Software\\Classes\\kubus\\shell\\open\\command', '/ve', '/d', '"C:\\Program Files\\Kubus\\kubus-link.exe" "%1"', '/f'], { windowsHide: true });
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mocks.exec.mockClear(); registerProtocol('ignored', 'ignored'); expect(mocks.exec).not.toHaveBeenCalled();
});

it('chooses stable platform storage and honors isolation overrides', async () => {
  const { userDataPath } = await import('../../../desktop/src/paths.js');
  vi.stubEnv('KUBUS_DESKTOP_DATA', dir); expect(userDataPath()).toBe(dir);
  vi.stubEnv('KUBUS_DESKTOP_DATA', '');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('XDG_CONFIG_HOME', dir); expect(userDataPath()).toBe(path.join(dir, 'kubus/desktop'));
  vi.stubEnv('XDG_CONFIG_HOME', ''); expect(userDataPath()).toContain('.config');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('APPDATA', dir); expect(userDataPath()).toBe(path.join(dir, 'kubus/desktop'));
  vi.stubEnv('APPDATA', ''); expect(userDataPath()).toContain('AppData');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  expect(userDataPath()).toContain('Library/Application Support');
});

it('rotates diagnostics, mirrors errors, and tolerates unwritable paths', async () => {
  const { initMainLog, mainLog, mainLogPath, installCrashCapture } = await import('../../../desktop/src/main-log.js');
  mainLog('info', 'before startup');
  initMainLog(dir);
  writeFileSync(mainLogPath()!, 'x'.repeat(1024 * 1024 + 1));
  initMainLog(dir);
  expect(readFileSync(path.join(dir, 'logs/main.old.log'), 'utf8')).toHaveLength(1024 * 1024 + 1);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const error of [new Error('failure'), 'text', 3, false, 4n, { code: 1 }, circular]) mainLog('error', 'detail', error);
  expect(readFileSync(mainLogPath()!, 'utf8')).toContain('failure');
  const before = new Set(process.listeners('uncaughtExceptionMonitor'));
  installCrashCapture();
  const added = process.listeners('uncaughtExceptionMonitor').filter((listener) => !before.has(listener));
  for (const listener of added) {
    listener(new Error('fatal'), 'unhandledRejection');
    listener(new Error('fatal'), 'uncaughtException');
    EventEmitter.prototype.removeListener.call(process, 'uncaughtExceptionMonitor', listener);
  }
  expect(mocks.log).toHaveBeenLastCalledWith('error', 'uncaught exception in the main process', expect.any(Object));
  const file = path.join(dir, 'file'); writeFileSync(file, 'not a directory');
  initMainLog(file);
  rmSync(dir, { recursive: true });
  expect(() => mainLog('warn', 'disk unavailable')).not.toThrow();
});

it('queues startup activations until ready and releases the instance on shutdown', async () => {
  let receive: ((link?: string) => void) | undefined;
  mocks.claim.mockImplementation(async (_path, _link, activate) => { receive = activate; return { close: mocks.close }; });
  const channels: Array<{ onmessage: (event: { data: { type: string } }) => void; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('BroadcastChannel', class {
    onmessage = (_event: { data: { type: string } }) => {}; postMessage = vi.fn(); close = vi.fn();
    constructor() { channels.push(this); }
  });
  const post = vi.fn(); vi.stubGlobal('postMessage', post);
  await import('../../../desktop/src/instance-worker.js');
  const channel = channels[0]!;
  expect(post).toHaveBeenCalledWith({ claimed: true });
  receive!('kubus://pods'); expect(channel!.postMessage).not.toHaveBeenCalled();
  channel!.onmessage({ data: { type: 'ready' } });
  expect(channel!.postMessage).toHaveBeenCalledWith({ type: 'activate', link: 'kubus://pods' });
  receive!(); expect(channel!.postMessage).toHaveBeenLastCalledWith({ type: 'activate', link: undefined });
  channel!.onmessage({ data: { type: 'shutdown' } });
  expect(mocks.close).toHaveBeenCalledOnce(); expect(channel!.close).toHaveBeenCalledOnce();
});
