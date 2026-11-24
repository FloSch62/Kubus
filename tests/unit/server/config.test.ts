import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveConfig } from '../../../server/src/config.js';

// parseArgs is module-private; its behavior is exercised through loadConfig.

const originalArgv = process.argv;

function setArgv(...args: string[]): void {
  process.argv = ['/usr/bin/node', '/usr/bin/kubus', ...args];
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('KUBUS_DEV', undefined);
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('KUBUS_NO_OPEN', undefined);
  setArgv();
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

describe('resolveConfig', () => {
  it('produces localhost defaults with a fresh random token', () => {
    const config = resolveConfig();
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3001);
    expect(config.openBrowser).toBe(true);
    // 24 random bytes → 32 chars of base64url.
    expect(config.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(resolveConfig().token).not.toBe(config.token);
  });

  it('uses the dev token verbatim when provided', () => {
    const config = resolveConfig({ devToken: 'dev' });
    expect(config.token).toBe('dev');
    expect(config.devToken).toBe('dev');
  });

  it('lets explicit overrides win over defaults', () => {
    const config = resolveConfig({
      host: '0.0.0.0',
      port: 8443,
      openBrowser: false,
      kubeconfigOverride: '/tmp/kc',
      staticRoot: '/srv/client',
      token: 'fixed',
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 8443,
      openBrowser: false,
      kubeconfigOverride: '/tmp/kc',
      staticRoot: '/srv/client',
      token: 'fixed',
    });
  });

  it('enables pretty logs outside production only', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(resolveConfig().prettyLogs).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(resolveConfig().prettyLogs).toBe(false);
  });
});

describe('loadConfig', () => {
  it('defaults to port 3001 with the browser opening', () => {
    const config = loadConfig();
    expect(config.port).toBe(3001);
    expect(config.openBrowser).toBe(true);
    expect(config.devToken).toBeUndefined();
    expect(config.kubeconfigOverride).toBeUndefined();
    expect(config.token).not.toBe('dev');
  });

  it('reads --port in = form', () => {
    setArgv('--port=8080');
    expect(loadConfig().port).toBe(8080);
  });

  it('reads --port in space-separated form', () => {
    setArgv('--port', '8080');
    expect(loadConfig().port).toBe(8080);
  });

  it('falls back to the PORT env var, with the flag winning', () => {
    vi.stubEnv('PORT', '4567');
    expect(loadConfig().port).toBe(4567);
    setArgv('--port=9999');
    expect(loadConfig().port).toBe(9999);
  });

  it('treats a bare --no-open flag as true', () => {
    setArgv('--no-open');
    expect(loadConfig().openBrowser).toBe(false);
  });

  it('honors KUBUS_NO_OPEN=1', () => {
    vi.stubEnv('KUBUS_NO_OPEN', '1');
    expect(loadConfig().openBrowser).toBe(false);
  });

  it('reads --kubeconfig in both flag forms', () => {
    setArgv('--kubeconfig', '/home/me/.kube/other');
    expect(loadConfig().kubeconfigOverride).toBe('/home/me/.kube/other');
    setArgv('--kubeconfig=/home/me/.kube/other');
    expect(loadConfig().kubeconfigOverride).toBe('/home/me/.kube/other');
  });

  it('parses a valueless flag followed by another flag', () => {
    setArgv('--no-open', '--kubeconfig', '/tmp/kc', '--port=7000');
    const config = loadConfig();
    expect(config.openBrowser).toBe(false);
    expect(config.kubeconfigOverride).toBe('/tmp/kc');
    expect(config.port).toBe(7000);
  });

  it('ignores positional arguments', () => {
    setArgv('serve', '--port=7001');
    expect(loadConfig().port).toBe(7001);
  });

  it('rejects non-numeric and out-of-range ports with a clear error', () => {
    setArgv('--port', 'abc');
    expect(() => loadConfig()).toThrow(/invalid port "abc"/);

    // A valueless --port swallows no following flag and must not become NaN.
    setArgv('--port', '--no-open');
    expect(() => loadConfig()).toThrow(/invalid port/);

    setArgv('--port=0');
    expect(() => loadConfig()).toThrow(/invalid port/);
    setArgv('--port=65536');
    expect(() => loadConfig()).toThrow(/invalid port/);
    setArgv('--port=80.5');
    expect(() => loadConfig()).toThrow(/invalid port/);

    vi.stubEnv('PORT', 'nope');
    setArgv();
    expect(() => loadConfig()).toThrow(/invalid port "nope"/);
  });

  it('uses the well-known dev token only when KUBUS_DEV=1 outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KUBUS_DEV', '1');
    const dev = loadConfig();
    expect(dev.devToken).toBe('dev');
    expect(dev.token).toBe('dev');
    expect(dev.openBrowser).toBe(false);

    vi.stubEnv('NODE_ENV', 'production');
    const prod = loadConfig();
    expect(prod.devToken).toBeUndefined();
    expect(prod.openBrowser).toBe(true);
  });
});

describe('server-mode options', () => {
  beforeEach(() => {
    vi.stubEnv('KUBUS_HOST', undefined);
    vi.stubEnv('KUBUS_AUTH', undefined);
    vi.stubEnv('KUBUS_ALLOWED_ORIGINS', undefined);
  });

  it('defaults to loopback, token auth and no extra origins', () => {
    const config = loadConfig();
    expect(config.host).toBe('127.0.0.1');
    expect(config.auth).toBe('token');
    expect(config.allowedOrigins).toEqual([]);
  });

  it('reads --host and KUBUS_HOST, with the flag winning', () => {
    vi.stubEnv('KUBUS_HOST', '0.0.0.0');
    expect(loadConfig().host).toBe('0.0.0.0');
    setArgv('--host', '::');
    expect(loadConfig().host).toBe('::');
  });

  it('normalizes allowed origins and rejects paths or bad schemes', () => {
    setArgv('--allowed-origins', 'https://kubus.example.com/, http://kubus.lan:8080');
    expect(loadConfig().allowedOrigins).toEqual(['https://kubus.example.com', 'http://kubus.lan:8080']);
    setArgv('--allowed-origins', 'https://kubus.example.com/app');
    expect(() => loadConfig()).toThrow(/without a path/);
    setArgv('--allowed-origins', 'ftp://kubus.example.com');
    expect(() => loadConfig()).toThrow(/invalid origin/);
    setArgv('--allowed-origins', 'kubus.example.com');
    expect(() => loadConfig()).toThrow(/invalid origin/);
  });

  it('accepts --auth none on loopback and rejects unknown modes', () => {
    vi.stubEnv('KUBUS_AUTH', 'none');
    expect(loadConfig().auth).toBe('none');
    setArgv('--auth', 'basic');
    expect(() => loadConfig()).toThrow(/invalid auth mode "basic"/);
  });

  it('refuses --auth none on a public host without allowed origins', () => {
    setArgv('--host', '0.0.0.0', '--auth', 'none');
    expect(() => loadConfig()).toThrow(/requires --allowed-origins/);
    setArgv('--host', '0.0.0.0', '--auth', 'none', '--allowed-origins', 'https://kubus.example.com');
    expect(loadConfig().auth).toBe('none');
  });

  it('keeps dev mode on loopback', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KUBUS_DEV', '1');
    setArgv('--host', '0.0.0.0');
    expect(() => loadConfig()).toThrow(/loopback/);
  });
});
