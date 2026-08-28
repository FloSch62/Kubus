import crypto from 'node:crypto';
import type { Agent } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import { ApiException, type KubeConfig } from '@kubernetes/client-node';
import { H2UnavailableError, H2WatchTransport, type H2TlsOptions } from './h2-transport.js';

type FetchAgent = Agent & { options: Record<string, unknown> };
export interface RawRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Override the shared request deadline; false is reserved for explicitly unbounded streams. */
  deadlineMs?: number | false;
  /** stream() only: fail with H2UnavailableError instead of falling back to an HTTP/1.1 socket. */
  h2Required?: boolean;
}

/** The subset of a fetch Response that streaming (watch) consumers rely on. */
export interface StreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: NodeJS.ReadableStream | null;
  text(): Promise<string>;
}

/** TLS fields client-node stores on its agents — the material an HTTP/2 dial needs. */
const AGENT_TLS_FIELDS = [
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'rejectUnauthorized',
  'servername',
  'ciphers',
  'honorCipherOrder',
  'ecdhCurve',
  'crl',
  'dhparam',
  'secureOptions',
  'secureProtocol',
  'sessionIdContext',
] as const;

const TRAILING_SLASH_RE = /\/$/;
const RETRYABLE_GET_ERROR_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ENETRESET', 'EPIPE', 'ETIMEDOUT']);
export const KUBE_REQUEST_DEADLINE_MS = 15_000;
export const KUBE_LARGE_RESPONSE_DEADLINE_MS = 60_000;

class RequestDeadlineError extends Error {
  constructor(path: string, deadlineMs = KUBE_REQUEST_DEADLINE_MS) {
    super(`Kubernetes API request timed out after ${deadlineMs / 1000}s: ${path}`);
    this.name = 'RequestDeadlineError';
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/**
 * Authenticated HTTP access to arbitrary API server paths for the things the
 * typed clients can't do generically: discovery, dynamic resource list/get,
 * subresources, and watch streams. Auth (incl. exec-plugin token refresh) is
 * re-applied per request via KubeConfig.applyToHTTPSOptions.
 */
export class RawClient {
  /** Keep-alive agent shared across requests while the TLS/proxy identity is stable. */
  private agentCache?: { key: string; agent: FetchAgent };
  private readonly h2: H2WatchTransport;

  constructor(
    private kc: KubeConfig,
    h2Transport?: H2WatchTransport,
  ) {
    this.h2 = h2Transport ?? new H2WatchTransport();
  }

  /** Close pooled HTTP/2 watch sessions. Call when the cluster handle is torn down. */
  dispose(): void {
    this.h2.close();
  }

  private serverUrl(): string {
    const cluster = this.kc.getCurrentCluster();
    if (!cluster) throw new Error('no active cluster in kubeconfig context');
    return cluster.server.replace(TRAILING_SLASH_RE, '');
  }

  /** Connection identity: everything that affects which server a socket reaches and as whom. */
  private agentIdentityKey(agent: FetchAgent): string {
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
    return hash.digest('hex');
  }

  /**
   * Keep the client-node Agent alive across requests so they do not each pay a
   * full TCP+TLS handshake. The cache key includes everything that affects the
   * connection (server, proxy, TLS material), so exec-plugin cert rotation still
   * gets a fresh pool.
   */
  private pooledAgent(fresh: unknown): unknown {
    const agent = fresh as FetchAgent | undefined;
    if (!agent || typeof agent !== 'object' || !agent.options) return fresh;
    const key = this.agentIdentityKey(agent);
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

  private async authenticatedRequestInit(): Promise<RequestInit> {
    const requestInit: RequestInit = {};
    await this.kc.applyToHTTPSOptions(requestInit as unknown as HttpsRequestOptions);
    return requestInit;
  }

  private async requestOnce(path: string, init?: RawRequestInit): Promise<Response> {
    const requestInit = await this.authenticatedRequestInit();
    requestInit.agent = this.pooledAgent(requestInit.agent) as RequestInit['agent'];
    requestInit.method = init?.method ?? 'GET';
    if (init?.body !== undefined) requestInit.body = init.body;
    if (init?.signal) requestInit.signal = init.signal;
    requestInit.headers = { ...copiedHeaders(requestInit.headers), ...init?.headers };
    return fetch(this.serverUrl() + path, requestInit);
  }

  /**
   * Open a streaming GET over the pooled HTTP/2 transport when the server
   * speaks it, falling back to a dedicated HTTP/1.1 socket. Watches are the
   * connection-hungry path: multiplexing keeps hundreds of them on one or two
   * TCP connections per cluster.
   */
  private async streamOnce(path: string, init?: RawRequestInit): Promise<StreamResponse> {
    const cluster = this.kc.getCurrentCluster();
    if (cluster?.server.startsWith('https')) {
      const requestInit = await this.authenticatedRequestInit();
      const agent = requestInit.agent as FetchAgent | undefined;
      if (agent?.options) {
        const headers = { ...copiedHeaders(requestInit.headers), ...init?.headers };
        try {
          return await this.h2.request(this.agentIdentityKey(agent), this.h2Target(agent), path, headers, init?.signal);
        } catch (err) {
          if (!(err instanceof H2UnavailableError) || init?.h2Required) throw err;
        }
      }
    } else if (init?.h2Required) {
      throw new H2UnavailableError('multiplexed watches need a TLS API server');
    }
    return this.requestOnce(path, init);
  }

  private h2Target(agent: FetchAgent): { serverUrl: string; proxyUrl?: string; tls: H2TlsOptions } {
    const tls: H2TlsOptions = {};
    for (const field of AGENT_TLS_FIELDS) {
      const value = agent.options[field];
      if (value !== undefined) tls[field] = value;
    }
    return { serverUrl: this.serverUrl(), proxyUrl: this.kc.getCurrentCluster()?.proxyUrl, tls };
  }

  /**
   * Whether watches for this cluster multiplex over HTTP/2 — the gate for
   * per-CRD live search indexing. Dials (and pools) a session on first call;
   * an http/1.1-only answer is remembered per connection identity.
   */
  async supportsMultiplexedWatch(): Promise<boolean> {
    const cluster = this.kc.getCurrentCluster();
    if (!cluster?.server.startsWith('https')) return false;
    const requestInit = await this.authenticatedRequestInit();
    const agent = requestInit.agent as FetchAgent | undefined;
    if (!agent?.options) return false;
    return this.h2.probe(this.agentIdentityKey(agent), this.h2Target(agent));
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

  /**
   * Give the supplied operation one deadline, including authentication and a
   * possible safe-GET retry. JSON operations include the response-body read;
   * streaming operations include watch establishment. This prevents a
   * saturated API server from parking requests through successive OS-level
   * TCP timeouts. A caller-provided abort signal remains authoritative.
   */
  private async withDeadline<T>(path: string, init: RawRequestInit | undefined, run: (timedInit: RawRequestInit) => Promise<T>): Promise<T> {
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) throw abortReason(callerSignal);

    const deadlineController = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineController.signal]) : deadlineController.signal;
    const timedInit: RawRequestInit = { ...init, signal };
    const races: Array<Promise<T> | Promise<never>> = [];
    let abortSource: 'caller' | 'deadline' | undefined;
    let removeCallerAbort: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let deadlineError: RequestDeadlineError | undefined;

    if (callerSignal) {
      races.push(
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            abortSource ??= 'caller';
            reject(abortReason(callerSignal));
          };
          callerSignal.addEventListener('abort', onAbort, { once: true });
          removeCallerAbort = () => callerSignal.removeEventListener('abort', onAbort);
        }),
      );
    }

    const deadlineMs = init?.deadlineMs ?? KUBE_REQUEST_DEADLINE_MS;
    if (deadlineMs !== false) {
      deadlineError = new RequestDeadlineError(path, deadlineMs);
      races.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abortSource ??= 'deadline';
            deadlineController.abort(deadlineError);
            reject(deadlineError);
          }, deadlineMs);
          timer.unref();
        }),
      );
    }

    races.unshift(Promise.resolve().then(() => run(timedInit)));

    try {
      return await Promise.race(races);
    } catch (err) {
      if (abortSource === 'deadline' && deadlineError) throw deadlineError;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      removeCallerAbort?.();
    }
  }

  async request(path: string, init?: RawRequestInit): Promise<Response> {
    return this.withDeadline(path, init, (timedInit) => this.safeGet(timedInit, () => this.requestOnce(path, timedInit)));
  }

  /** GET/mutate a JSON API path; throws ApiException on non-2xx. */
  async json<T = unknown>(path: string, init?: RawRequestInit): Promise<T> {
    return this.withDeadline(path, init, (timedInit) => this.safeGet(timedInit, async () => {
      // Keep the response-body read inside the retry boundary: an API server
      // can reset a pooled connection after sending headers but before the
      // complete JSON list has arrived.
      const res = await this.requestOnce(path, timedInit);
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
    }));
  }

  /**
   * Open a streaming GET (watch) and hand back the response; the caller
   * consumes res.body as an NDJSON stream. Aborts via init.signal. Prefers the
   * multiplexed HTTP/2 transport; init.h2Required makes falling back to an
   * HTTP/1.1 socket an error instead (unbounded watch sets must never fan out
   * into per-watch connections).
   */
  async stream(path: string, init?: RawRequestInit): Promise<StreamResponse> {
    const res = await this.withDeadline(path, init, (timedInit) => this.safeGet(timedInit, () => this.streamOnce(path, timedInit)));
    if (!res.ok) {
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : `watch failed: ${res.status} ${res.statusText}`;
      throw new ApiException(res.status, message, body, {});
    }
    return res;
  }
}

/**
 * Authentication may supply a Headers-like object; spreading one yields {}
 * and silently drops Authorization — token/exec clusters then probe as
 * anonymous and fail with 401/403. Copy entries explicitly instead.
 */
function copiedHeaders(applied: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (applied && typeof (applied as Headers).forEach === 'function') {
    (applied as Headers).forEach((value, key) => {
      headers[key] = value;
    });
  } else if (applied) {
    Object.assign(headers, applied as Record<string, string>);
  }
  return headers;
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
