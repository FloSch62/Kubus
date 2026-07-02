import type { KubeConfig } from '@kubernetes/client-node';

/**
 * Standard proxy env vars are honored by kubectl-adjacent tooling but NOT by
 * @kubernetes/client-node (it only reads `proxy-url` from the kubeconfig). We
 * bridge that gap: for clusters that don't already declare a proxy, resolve one
 * from the environment so users behind a SOCKS/HTTP proxy get zero-config
 * connectivity. `proxy-url` in the kubeconfig always wins.
 */

function isNoProxy(host: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!raw) return false;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === '*') return true;
    const pattern = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

/** Resolve a proxy URL for a server URL from env vars, honoring NO_PROXY. */
export function envProxyForServer(server: string): string | undefined {
  let host: string;
  try {
    host = new URL(server).hostname;
  } catch {
    return undefined;
  }
  if (isNoProxy(host)) return undefined;
  const env = process.env;
  const pick = (name: string) => env[name] || env[name.toLowerCase()] || undefined;
  // Scheme-specific var first, then ALL_PROXY which applies to any scheme.
  const schemeProxy = server.startsWith('https') ? pick('HTTPS_PROXY') : pick('HTTP_PROXY');
  return schemeProxy ?? pick('ALL_PROXY');
}

/**
 * Inject env-derived proxies onto clusters lacking an explicit `proxy-url`.
 * Mutates `kc.clusters` in place; the new field is preserved by exportConfig()
 * so per-context handle clones inherit it. Returns the set of cluster names that
 * received an env proxy (so the UI can distinguish env vs kubeconfig proxies).
 */
export function applyEnvProxy(kc: KubeConfig): Set<string> {
  const fromEnv = new Set<string>();
  if (!kc.clusters?.length) return fromEnv;
  kc.clusters = kc.clusters.map((c) => {
    if (c.proxyUrl) return c;
    const proxyUrl = envProxyForServer(c.server);
    if (!proxyUrl) return c;
    fromEnv.add(c.name);
    return { ...c, proxyUrl };
  });
  return fromEnv;
}

function proxyUrlWithProxySideDns(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return proxyUrl;
  // kubectl/client-go sends SOCKS5 hostnames to the proxy. socks-proxy-agent
  // needs the "h" variant to avoid resolving API-server-only names locally.
  return proxyUrl.replace(/^socks5?:\/\//i, 'socks5h://');
}

/**
 * Apply kubectl-like SOCKS5 DNS semantics to a runtime KubeConfig copy.
 *
 * Do this only on per-request/per-context clones, not on the manager's root
 * config, so list/edit flows still show and persist the kubeconfig as written.
 */
export function applyProxyRuntimeCompatibility(kc: KubeConfig): void {
  if (!kc.clusters?.length) return;
  kc.clusters = kc.clusters.map((c) => {
    const proxyUrl = proxyUrlWithProxySideDns(c.proxyUrl);
    return proxyUrl === c.proxyUrl ? c : { ...c, proxyUrl };
  });
}

/**
 * Point a cluster at a Kubus-managed SSH tunnel's SOCKS endpoint. Runtime-only
 * (applied to per-context clones): the managed tunnel wins over any proxy-url
 * in the file or the environment, and nothing is persisted.
 */
export function overrideClusterProxyUrl(kc: KubeConfig, clusterName: string, proxyUrl: string): void {
  if (!kc.clusters?.length) return;
  kc.clusters = kc.clusters.map((c) => (c.name === clusterName ? { ...c, proxyUrl } : c));
}
