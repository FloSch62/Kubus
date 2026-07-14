import crypto from 'node:crypto';
import type { Agent } from 'node:http';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import { ApiException, type KubeConfig } from '@kubernetes/client-node';

type FetchAgent = Agent & { options: Record<string, unknown> };

const TRAILING_SLASH_RE = /\/$/;
const RETRYABLE_GET_ERROR_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ENETRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * Authenticated HTTP access to arbitrary API server paths for the things the
 * typed clients can't do generically: discovery, dynamic resource list/get,
 * subresources, and watch streams. Auth (incl. exec-plugin token refresh) is
 * re-applied per request via KubeConfig.applyToFetchOptions.
 */
export class RawClient {
  /** Keep-alive agent shared across requests while the TLS/proxy identity is stable. */
  private agentCache?: { key: string; agent: FetchAgent };

  constructor(private kc: KubeConfig) {}

  private serverUrl(): string {
    const cluster = this.kc.getCurrentCluster();
    if (!cluster) throw new Error('no active cluster in kubeconfig context');
    return cluster.server.replace(TRAILING_SLASH_RE, '');
  }

  /**
   * applyToFetchOptions builds a brand-new Agent per call, so every request
   * would pay a full TCP+TLS handshake. Swap it for a cached keep-alive agent,
   * keyed by everything that affects the connection (server, proxy, TLS
   * material) so exec-plugin cert rotation still gets a fresh pool.
   */
  private pooledAgent(fresh: unknown): unknown {
    const agent = fresh as FetchAgent | undefined;
    if (!agent || typeof agent !== 'object' || !agent.options) return fresh;
    const cluster = this.kc.getCurrentCluster();
    const hash = crypto.createHash('sha256');
    hash.update(agent.constructor?.name ?? '');
    hash.update('\0').update(cluster?.server ?? '');
    hash.update('\0').update(cluster?.proxyUrl ?? '');
    const rejectUnauthorized = agent.options.rejectUnauthorized;
    hash.update('\0').update(typeof rejectUnauthorized === 'boolean' ? String(rejectUnauthorized) : '');
    const servername = agent.options.servername;
    hash.update('\0').update(typeof servername === 'string' ? servername : '');
    for (const field of ['ca', 'cert', 'key', 'pfx'] as const) {
      hash.update('\0');
      const value = agent.options[field];
      if (value === undefined || value === null) continue;
      for (const part of Array.isArray(value) ? value : [value]) {
        hash.update(Buffer.isBuffer(part) ? part : String(part));
      }
    }
    const key = hash.digest('hex');
    if (this.agentCache?.key === key) return this.agentCache.agent;
    // New identity: promote the fresh agent to a keep-alive pool. The previous
    // agent (if any) is dropped; its free sockets are unref'd and close on the
    // server's idle timeout, while in-flight watches finish undisturbed.
    (agent as { keepAlive?: boolean }).keepAlive = true;
    agent.options.keepAlive = true;
    // Bound the idle pool: bursts (search-index warmup) shouldn't pin dozens
    // of sockets per cluster until the API server times them out.
    (agent as { maxFreeSockets?: number }).maxFreeSockets = 8;
    this.agentCache = { key, agent };
    return agent;
  }

  private async requestOnce(path: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
    const requestInit = (await this.kc.applyToFetchOptions({})) as RequestInit;
    requestInit.agent = this.pooledAgent(requestInit.agent) as RequestInit['agent'];
    requestInit.method = init?.method ?? 'GET';
    if (init?.body !== undefined) requestInit.body = init.body;
    if (init?.signal) requestInit.signal = init.signal;
    // applyToFetchOptions returns a Headers instance; spreading one yields {}
    // and silently drops Authorization — token/exec clusters then probe as
    // anonymous and fail with 401/403. Copy entries explicitly instead.
    const baseHeaders: Record<string, string> = {};
    const applied = requestInit.headers as unknown;
    if (applied && typeof (applied as Headers).forEach === 'function') {
      (applied as Headers).forEach((value, key) => {
        baseHeaders[key] = value;
      });
    } else if (applied) {
      Object.assign(baseHeaders, applied as Record<string, string>);
    }
    requestInit.headers = { ...baseHeaders, ...init?.headers };
    return fetch(this.serverUrl() + path, requestInit);
  }

  /**
   * Retry one transport failure for a safe GET. A reset keep-alive socket is
   * removed from the Agent's pool by Node, so the retry opens or borrows a
   * usable connection. Mutating requests are never replayed.
   */
  private async safeGet<T>(init: { method?: string; signal?: AbortSignal } | undefined, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' || init?.signal?.aborted || !isRetryableTransportError(err)) throw err;
      return run();
    }
  }

  async request(path: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
    return this.safeGet(init, () => this.requestOnce(path, init));
  }

  /** GET/mutate a JSON API path; throws ApiException on non-2xx. */
  async json<T = unknown>(path: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
    return this.safeGet(init, async () => {
      // Keep the response-body read inside the retry boundary: an API server
      // can reset a pooled connection after sending headers but before the
      // complete JSON list has arrived.
      const res = await this.requestOnce(path, init);
      const text = await res.text();
      if (!res.ok) {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* keep raw text */
        }
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message: unknown }).message)
            : `${res.status} ${res.statusText} for ${path}`;
        throw new ApiException(res.status, message, body, {});
      }
      return (text ? JSON.parse(text) : undefined) as T;
    });
  }

  /**
   * Open a streaming GET (watch) and hand back the response; the caller
   * consumes res.body as an NDJSON stream. Aborts via the provided signal.
   */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const res = await this.request(path, { signal });
    if (!res.ok) {
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      throw new ApiException(res.status, `watch failed: ${res.status} ${res.statusText}`, body, {});
    }
    return res;
  }
}

export function isRetryableTransportError(err: unknown): boolean {
  let current: unknown = err;
  // Fetch implementations sometimes wrap the underlying system error in one
  // or more `cause` objects. Keep this deliberately code-based so certificate,
  // authentication, HTTP, and JSON errors are not mistaken for transients.
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_GET_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Build the REST path for a group/version/plural, optionally namespaced. */
export function resourcePath(group: string, version: string, plural: string, opts?: { namespace?: string; name?: string; subresource?: string; query?: URLSearchParams }): string {
  const base = group === '' ? `/api/${version}` : `/apis/${group}/${version}`;
  let p = base;
  if (opts?.namespace) p += `/namespaces/${encodeURIComponent(opts.namespace)}`;
  p += `/${plural}`;
  if (opts?.name) p += `/${encodeURIComponent(opts.name)}`;
  if (opts?.subresource) p += `/${opts.subresource}`;
  const q = opts?.query?.toString();
  return q ? `${p}?${q}` : p;
}
