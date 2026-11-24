import { isLoopbackHost, type ServerConfig } from './config.js';

/**
 * A browser Origin may reach the server when it is a loopback page or one of
 * the configured public origins. Requests without an Origin header (CLI tools,
 * same-origin GETs) carry no cross-site risk and pass.
 */
export function originAllowed(origin: string | undefined, config: Pick<ServerConfig, 'allowedOrigins'>): boolean {
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return isLoopbackHost(u.hostname) || config.allowedOrigins.includes(u.origin);
}

/**
 * The Host header must name loopback or a configured public origin. Without a
 * token this is the DNS-rebinding defense: a rebound page sends its own
 * hostname as Host. Ports are ignored so a proxy that rewrites them still works.
 */
export function hostAllowed(host: string | undefined, config: Pick<ServerConfig, 'allowedOrigins'>): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHost(hostname)) return true;
  return config.allowedOrigins.some((origin) => new URL(origin).hostname === hostname);
}

/**
 * Routes that need the public internet. In offline mode they answer 403
 * instead of hanging until a timeout in an air-gapped cluster.
 */
export function offlineBlocked(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (path.startsWith('/api/helm/hub/')) return true; // Artifact Hub
  return method === 'POST' && /^\/api\/contexts\/[^/]+\/network-agent\/install$/.test(path); // images from ghcr.io
}
