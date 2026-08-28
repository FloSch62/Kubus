import type { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KUBE_REQUEST_DEADLINE_MS, RawClient, isRetryableTransportError, resourcePath } from '../../../server/src/kube/raw-client.js';

interface RawClientInternals {
  withDeadline<T>(
    path: string,
    init: { method?: string; signal?: AbortSignal; deadlineMs?: number | false } | undefined,
    run: (init: { method?: string; signal?: AbortSignal; deadlineMs?: number | false }) => Promise<T>,
  ): Promise<T>;
  safeGet<T>(init: { method?: string; signal?: AbortSignal } | undefined, run: () => Promise<T>): Promise<T>;
}

afterEach(() => vi.useRealTimers());

describe('resourcePath', () => {
  it('uses /api for the core group and /apis otherwise', () => {
    expect(resourcePath('', 'v1', 'nodes')).toBe('/api/v1/nodes');
    expect(resourcePath('apps', 'v1', 'deployments')).toBe('/apis/apps/v1/deployments');
    expect(resourcePath('networking.k8s.io', 'v1', 'ingresses')).toBe('/apis/networking.k8s.io/v1/ingresses');
  });

  it('inserts the namespace segment before the plural', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'kube-system' })).toBe('/api/v1/namespaces/kube-system/pods');
    expect(resourcePath('apps', 'v1', 'deployments', { namespace: 'default' })).toBe(
      '/apis/apps/v1/namespaces/default/deployments',
    );
  });

  it('appends name and subresource', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'ns', name: 'web-0', subresource: 'log' })).toBe(
      '/api/v1/namespaces/ns/pods/web-0/log',
    );
    expect(resourcePath('apps', 'v1', 'deployments', { namespace: 'default', name: 'web', subresource: 'scale' })).toBe(
      '/apis/apps/v1/namespaces/default/deployments/web/scale',
    );
  });

  it('percent-encodes namespace and name', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'a b', name: 'p:1' })).toBe('/api/v1/namespaces/a%20b/pods/p%3A1');
  });

  it('appends query parameters when present', () => {
    const query = new URLSearchParams({ labelSelector: 'owner=helm', limit: '500' });
    expect(resourcePath('', 'v1', 'secrets', { namespace: 'default', query })).toBe(
      '/api/v1/namespaces/default/secrets?labelSelector=owner%3Dhelm&limit=500',
    );
  });

  it('omits the question mark for an empty query', () => {
    expect(resourcePath('', 'v1', 'pods', { query: new URLSearchParams() })).toBe('/api/v1/pods');
  });
});

describe('isRetryableTransportError', () => {
  it.each(['ECONNABORTED', 'ECONNRESET', 'ENETRESET', 'EPIPE', 'ETIMEDOUT'])('retries %s', (code) => {
    expect(isRetryableTransportError(Object.assign(new Error('boom'), { code }))).toBe(true);
    expect(isRetryableTransportError({ code })).toBe(true);
  });

  it('rejects non-transport and unknown codes', () => {
    expect(isRetryableTransportError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isRetryableTransportError(Object.assign(new Error('tls'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }))).toBe(false);
    expect(isRetryableTransportError({ code: 500 })).toBe(false);
    expect(isRetryableTransportError(new Error('plain'))).toBe(false);
    expect(isRetryableTransportError('ECONNRESET')).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
    expect(isRetryableTransportError(null)).toBe(false);
  });

  it('unwraps nested causes up to three levels deep', () => {
    const wrap = (cause: unknown) => Object.assign(new Error('wrapped'), { cause });
    const reset = { code: 'ECONNRESET' };
    expect(isRetryableTransportError(wrap(reset))).toBe(true);
    expect(isRetryableTransportError(wrap(wrap(reset)))).toBe(true);
    expect(isRetryableTransportError(wrap(wrap(wrap(reset))))).toBe(true);
    // Depth cap: the fifth object in the chain is never inspected.
    expect(isRetryableTransportError(wrap(wrap(wrap(wrap(reset)))))).toBe(false);
  });
});

describe('RawClient request deadline', () => {
  it('bounds the whole operation and does not retry after the deadline aborts', async () => {
    vi.useFakeTimers();
    const raw = new RawClient({} as KubeConfig) as unknown as RawClientInternals;
    let attempts = 0;
    const request = raw.withDeadline('/api/v1/pods', undefined, (init) =>
      raw.safeGet(init, async () => {
        attempts += 1;
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ETIMEDOUT' })), { once: true });
        });
      }),
    );

    const rejection = expect(request).rejects.toThrow('Kubernetes API request timed out after 15s: /api/v1/pods');
    await vi.advanceTimersByTimeAsync(KUBE_REQUEST_DEADLINE_MS);
    await rejection;
    expect(attempts).toBe(1);
  });

  it('preserves a caller abort instead of reporting a deadline', async () => {
    vi.useFakeTimers();
    const raw = new RawClient({} as KubeConfig) as unknown as RawClientInternals;
    const caller = new AbortController();
    const request = raw.withDeadline('/version', { signal: caller.signal }, async () => new Promise<never>(() => {}));

    caller.abort(new Error('caller stopped'));
    await expect(request).rejects.toThrow('caller stopped');
  });

  it('supports longer per-request deadlines for large resource and schema responses', async () => {
    vi.useFakeTimers();
    const raw = new RawClient({} as KubeConfig) as unknown as RawClientInternals;
    const request = raw.withDeadline('/apis/eda.example.com/v1/fabrics', { deadlineMs: 60_000 }, async (init) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );

    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(KUBE_REQUEST_DEADLINE_MS);
    expect(settled).toBe(false);

    const rejection = expect(request).rejects.toThrow('timed out after 60s');
    await vi.advanceTimersByTimeAsync(60_000 - KUBE_REQUEST_DEADLINE_MS);
    await rejection;
  });
});

describe('RawClient watch streaming', () => {
  function makeKc(server = 'https://api.example.com:6443', proxyUrl?: string): KubeConfig {
    const headers = new Map([['authorization', 'Bearer token-1']]);
    return {
      getCurrentCluster: () => ({ server, proxyUrl }),
      applyToFetchOptions: async () => ({ agent: { options: { ca: 'CA-PEM', servername: 'api.internal' } }, headers }),
    } as unknown as KubeConfig;
  }

  function streamResponse(status: number, body = '') {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'X',
      body: null,
      text: async () => body,
    };
  }

  function makeTransport(overrides: Partial<Record<'probe' | 'request' | 'close', ReturnType<typeof vi.fn>>> = {}) {
    return {
      probe: vi.fn(async () => true),
      request: vi.fn(async () => streamResponse(200)),
      close: vi.fn(),
      ...overrides,
    };
  }

  it('opens watches through the HTTP/2 transport with auth headers and TLS material', async () => {
    const transport = makeTransport();
    const raw = new RawClient(makeKc('https://api.example.com:6443', 'socks5h://127.0.0.1:8888'), transport as never);
    const signal = new AbortController().signal;

    const res = await raw.stream('/api/v1/pods?watch=1', { signal, headers: { accept: 'metadata' } });
    expect(res.ok).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(1);
    const [key, target, path, headers, passedSignal] = transport.request.mock.calls[0]!;
    expect(typeof key).toBe('string');
    expect(target).toMatchObject({
      serverUrl: 'https://api.example.com:6443',
      proxyUrl: 'socks5h://127.0.0.1:8888',
      tls: { ca: 'CA-PEM', servername: 'api.internal' },
    });
    expect(path).toBe('/api/v1/pods?watch=1');
    expect(headers).toMatchObject({ authorization: 'Bearer token-1', accept: 'metadata' });
    expect(passedSignal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to an HTTP/1.1 request when the transport is unavailable, unless h2 is required', async () => {
    const { H2UnavailableError } = await import('../../../server/src/kube/h2-transport.js');
    const transport = makeTransport({
      request: vi.fn(async () => {
        throw new H2UnavailableError('http/1.1 only');
      }),
    });
    const raw = new RawClient(makeKc(), transport as never);
    const requestOnce = vi.fn(async () => streamResponse(200));
    (raw as unknown as { requestOnce: typeof requestOnce }).requestOnce = requestOnce;

    await expect(raw.stream('/watch')).resolves.toMatchObject({ ok: true });
    expect(requestOnce).toHaveBeenCalledTimes(1);

    await expect(raw.stream('/watch', { h2Required: true })).rejects.toBeInstanceOf(H2UnavailableError);
    expect(requestOnce).toHaveBeenCalledTimes(1);
  });

  it('turns failed watch responses into structured errors preferring the body message', async () => {
    const denied = makeTransport({ request: vi.fn(async () => streamResponse(403, '{"message":"watch is forbidden"}')) });
    await expect(new RawClient(makeKc(), denied as never).stream('/watch')).rejects.toMatchObject({
      code: 403,
      message: expect.stringContaining('watch is forbidden'),
    });

    const plain = makeTransport({ request: vi.fn(async () => streamResponse(500, 'boom')) });
    await expect(new RawClient(makeKc(), plain as never).stream('/watch')).rejects.toMatchObject({
      code: 500,
      message: expect.stringContaining('watch failed: 500'),
    });
  });

  it('reports multiplexing support via the transport probe and never for plain-http servers', async () => {
    const transport = makeTransport();
    await expect(new RawClient(makeKc(), transport as never).supportsMultiplexedWatch()).resolves.toBe(true);
    expect(transport.probe).toHaveBeenCalledTimes(1);

    const httpTransport = makeTransport();
    await expect(new RawClient(makeKc('http://127.0.0.1:8001'), httpTransport as never).supportsMultiplexedWatch()).resolves.toBe(false);
    expect(httpTransport.probe).not.toHaveBeenCalled();

    await expect(new RawClient(makeKc('http://127.0.0.1:8001'), httpTransport as never).stream('/watch', { h2Required: true })).rejects.toMatchObject({
      name: 'H2UnavailableError',
    });
  });

  it('dispose closes the pooled HTTP/2 sessions', () => {
    const transport = makeTransport();
    const raw = new RawClient(makeKc(), transport as never);
    raw.dispose();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
