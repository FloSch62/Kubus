import { describe, expect, it, vi } from 'vitest';
import { SshTunnelManager } from '../../../server/src/ssh/tunnel-manager';

interface TunnelManagerInternals {
  mapping: Record<string, string>;
  tunnels: Map<string, unknown>;
  settings: { save: ReturnType<typeof vi.fn> };
}

function managerWith(mapping: Record<string, string>) {
  const save = vi.fn();
  const manager = Object.create(SshTunnelManager.prototype) as SshTunnelManager;
  Object.assign(manager, { mapping: { ...mapping }, tunnels: new Map(), settings: { save } });
  return { manager, save, internals: manager as unknown as TunnelManagerInternals };
}

describe('SshTunnelManager context mapping', () => {
  it('moves a mapping to a context new key and persists it once', () => {
    const { manager, save, internals } = managerWith({ old: 'jump' });

    manager.rekeyContext('old', 'new');

    expect(internals.mapping).toEqual({ new: 'jump' });
    expect(save).toHaveBeenCalledWith({ sshTunnels: { new: 'jump' } });
  });

  it('keeps an explicit destination mapping while removing the stale source key', () => {
    const { manager, internals } = managerWith({ old: 'old-jump', new: 'new-jump' });

    manager.rekeyContext('old', 'new');

    expect(internals.mapping).toEqual({ new: 'new-jump' });
  });
});
