import { SESSION_AUTH_CHALLENGE, type ApiErrorBody } from '@kubus/shared';
import { reportAuthInvalid, reportAuthValid, reportBackendDown, reportBackendUp } from '../state/backend.js';

let token = '';

/** Capture the auth token from the URL (?token=...) once, then strip it. */
export function initAuthToken(): void {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('kubus-token', fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  }
  token = sessionStorage.getItem('kubus-token') ?? (import.meta.env.DEV ? 'dev' : '');
}

export function authToken(): string {
  return token;
}

export class ApiError extends Error {
  /**
   * The Kubus server rejected the session token. The global status banner
   * owns that state; a cluster's own 401 relayed by a route stays a per-call
   * error and leaves this false.
   */
  sessionRejected = false;

  constructor(
    public status: number,
    message: string,
    public body?: ApiErrorBody & { current?: unknown },
  ) {
    super(message);
  }
}

/** Only the server's own auth guard sends the challenge; relayed cluster 401s do not. */
function isSessionRejection(res: Response): boolean {
  return res.status === 401 && res.headers.get('www-authenticate') === SESSION_AUTH_CHALLENGE;
}

function responseError(res: Response, message: string, body?: ApiError['body']): ApiError {
  const err = new ApiError(res.status, message, body);
  err.sessionRejected = isSessionRejection(res);
  return err;
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

/**
 * Fetch that feeds the global backend-status store: connection failures and
 * session rejections are cross-cutting states (server gone / token stale),
 * not per-call errors, so every call site reports them here instead of
 * handling them. Every other response, including an error, proves the token
 * was accepted and clears a stale session flag.
 */
async function statusFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: authHeaders(init?.headers),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    reportBackendDown();
    throw new ApiError(0, 'Cannot reach the Kubus backend');
  }
  reportBackendUp();
  if (isSessionRejection(res)) reportAuthInvalid();
  else reportAuthValid();
  return res;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await statusFetch(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = body as ApiErrorBody | undefined;
    throw responseError(res, err?.message ?? `${res.status} ${res.statusText}`, body as ApiError['body']);
  }
  return body as T;
}

/** Authenticated fetch returning the raw Response (for blob/stream downloads). */
export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const res = await statusFetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw responseError(res, message);
  }
  return res;
}

export function wsUrl(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${proto}//${window.location.host}${path}`);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}
