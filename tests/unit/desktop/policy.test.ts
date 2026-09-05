import { describe, expect, it } from 'vitest';
import { isApplicationLaunch, parseWindowLaunch, routeFromDeepLink } from '../../../desktop/src/policy.js';

describe('desktop navigation policy', () => {
  it('accepts in-app deep links and rejects protocol-relative links', () => {
    expect(routeFromDeepLink('kubus://r/core/v1/pods?sel=a')).toBe('/r/core/v1/pods?sel=a');
    expect(routeFromDeepLink('kubus:///settings')).toBe('/settings');
    expect(routeFromDeepLink('https://example.com')).toBeUndefined();
    expect(routeFromDeepLink('kubus:////example.com')).toBeUndefined();
  });
  it('validates each native window surface', () => {
    const base = { windowId: 'one', title: 'Pods' };
    const page = { ...base, kind: 'page', tab: { path: '/r/core/v1/pods' } };
    expect(parseWindowLaunch(page)).toEqual(page);
    expect(parseWindowLaunch({ ...base, kind: 'dock', tab: { kind: 'logs', title: 'Logs' } })).toBeDefined();
    expect(parseWindowLaunch({ ...base, kind: 'tab-transfer', surface: 'page', transferId: 'transfer' })).toBeDefined();
    expect(parseWindowLaunch({ ...page, context: { selected: [], namespaces: [], navCollapsed: false } })).toBeDefined();
    for (const input of [null, [], {}, { ...page, windowId: '' }, { ...page, title: 3 }, { ...page, context: {} }, { ...page, tab: { path: '//evil' } }, { ...base, kind: 'dock', tab: { kind: 'evil' } }, { ...base, kind: 'tab-transfer', surface: 'other', transferId: 'a' }]) {
      expect(parseWindowLaunch(input)).toBeUndefined();
    }
    expect(isApplicationLaunch()).toBe(true);
    expect(isApplicationLaunch(page as never)).toBe(true);
    expect(isApplicationLaunch({ ...base, kind: 'dock' } as never)).toBe(false);
  });
});
