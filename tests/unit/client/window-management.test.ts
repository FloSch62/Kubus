import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppWindowLaunch } from '@kubus/shared';
import {
  decodeAppWindowLaunch,
  encodeAppWindowLaunch,
  isAppWindowLaunch,
} from '../../../client/src/window-management.js';

afterEach(() => vi.restoreAllMocks());

describe('secondary Kubus window payloads', () => {
  it('round-trips unicode page and dock launches', () => {
    const page: AppWindowLaunch = {
      kind: 'page',
      windowId: 'window-page',
      title: 'München — 工作负载',
      context: { selected: ['kind-a'], namespaces: ['production'], navCollapsed: true },
      tab: { path: '/r/apps/v1/deployments?q=api', customTitle: 'Production', pinned: true, color: '#42a5f5' },
    };
    const terminal: AppWindowLaunch = {
      kind: 'dock',
      windowId: 'window-terminal',
      title: 'Shell',
      tab: {
        kind: 'terminal',
        title: 'sh: api-0',
        ctx: 'kind-a',
        namespace: 'default',
        pod: 'api-0',
        container: 'app',
      },
    };

    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(page))).toEqual(page);
    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(terminal))).toEqual(terminal);
  });

  it('round-trips only an opaque token for live moves', () => {
    const launch: AppWindowLaunch = {
      kind: 'tab-transfer',
      surface: 'dock',
      windowId: 'window-transfer',
      title: 'Shell',
      transferId: 'opaque-token',
    };
    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(launch))).toEqual(launch);
  });

  it('rejects malformed, external, and oversized launch payloads', () => {
    expect(isAppWindowLaunch({ kind: 'page', windowId: 'w', title: 'Unsafe', tab: { path: '//evil.example' } })).toBe(false);
    expect(isAppWindowLaunch({ kind: 'tab-transfer', surface: 'dock', windowId: 'w', title: 'Missing', transferId: '' })).toBe(false);
    expect(isAppWindowLaunch({ kind: 'tab-transfer', surface: 'full-app', windowId: 'w', title: 'Bad shell', transferId: 'token' })).toBe(false);
    expect(isAppWindowLaunch({ kind: 'dock', windowId: 'w', title: 'Bad', tab: { kind: 'terminal' } })).toBe(false);
    expect(isAppWindowLaunch({
      kind: 'page',
      windowId: 'w',
      title: 'Bad context',
      context: { selected: 'not-an-array', namespaces: [], navCollapsed: false },
      tab: { path: '/' },
    })).toBe(false);
    expect(decodeAppWindowLaunch('not-json')).toBeUndefined();
  });
});
