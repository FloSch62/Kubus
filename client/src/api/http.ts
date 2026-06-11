import type { ApiErrorBody } from '@kubedeck/shared';

let token = '';

/** Capture the auth token from the URL (?token=...) once, then strip it. */
export function initAuthToken(): void {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('kubedeck-token', fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  }
  token = sessionStorage.getItem('kubedeck-token') ?? (import.meta.env.DEV ? 'dev' : '');
}

export function authToken(): string {
  return token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: ApiErrorBody & { current?: unknown },
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = body as ApiErrorBody | undefined;
    throw new ApiError(res.status, err?.message ?? `${res.status} ${res.statusText}`, body as ApiError['body']);
  }
  return body as T;
}

/** Authenticated fetch returning the raw Response (for blob/stream downloads). */
export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
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
