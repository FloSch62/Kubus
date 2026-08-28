import http, { STATUS_CODES } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { SocksClient } from 'socks';

const DIAL_TIMEOUT_MS = 15_000;
/**
 * Self-imposed ceiling under kube-apiserver's default 250-stream limit so a
 * session never sits exactly at the peer's cap; the pool opens a second
 * connection instead of risking refused streams.
 */
const MAX_STREAMS_PER_SESSION = 240;
const SESSION_CHURN_LIMIT = 3;

/**
 * The API server (or the path to it) cannot carry multiplexed HTTP/2 watches:
 * ALPN negotiated http/1.1, the server is plain http, or the proxy scheme is
 * unsupported. Callers fall back to HTTP/1.1 or bounded scans — never retry.
 */
export class H2UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'H2UnavailableError';
  }
}

/** TLS material lifted from the kube client's agent options. */
export type H2TlsOptions = Record<string, unknown>;

export interface H2DialTarget {
  serverUrl: string;
  proxyUrl?: string;
  tls: H2TlsOptions;
}

/** The subset of a fetch Response that watch consumers use. */
export interface H2StreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: NodeJS.ReadableStream;
  text(): Promise<string>;
}

interface TrackedSession {
  key: string;
  session: ClientHttp2Session;
  active: number;
  draining: boolean;
}

export type H2Dialer = (target: H2DialTarget, timeoutMs: number) => Promise<tls.TLSSocket>;

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function isSessionLevelError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === 'ERR_HTTP2_GOAWAY_SESSION' || code === 'ERR_HTTP2_INVALID_SESSION' || code === 'ERR_HTTP2_SESSION_ERROR') return true;
  // REFUSED_STREAM means the server did not process the request — safe to replay.
  return code === 'ERR_HTTP2_STREAM_ERROR' && String((err as Error).message).includes('NGHTTP2_REFUSED_STREAM');
}

function sessionCapacity(tracked: TrackedSession): number {
  const remote = tracked.session.remoteSettings?.maxConcurrentStreams;
  return Math.min(typeof remote === 'number' && remote > 0 ? remote : MAX_STREAMS_PER_SESSION, MAX_STREAMS_PER_SESSION);
}

function usable(tracked: TrackedSession): boolean {
  return !tracked.draining && !tracked.session.closed && !tracked.session.destroyed && tracked.active < sessionCapacity(tracked);
}

async function socksSocket(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.hostname,
      port: Number(proxy.port || 1080),
      type: proxy.protocol.startsWith('socks4') ? 4 : 5,
      userId: proxy.username ? decodeURIComponent(proxy.username) : undefined,
      password: proxy.password ? decodeURIComponent(proxy.password) : undefined,
    },
    command: 'connect',
    // Always hand the hostname to the proxy (kubectl semantics): API-server
    // names often only resolve on the far side of the tunnel.
    destination: { host, port },
    timeout: timeoutMs,
  });
  return socket;
}

async function httpConnectSocket(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (proxy.username) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${host}:${port}`, headers });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs / 1000}s`)));
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Establish the TLS connection for an HTTP/2 session, dialing through the
 * cluster's SOCKS or HTTP proxy when one is configured. ALPN offers both h2
 * and http/1.1 so a single dial gives a definitive multiplexing answer.
 */
export const dialTls: H2Dialer = async (target, timeoutMs) => {
  const url = new URL(target.serverUrl);
  if (url.protocol !== 'https:') throw new H2UnavailableError(`multiplexed watches need a TLS API server, got ${url.protocol}`);
  const host = url.hostname;
  const port = Number(url.port || 443);

  let proxied: net.Socket | undefined;
  if (target.proxyUrl) {
    const proxy = new URL(target.proxyUrl);
    if (proxy.protocol.startsWith('socks')) {
      proxied = await socksSocket(proxy, host, port, timeoutMs);
    } else if (proxy.protocol === 'http:') {
      proxied = await httpConnectSocket(proxy, host, port, timeoutMs);
    } else {
      throw new H2UnavailableError(`multiplexed watches not supported through ${proxy.protocol} proxies`);
    }
  }

  return new Promise((resolve, reject) => {
    const { servername, ...material } = target.tls;
    const socket = tls.connect(
      {
        ...material,
        host,
        port,
        socket: proxied,
        servername: typeof servername === 'string' && servername ? servername : net.isIP(host) ? undefined : host,
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
    );
    const timer = setTimeout(() => socket.destroy(new Error(`TLS connect timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    socket.once('error', (err) => {
      clearTimeout(timer);
      proxied?.destroy();
      reject(err);
    });
  });
};

/**
 * Pool of HTTP/2 sessions carrying watch streams. Hundreds of concurrent
 * watches multiplex over one or two TCP connections per cluster instead of one
 * socket each — the connection-exhaustion fix that lets every CRD stay live.
 *
 * Sessions are keyed by the caller-supplied identity (server + proxy + TLS
 * material) so credential rotation drains old connections gracefully. A server
 * that negotiates http/1.1 is remembered per identity and reported through
 * H2UnavailableError so callers can fall back without re-dialing every time.
 */
export class H2WatchTransport {
  private sessions: TrackedSession[] = [];
  private pendingDial?: Promise<void>;
  private h1OnlyKey?: string;
  private closed = false;

  constructor(private dial: H2Dialer = dialTls) {}

  /** Definitive multiplexing answer for this identity, dialing if needed. */
  async probe(key: string, target: H2DialTarget): Promise<boolean> {
    if (this.closed) return false;
    if (this.h1OnlyKey === key) return false;
    if (this.sessions.some((s) => s.key === key && !s.session.closed && !s.session.destroyed)) return true;
    try {
      await this.dialShared(key, target);
      return true;
    } catch (err) {
      if (err instanceof H2UnavailableError) return false;
      throw err;
    }
  }

  async request(key: string, target: H2DialTarget, path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<H2StreamResponse> {
    if (signal?.aborted) throw abortError(signal);
    // http2 :path carries only what we send — an API server behind a path
    // prefix (https://gateway.example/kubernetes) needs it prepended, matching
    // how the HTTP/1.1 client concatenates serverUrl + path.
    const basePath = new URL(target.serverUrl).pathname.replace(/\/+$/, '');
    const fullPath = basePath ? basePath + path : path;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tracked = await this.getSession(key, target);
      try {
        return await this.openStream(tracked, fullPath, headers, signal);
      } catch (err) {
        if (signal?.aborted || !isSessionLevelError(err)) throw err;
        // The session died between pick and request (GOAWAY, refused stream):
        // drop it and replay once on a fresh connection.
        this.drop(tracked);
        tracked.session.destroy();
        lastErr = err;
      }
    }
    throw lastErr;
  }

  close(): void {
    this.closed = true;
    for (const tracked of this.sessions) tracked.session.destroy();
    this.sessions = [];
  }

  private async getSession(key: string, target: H2DialTarget): Promise<TrackedSession> {
    for (let attempt = 0; attempt < SESSION_CHURN_LIMIT; attempt++) {
      if (this.closed) throw new H2UnavailableError('watch transport closed');
      if (this.h1OnlyKey === key) throw new H2UnavailableError('API server negotiated http/1.1 — multiplexed watches unavailable');
      const existing = this.sessions.find((s) => s.key === key && usable(s));
      if (existing) return existing;
      // Old-identity sessions after a credential rotation: stop routing new
      // streams onto them and let in-flight watches finish naturally.
      for (const stale of this.sessions) {
        if (stale.key !== key && !stale.draining) {
          stale.draining = true;
          stale.session.close();
        }
      }
      await this.dialShared(key, target);
    }
    throw new H2UnavailableError('HTTP/2 sessions kept closing before a watch could start');
  }

  /** One dial at a time: a 300-watch warmup must share connections, not race 300 dials. */
  private dialShared(key: string, target: H2DialTarget): Promise<void> {
    this.pendingDial ??= this.dialSession(key, target).finally(() => {
      this.pendingDial = undefined;
    });
    return this.pendingDial;
  }

  private async dialSession(key: string, target: H2DialTarget): Promise<void> {
    const socket = await this.dial(target, DIAL_TIMEOUT_MS);
    if (socket.alpnProtocol !== 'h2') {
      socket.destroy();
      this.h1OnlyKey = key;
      throw new H2UnavailableError(`API server negotiated ${socket.alpnProtocol || 'no ALPN protocol'} — multiplexed watches unavailable`);
    }
    if (this.closed) {
      socket.destroy();
      throw new H2UnavailableError('watch transport closed');
    }
    this.h1OnlyKey = undefined;
    const session = http2.connect(target.serverUrl, { createConnection: () => socket });
    // Long-lived watch sockets must not pin the process open on shutdown.
    session.unref?.();
    const tracked: TrackedSession = { key, session, active: 0, draining: false };
    session.on('error', () => this.drop(tracked));
    session.on('close', () => this.drop(tracked));
    session.on('goaway', () => {
      tracked.draining = true;
    });
    this.sessions.push(tracked);
  }

  private drop(tracked: TrackedSession): void {
    this.sessions = this.sessions.filter((s) => s !== tracked);
  }

  private openStream(tracked: TrackedSession, path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<H2StreamResponse> {
    // The signal may have fired while authentication or the session dial was
    // pending; abort events do not replay to late listeners, so opening the
    // stream now would leak it until the server-side watch timeout.
    if (signal?.aborted) throw abortError(signal);
    const stream = tracked.session.request({ ':method': 'GET', ':path': path, ...headers }, { endStream: true });
    tracked.active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        tracked.active -= 1;
      }
    };
    const onAbort = () => stream.destroy(abortError(signal!) as Error);
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('close', () => {
      release();
      signal?.removeEventListener('abort', onAbort);
    });

    return new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('response', (responseHeaders) => {
        const status = Number(responseHeaders[':status'] ?? 0);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: STATUS_CODES[status] ?? '',
          body: stream as ClientHttp2Stream & NodeJS.ReadableStream,
          text: () => collectText(stream),
        });
      });
    });
  }
}

async function collectText(stream: ClientHttp2Stream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
