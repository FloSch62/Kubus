import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientState } from '../../../desktop/src/state.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'kubus-state-')); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

it('coalesces writes, synchronously flushes on shutdown, and preserves special keys', () => {
  const file = path.join(dir, 'client.json');
  const state = new ClientState(file, vi.fn());
  state.change('theme', 'dark');
  state.change('__proto__', 'safe');
  state.change('tabs', '[]');
  state.change('tabs', null);
  vi.advanceTimersByTime(150);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', ['__proto__']: 'safe' });
  state.change('theme', 'light');
  state.flush(false);
  expect(new ClientState(file, vi.fn()).snapshot()).toEqual({ theme: 'light', ['__proto__']: 'safe' });
});
it('ignores corrupt files and filters non-string values', () => {
  const file = path.join(dir, 'client.json');
  writeFileSync(file, '{');
  expect(new ClientState(file, vi.fn()).snapshot()).toEqual({});
  writeFileSync(file, JSON.stringify({ theme: 'dark', invalid: 1 }));
  expect(new ClientState(file, vi.fn()).snapshot()).toEqual({ theme: 'dark' });
});
it('keeps failed writes pending and retries', () => {
  const parent = path.join(dir, 'blocked');
  writeFileSync(parent, 'not a directory');
  const onError = vi.fn();
  const state = new ClientState(path.join(parent, 'client.json'), onError);
  state.change('theme', 'dark');
  vi.advanceTimersByTime(150);
  expect(onError).toHaveBeenCalledOnce();
  rmSync(parent);
  vi.advanceTimersByTime(5000);
  expect(JSON.parse(readFileSync(path.join(parent, 'client.json'), 'utf8'))).toEqual({ theme: 'dark' });
  state.flush(false);
});
