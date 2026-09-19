import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { parseInterfaces, readPodInterfaces } from '../../../server/src/plugins/pod-interfaces.js';

afterEach(() => vi.useRealTimers());
describe('bounded Pod interface inspection', () => {
  it('keeps administrative state, carrier and UNKNOWN operational state distinct', () => {
    expect(
      parseInterfaces(
        JSON.stringify([
          { ifname: 'e1-1', operstate: 'UP', flags: ['UP', 'LOWER_UP'], mtu: 9500 },
          { ifname: 'e1-2', operstate: 'DOWN', flags: ['UP', 'NO-CARRIER'] },
          { ifname: 'e1-3', operstate: 'UNKNOWN', flags: ['UP'] },
          { ifname: 'e1-4', operstate: 'DOWN', flags: [] },
        ]),
      ),
    ).toMatchObject([
      { name: 'e1-1', adminUp: true, carrier: true },
      { name: 'e1-2', adminUp: true, carrier: false },
      { name: 'e1-3', adminUp: true, carrier: null },
      { name: 'e1-4', adminUp: false, carrier: false },
    ]);
    expect(() => parseInterfaces('[{"ifname":"e1-1"}]')).toThrow();
  });
  function fixture(behavior?: (stdout: PassThrough, status: (s: { status: string }) => void) => void) {
    const ws = Object.assign(new EventEmitter(), { close: vi.fn() });
    const exec = vi.fn(async (_ns, _pod, _container, _argv, stdout, _stderr, _stdin, _tty, status) => {
      behavior?.(stdout, status);
      return ws;
    });
    return { ws, exec, handle: { makeExec: () => ({ exec }) } as unknown as ClusterHandle };
  }
  it('uses fixed argv without stdin/TTY and closes the connection after a successful snapshot', async () => {
    const f = fixture((stdout, done) => {
      stdout.write('[{"ifname":"eth1","flags":["UP","LOWER_UP"]}]');
      done({ status: 'Success' });
    });
    expect(await readPodInterfaces(f.handle, 'lab', 'pod', 'device', new AbortController().signal)).toMatchObject([
      { name: 'eth1', carrier: true },
    ]);
    expect(f.exec.mock.calls[0]?.slice(0, 4)).toEqual(['lab', 'pod', 'device', ['ip', '-j', 'link', 'show']]);
    expect(f.exec.mock.calls[0]?.slice(6, 8)).toEqual([null, false]);
    expect(f.ws.close).toHaveBeenCalled();
  });
  it('cancels a hanging connection and closes sockets that arrive after cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = readPodInterfaces(f.handle, 'lab', 'pod', 'device', new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(f.ws.close).toHaveBeenCalled();
  });
  it('bounds output and aborts when the requesting page leaves', async () => {
    const large = fixture((stdout) => stdout.write(Buffer.alloc(1_048_577)));
    await expect(readPodInterfaces(large.handle, 'lab', 'pod', 'device', new AbortController().signal)).rejects.toThrow('output limit');
    const f = fixture();
    const controller = new AbortController();
    const pending = readPodInterfaces(f.handle, 'lab', 'pod', 'device', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(f.ws.close).toHaveBeenCalled();
  });
});
