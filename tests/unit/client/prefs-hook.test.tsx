import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PaneActiveContext } from '../../../client/src/layout/pane-context';
import { useRefetchInterval, useUiPrefsStore } from '../../../client/src/state/prefs';

describe('useRefetchInterval', () => {
  beforeEach(() => {
    // Pin the per-mount jitter: 0.9 + 0.5 * 0.2 = exactly 1.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(() => useUiPrefsStore.setState({ refreshRate: 'normal' }));
    localStorage.clear();
  });

  it('scales the base interval by the refresh-rate preset', async () => {
    const { result } = renderHook(() => useRefetchInterval(10000));
    expect(result.current).toBe(10000); // normal

    await act(() => useUiPrefsStore.setState({ refreshRate: 'fast' }));
    expect(result.current).toBe(5000);

    await act(() => useUiPrefsStore.setState({ refreshRate: 'slow' }));
    expect(result.current).toBe(20000);

    await act(() => useUiPrefsStore.setState({ refreshRate: 'off' }));
    expect(result.current).toBe(false);
  });

  it('keeps the jitter stable across re-renders within a mount', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // jitter 0.9
    const { result, rerender } = renderHook(() => useRefetchInterval(10000));
    expect(result.current).toBe(9000);
    vi.spyOn(Math, 'random').mockReturnValue(1); // would be 1.1 on a fresh mount
    rerender();
    expect(result.current).toBe(9000);
  });

  it('pauses while the enclosing pane is hidden', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PaneActiveContext.Provider value={false}>{children}</PaneActiveContext.Provider>
    );
    const { result } = renderHook(() => useRefetchInterval(10000), { wrapper });
    expect(result.current).toBe(false);
  });
});
