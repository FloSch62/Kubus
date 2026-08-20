import type { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KUBE_REQUEST_DEADLINE_MS, RawClient, isRetryableTransportError, resourcePath } from '../../../server/src/kube/raw-client.js';

interface RawClientInternals {
  withDeadline<T>(
    path: string,
    init: { method?: string; signal?: AbortSignal } | undefined,
    run: (init: { method?: string; signal?: AbortSignal }) => Promise<T>,
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
    const request = raw.withDeadline('/version', { signal: caller.signal }, async (init) => {
      await new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('caller stopped')), { once: true });
      });
    });

    caller.abort();
    await expect(request).rejects.toThrow('caller stopped');
  });
});
