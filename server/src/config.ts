import { randomBytes } from 'node:crypto';

/**
 * `token` (default): every API and WebSocket request carries the bearer token.
 * `none`: no Kubus-side auth, for running behind a reverse proxy that already
 * authenticates (container / in-cluster deployments). Host and Origin are
 * still checked against loopback and `allowedOrigins`.
 */
export type AuthMode = 'token' | 'none';

export interface ServerConfig {
  host: string;
  port: number;
  /** Bearer token required on every request; generated fresh per run. */
  token: string;
  /** Disable token auth (dev mode behind the Vite proxy uses a fixed token instead). */
  devToken?: string;
  openBrowser: boolean;
  kubeconfigOverride?: string;
  /** Directory to serve the built client from; defaults to the repo's client/dist. */
  staticRoot?: string;
  /** Use the pino-pretty worker transport (unusable inside a bundled main process). */
  prettyLogs: boolean;
  auth: AuthMode;
  /**
   * Browser origins (scheme://host[:port]) that may reach the server besides
   * loopback, e.g. the public URL of a container deployment behind an ingress.
   */
  allowedOrigins: string[];
  /**
   * Offline mode (air-gapped clusters): features that reach the public
   * internet are refused — the update check, Artifact Hub search and the
   * network-agent install (its images come from ghcr.io). Private Helm
   * repositories and everything that talks to the cluster keep working.
   */
  offline: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    token: overrides.devToken ?? randomBytes(24).toString('base64url'),
    openBrowser: true,
    prettyLogs: process.env.NODE_ENV !== 'production',
    auth: 'token',
    allowedOrigins: [],
    offline: false,
    ...overrides,
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.set(a.slice(2), next);
        i++;
      } else {
        out.set(a.slice(2), 'true');
      }
    }
  }
  return out;
}

function parsePort(raw: string | number): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${raw}" — expected an integer between 1 and 65535`);
  }
  return port;
}

function parseAuth(raw: string | undefined): AuthMode {
  if (raw === undefined || raw === '' || raw === 'token') return 'token';
  if (raw === 'none') return 'none';
  throw new Error(`invalid auth mode "${raw}" — expected "token" or "none"`);
}

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`invalid boolean "${raw}" — expected 1/true or 0/false`);
}

/** Parse a comma-separated origin list, normalizing `https://a.example/` to `https://a.example`. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let u: URL;
      try {
        u = new URL(entry);
      } catch {
        throw new Error(`invalid origin "${entry}" — expected e.g. https://kubus.example.com`);
      }
      const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username && !u.password;
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !bare) {
        throw new Error(`invalid origin "${entry}" — expected scheme://host[:port] without a path`);
      }
      return u.origin;
    });
}

export function loadConfig(): ServerConfig {
  const args = parseArgs(process.argv.slice(2));
  const dev = process.env.NODE_ENV !== 'production' && process.env.KUBUS_DEV === '1';
  // In dev the Vite client can't learn a random token at startup, so use a
  // well-known one; the server still only listens on 127.0.0.1.
  const devToken = dev ? 'dev' : undefined;
  const host = args.get('host') ?? process.env.KUBUS_HOST ?? '127.0.0.1';
  const auth = parseAuth(args.get('auth') ?? process.env.KUBUS_AUTH);
  const allowedOrigins = parseOrigins(args.get('allowed-origins') ?? process.env.KUBUS_ALLOWED_ORIGINS);
  const offline = parseFlag(args.get('offline') ?? process.env.KUBUS_OFFLINE);
  if (dev && !isLoopbackHost(host)) {
    throw new Error('dev mode uses a well-known token and only listens on loopback');
  }
  if (auth === 'none' && !isLoopbackHost(host) && allowedOrigins.length === 0) {
    // Without an origin list only loopback Host headers pass, so a remote
    // deployment would reject every request; fail at startup instead.
    throw new Error('--auth none on a non-loopback --host requires --allowed-origins (or KUBUS_ALLOWED_ORIGINS)');
  }
  return resolveConfig({
    host,
    port: parsePort(args.get('port') ?? process.env.PORT ?? 3001),
    devToken,
    openBrowser: !dev && args.get('no-open') !== 'true' && process.env.KUBUS_NO_OPEN !== '1',
    kubeconfigOverride: args.get('kubeconfig') ?? undefined,
    auth,
    allowedOrigins,
    offline,
  });
}
