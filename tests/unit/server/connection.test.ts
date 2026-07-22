import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeConfig } from '@kubernetes/client-node';
import { applyEnvProxy, envProxyForServer } from '../../../server/src/kube/connection.js';

// isNoProxy is module-private; NO_PROXY handling is covered through envProxyForServer.

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

beforeEach(() => {
  for (const name of PROXY_VARS) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envProxyForServer', () => {
  it('returns undefined when no proxy vars are set', () => {
    expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
  });

  it('picks HTTPS_PROXY for https servers and HTTP_PROXY for http servers', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    vi.stubEnv('HTTP_PROXY', 'http://plain-proxy:3128');
    expect(envProxyForServer('https://api.example.com:6443')).toBe('http://secure-proxy:3128');
    expect(envProxyForServer('http://api.example.com:8080')).toBe('http://plain-proxy:3128');
  });

  it('does not use HTTP_PROXY for https servers', () => {
    vi.stubEnv('HTTP_PROXY', 'http://plain-proxy:3128');
    expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
  });

  it('honors lowercase variants', () => {
    vi.stubEnv('https_proxy', 'socks5://localhost:1080');
    expect(envProxyForServer('https://api.example.com:6443')).toBe('socks5://localhost:1080');
  });

  it('prefers the uppercase variant over the lowercase one', () => {
    expect(
      envProxyForServer('https://api.example.com:6443', {
        HTTPS_PROXY: 'http://upper:3128',
        https_proxy: 'http://lower:3128',
      }),
    ).toBe('http://upper:3128');
  });

  it('falls back to ALL_PROXY for any scheme', () => {
    vi.stubEnv('ALL_PROXY', 'socks5://localhost:1080');
    expect(envProxyForServer('https://api.example.com:6443')).toBe('socks5://localhost:1080');
    expect(envProxyForServer('http://api.example.com:8080')).toBe('socks5://localhost:1080');
  });

  it('lets the scheme-specific proxy win over ALL_PROXY', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    vi.stubEnv('ALL_PROXY', 'socks5://localhost:1080');
    expect(envProxyForServer('https://api.example.com:6443')).toBe('http://secure-proxy:3128');
  });

  it('returns undefined for an unparsable server URL', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    expect(envProxyForServer('not a url')).toBeUndefined();
  });

  describe('NO_PROXY handling', () => {
    beforeEach(() => {
      vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    });

    it('bypasses the proxy on an exact host match', () => {
      vi.stubEnv('NO_PROXY', 'api.example.com');
      expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
      expect(envProxyForServer('https://other.example.org:6443')).toBe('http://secure-proxy:3128');
    });

    it('matches subdomains of a bare domain entry', () => {
      vi.stubEnv('NO_PROXY', 'example.com');
      expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
      expect(envProxyForServer('https://example.com:6443')).toBeUndefined();
      expect(envProxyForServer('https://notexample.com:6443')).toBe('http://secure-proxy:3128');
    });

    it('treats a leading dot as the same domain rule', () => {
      vi.stubEnv('NO_PROXY', '.example.com');
      expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
      expect(envProxyForServer('https://example.com:6443')).toBeUndefined();
    });

    it('bypasses everything on *', () => {
      vi.stubEnv('NO_PROXY', '*');
      expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
    });

    it('parses comma-separated lists with whitespace', () => {
      vi.stubEnv('NO_PROXY', 'internal.corp , 10.0.0.5 ,');
      expect(envProxyForServer('https://10.0.0.5:6443')).toBeUndefined();
      expect(envProxyForServer('https://svc.internal.corp:6443')).toBeUndefined();
      expect(envProxyForServer('https://api.example.com:6443')).toBe('http://secure-proxy:3128');
    });

    it('honors the lowercase no_proxy variant', () => {
      vi.stubEnv('no_proxy', 'api.example.com');
      expect(envProxyForServer('https://api.example.com:6443')).toBeUndefined();
    });
  });
});

describe('applyEnvProxy', () => {
  const kubeConfig = (clusters: Array<{ name: string; server: string; proxyUrl?: string }> | undefined) =>
    ({ clusters }) as unknown as KubeConfig;

  it('injects env proxies onto clusters without one and reports their names', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    const kc = kubeConfig([
      { name: 'plain', server: 'https://api.example.com:6443' },
      { name: 'declared', server: 'https://api.other.com:6443', proxyUrl: 'socks5://existing:1080' },
    ]);
    const fromEnv = applyEnvProxy(kc);
    expect(fromEnv).toEqual(new Set(['plain']));
    expect(kc.clusters[0]?.proxyUrl).toBe('http://secure-proxy:3128');
    expect(kc.clusters[1]?.proxyUrl).toBe('socks5://existing:1080');
  });

  it('leaves NO_PROXY-excluded clusters alone', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:3128');
    vi.stubEnv('NO_PROXY', 'api.example.com');
    const kc = kubeConfig([{ name: 'local', server: 'https://api.example.com:6443' }]);
    expect(applyEnvProxy(kc)).toEqual(new Set());
    expect(kc.clusters[0]?.proxyUrl).toBeUndefined();
  });

  it('does nothing without proxy env vars', () => {
    const kc = kubeConfig([{ name: 'a', server: 'https://api.example.com:6443' }]);
    expect(applyEnvProxy(kc)).toEqual(new Set());
    expect(kc.clusters[0]?.proxyUrl).toBeUndefined();
  });

  it('handles empty or missing cluster lists', () => {
    expect(applyEnvProxy(kubeConfig([]))).toEqual(new Set());
    expect(applyEnvProxy(kubeConfig(undefined))).toEqual(new Set());
  });
});
