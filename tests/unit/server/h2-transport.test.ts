import { EventEmitter } from 'node:events';
import type { TLSSocket } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { H2UnavailableError, H2WatchTransport, type H2DialTarget } from '../../../server/src/kube/h2-transport';

const connectMock = vi.fn();
vi.mock('node:http2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http2')>();
  const connect = (...args: unknown[]) => connectMock(...args);
  return { ...actual, connect, default: { ...actual, connect } };
});

class FakeStream extends EventEmitter {
  destroyedWith: unknown;
  constructor(readonly headers: Record<string, string>) {
    super();
  }

  destroy(err?: unknown): void {
    this.destroyedWith = err;
    if (err) this.emit('error', err);
    this.emit('close');
  }

  respond(status = 200): void {
    this.emit('response', { ':status': status });
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  remoteSettings = { maxConcurrentStreams: 250 };
  requests: FakeStream[] = [];
  requestError?: unknown;

  request(headers: Record<string, string>): FakeStream {
    if (this.requestError) {
      const err = this.requestError;
      this.requestError = undefined;
      throw err;
    }
    const stream = new FakeStream(headers);
    this.requests.push(stream);
    return stream;
  }

  close(): void {
    this.closed = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  unref(): void {}
}

function h2Socket(alpnProtocol: string | false = 'h2'): TLSSocket {
  return { alpnProtocol, destroy: vi.fn() } as unknown as TLSSocket;
}

function target(): H2DialTarget {
  return { serverUrl: 'https://api.example.com:6443', tls: {} };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('H2WatchTransport', () => {
  beforeEach(() => {
    connectMock.mockReset();
    connectMock.mockImplementation(() => new FakeSession());
  });

  it('multiplexes concurrent watch streams over a single dialed session', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);

    const pending = Promise.all([
      transport.request('key', target(), '/watch/a', { authorization: 'Bearer t' }),
      transport.request('key', target(), '/watch/b', {}),
      transport.request('key', target(), '/watch/c', {}),
    ]);
    await settle();
    const session = connectMock.mock.results[0]!.value as FakeSession;
    expect(session.requests).toHaveLength(3);
    for (const stream of session.requests) stream.respond();

    const responses = await pending;
    expect(dial).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(responses.every((res) => res.ok && res.status === 200)).toBe(true);
    expect(session.requests[0]!.headers).toMatchObject({ ':method': 'GET', ':path': '/watch/a', authorization: 'Bearer t' });
  });

  it('opens a second session when the first reaches the server stream limit', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);
    connectMock.mockImplementation(() => {
      const session = new FakeSession();
      session.remoteSettings = { maxConcurrentStreams: 1 };
      return session;
    });

    const first = transport.request('key', target(), '/watch/a', {});
    await settle();
    const second = transport.request('key', target(), '/watch/b', {});
    await settle();

    expect(connectMock).toHaveBeenCalledTimes(2);
    (connectMock.mock.results[0]!.value as FakeSession).requests[0]!.respond();
    (connectMock.mock.results[1]!.value as FakeSession).requests[0]!.respond();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('remembers an http/1.1-only server per identity and reports it without re-dialing', async () => {
    const dial = vi.fn(async () => h2Socket('http/1.1'));
    const transport = new H2WatchTransport(dial);

    await expect(transport.request('key', target(), '/watch', {})).rejects.toBeInstanceOf(H2UnavailableError);
    await expect(transport.request('key', target(), '/watch', {})).rejects.toBeInstanceOf(H2UnavailableError);
    await expect(transport.probe('key', target())).resolves.toBe(false);
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('probes positively, pools the session, and reuses it for later requests', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);

    await expect(transport.probe('key', target())).resolves.toBe(true);
    await expect(transport.probe('key', target())).resolves.toBe(true);
    const pending = transport.request('key', target(), '/watch', {});
    await settle();
    (connectMock.mock.results[0]!.value as FakeSession).requests[0]!.respond();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('replays a watch once on a fresh session when the pooled one died', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);
    await transport.probe('key', target());
    const dead = connectMock.mock.results[0]!.value as FakeSession;
    dead.requestError = Object.assign(new Error('session closed'), { code: 'ERR_HTTP2_GOAWAY_SESSION' });

    const pending = transport.request('key', target(), '/watch', {});
    await settle();
    expect(dead.destroyed).toBe(true);
    const fresh = connectMock.mock.results[1]!.value as FakeSession;
    fresh.requests[0]!.respond();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(dial).toHaveBeenCalledTimes(2);
  });

  it('prepends the API server base path to :path for gateway-prefixed clusters', async () => {
    const transport = new H2WatchTransport(vi.fn(async () => h2Socket()));
    const prefixed: H2DialTarget = { serverUrl: 'https://gateway.example/kubernetes', tls: {} };

    const pending = transport.request('key', prefixed, '/api/v1/pods?watch=1', {});
    await settle();
    const stream = (connectMock.mock.results[0]!.value as FakeSession).requests[0]!;
    expect(stream.headers[':path']).toBe('/kubernetes/api/v1/pods?watch=1');
    stream.respond();
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('rejects an already-aborted request without dialing or opening a stream', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('caller stopped'), { name: 'AbortError' }));

    await expect(transport.request('key', target(), '/watch', {}, controller.signal)).rejects.toThrow('caller stopped');
    expect(dial).not.toHaveBeenCalled();
  });

  it('does not open a stream when the signal aborted while the session dial was pending', async () => {
    let releaseDial!: (socket: TLSSocket) => void;
    const dial = vi.fn(() => new Promise<TLSSocket>((resolve) => {
      releaseDial = resolve;
    }));
    const transport = new H2WatchTransport(dial);
    const controller = new AbortController();

    const pending = transport.request('key', target(), '/watch', {}, controller.signal);
    await settle();
    controller.abort(Object.assign(new Error('deadline'), { name: 'AbortError' }));
    releaseDial(h2Socket());

    await expect(pending).rejects.toThrow('deadline');
    const session = connectMock.mock.results[0]!.value as FakeSession;
    expect(session.requests).toHaveLength(0);
  });

  it('destroys the stream with the abort reason when the caller signal fires', async () => {
    const transport = new H2WatchTransport(vi.fn(async () => h2Socket()));
    const controller = new AbortController();

    const pending = transport.request('key', target(), '/watch', {}, controller.signal);
    await settle();
    const stream = (connectMock.mock.results[0]!.value as FakeSession).requests[0]!;
    stream.respond();
    await pending;

    const reason = Object.assign(new Error('caller stopped'), { name: 'AbortError' });
    controller.abort(reason);
    expect(stream.destroyedWith).toBe(reason);
  });

  it('drains old-identity sessions after rotation and dials the new identity', async () => {
    const dial = vi.fn(async () => h2Socket());
    const transport = new H2WatchTransport(dial);
    await transport.probe('old-key', target());
    const oldSession = connectMock.mock.results[0]!.value as FakeSession;

    const pending = transport.request('new-key', target(), '/watch', {});
    await settle();
    expect(oldSession.closed).toBe(true);
    (connectMock.mock.results[1]!.value as FakeSession).requests[0]!.respond();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(dial).toHaveBeenCalledTimes(2);
  });

  it('close() tears down sessions and refuses further work', async () => {
    const transport = new H2WatchTransport(vi.fn(async () => h2Socket()));
    await transport.probe('key', target());
    const session = connectMock.mock.results[0]!.value as FakeSession;

    transport.close();
    expect(session.destroyed).toBe(true);
    await expect(transport.request('key', target(), '/watch', {})).rejects.toBeInstanceOf(H2UnavailableError);
    await expect(transport.probe('key', target())).resolves.toBe(false);
  });
});
