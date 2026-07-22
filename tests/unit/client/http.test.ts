import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, authToken, initAuthToken, wsUrl } from '../../../client/src/api/http';
import { useBackendStore } from '../../../client/src/state/backend';

function resetUrl(path = '/'): void {
  window.history.replaceState({}, '', path);
}

beforeEach(() => {
  sessionStorage.clear();
  resetUrl();
  useBackendStore.setState({ unreachable: false, authInvalid: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initAuthToken', () => {
  it('captures ?token= into sessionStorage and strips it from the URL', () => {
    resetUrl('/app?token=sek&keep=1');
    initAuthToken();
    expect(sessionStorage.getItem('kubus-token')).toBe('sek');
    expect(authToken()).toBe('sek');
    expect(window.location.pathname).toBe('/app');
    expect(window.location.search).toBe('?keep=1');
  });

  it('reads an existing sessionStorage token when the URL has none', () => {
    sessionStorage.setItem('kubus-token', 'stored');
    initAuthToken();
    expect(authToken()).toBe('stored');
    expect(window.location.search).toBe('');
  });

  it('prefers the URL token over a previously stored one', () => {
    sessionStorage.setItem('kubus-token', 'stale');
    resetUrl('/?token=fresh');
    initAuthToken();
    expect(authToken()).toBe('fresh');
    expect(sessionStorage.getItem('kubus-token')).toBe('fresh');
  });
});

describe('apiFetch', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('returns the parsed JSON body and sends the bearer token', async () => {
    sessionStorage.setItem('kubus-token', 'tok');
    initAuthToken();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/thing')).resolves.toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/thing');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('keeps a caller-provided authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/thing', { headers: { authorization: 'Bearer custom' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer custom');
  });

  it('returns undefined for an empty response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(apiFetch('/api/none')).resolves.toBeUndefined();
  });

  it('marks the backend unreachable on a network failure and throws ApiError(0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, message: 'Cannot reach the Kubus backend' });
    expect(useBackendStore.getState().unreachable).toBe(true);
  });

  it('clears the unreachable flag once a fetch succeeds again', async () => {
    useBackendStore.setState({ unreachable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));

    await apiFetch('/api/x');
    expect(useBackendStore.getState().unreachable).toBe(false);
  });

  it('rethrows aborts without touching the backend state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));

    await expect(apiFetch('/api/x')).rejects.toThrow('aborted');
    expect(useBackendStore.getState().unreachable).toBe(false);
  });

  it('reports an invalid session on 401 and throws with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'token expired' }, 401)));

    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, message: 'token expired' });
    expect(useBackendStore.getState().authInvalid).toBe(true);
    expect(useBackendStore.getState().unreachable).toBe(false);
  });

  it('throws ApiError with the body message and attaches the body on non-401 errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'boom', code: 'X' }, 500)));

    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, message: 'boom', body: { message: 'boom', code: 'X' } });
    expect(useBackendStore.getState().authInvalid).toBe(false);
  });

  it('falls back to status text when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' })),
    );

    await expect(apiFetch('/api/x')).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
  });
});

describe('wsUrl', () => {
  it('derives ws:// from the page origin and appends token plus params', () => {
    sessionStorage.setItem('kubus-token', 'wstok');
    initAuthToken();
    expect(wsUrl('/ws/logs', { follow: true, tail: 100, ctx: 'kind-a' })).toBe(
      'ws://localhost:3000/ws/logs?token=wstok&follow=true&tail=100&ctx=kind-a',
    );
  });

  it('skips undefined params', () => {
    sessionStorage.setItem('kubus-token', 't');
    initAuthToken();
    expect(wsUrl('/ws/x', { a: undefined, b: 0 })).toBe('ws://localhost:3000/ws/x?token=t&b=0');
  });
});
