import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../server/src/config';
import { hostAllowed, offlineBlocked, originAllowed } from '../../../server/src/request-guard';
import { startServer, type RunningServer } from '../../../server/src/server';

const PUBLIC = { allowedOrigins: ['https://kubus.example.com'] };
const NONE = { allowedOrigins: [] };

describe('originAllowed', () => {
  it('passes requests without an Origin header', () => {
    expect(originAllowed(undefined, NONE)).toBe(true);
  });

  it('accepts loopback pages on any port', () => {
    expect(originAllowed('http://127.0.0.1:3001', NONE)).toBe(true);
    expect(originAllowed('http://localhost:5173', NONE)).toBe(true);
    expect(originAllowed('http://[::1]:3001', NONE)).toBe(true);
  });

  it('accepts only exactly configured public origins', () => {
    expect(originAllowed('https://kubus.example.com', PUBLIC)).toBe(true);
    expect(originAllowed('https://kubus.example.com', NONE)).toBe(false);
    expect(originAllowed('http://kubus.example.com', PUBLIC)).toBe(false);
    expect(originAllowed('https://kubus.example.com:8443', PUBLIC)).toBe(false);
    expect(originAllowed('https://evil.example', PUBLIC)).toBe(false);
    expect(originAllowed('null', PUBLIC)).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('requires a Host header', () => {
    expect(hostAllowed(undefined, PUBLIC)).toBe(false);
  });

  it('accepts loopback and configured hostnames, ignoring the port', () => {
    expect(hostAllowed('127.0.0.1:3001', NONE)).toBe(true);
    expect(hostAllowed('[::1]:3001', NONE)).toBe(true);
    expect(hostAllowed('kubus.example.com', PUBLIC)).toBe(true);
    expect(hostAllowed('kubus.example.com:3001', PUBLIC)).toBe(true);
  });

  it('rejects rebound or unknown hostnames', () => {
    expect(hostAllowed('attacker.example', PUBLIC)).toBe(false);
    expect(hostAllowed('10.0.0.5:3001', PUBLIC)).toBe(false);
    expect(hostAllowed('kubus.example.com.attacker.example', PUBLIC)).toBe(false);
  });
});

describe('offlineBlocked', () => {
  it('blocks Artifact Hub and the network-agent install only', () => {
    expect(offlineBlocked('GET', '/api/helm/hub/search?q=nginx')).toBe(true);
    expect(offlineBlocked('GET', '/api/helm/hub/versions')).toBe(true);
    expect(offlineBlocked('POST', '/api/contexts/prod/network-agent/install')).toBe(true);
    expect(offlineBlocked('GET', '/api/contexts/prod/network-agent')).toBe(false);
    expect(offlineBlocked('DELETE', '/api/contexts/prod/network-agent')).toBe(false);
    expect(offlineBlocked('GET', '/api/helm/repos')).toBe(false);
    expect(offlineBlocked('GET', '/api/contexts/prod/helm/releases')).toBe(false);
  });
});

describe('server with --auth none', () => {
  let server: RunningServer | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = undefined;
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(overrides: Partial<ServerConfig>): Promise<RunningServer> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-guard-'));
    tempDirs.push(root);
    const kubeconfig = path.join(root, 'kubeconfig');
    fs.writeFileSync(kubeconfig, 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n');
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      prettyLogs: false,
      staticRoot: path.join(root, 'missing-client'),
      kubeconfigOverride: kubeconfig,
      ...overrides,
    });
    return server;
  }

  async function get(s: RunningServer, pathname: string, headers: Record<string, string> = {}): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${s.port}${pathname}`, { headers });
    await res.arrayBuffer();
    return res.status;
  }

  /** Raw request so the Host header can be forged (fetch does not allow it). */
  async function rawStatus(s: RunningServer, lines: string[]): Promise<string> {
    const socket = net.createConnection({ host: '127.0.0.1', port: s.port });
    await once(socket, 'connect');
    const connection = lines.some((l) => l.startsWith('Upgrade:')) ? 'Upgrade' : 'close';
    socket.write([...lines, `Connection: ${connection}`, '', ''].join('\r\n'));
    let response = '';
    while (!response.includes('\r\n')) {
      const [chunk] = await once(socket, 'data');
      response += String(chunk);
    }
    socket.destroy();
    return response.split('\r\n')[0] ?? '';
  }

  it('serves the API without a token and drops the token from the launch URL', async () => {
    const s = await boot({ auth: 'none' });
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/`);
    expect(await get(s, '/api/app/info')).toBe(200);
  });

  it('rejects cross-site origins and rebound hosts', async () => {
    const s = await boot({ auth: 'none', allowedOrigins: ['https://kubus.example.com'] });
    expect(await get(s, '/api/app/info', { origin: 'https://evil.example' })).toBe(403);
    expect(await get(s, '/api/app/info', { origin: 'https://kubus.example.com' })).toBe(200);
    expect(await rawStatus(s, ['GET /api/app/info HTTP/1.1', 'Host: attacker.example'])).toContain('403');
    expect(await rawStatus(s, ['GET /api/app/info HTTP/1.1', 'Host: kubus.example.com'])).toContain('200');
  });

  it('opens WebSockets without a token only from allowed origins', async () => {
    const s = await boot({ auth: 'none', allowedOrigins: ['https://kubus.example.com'] });
    const upgrade = (origin: string) => [
      'GET /ws/watch HTTP/1.1',
      'Host: kubus.example.com',
      `Origin: ${origin}`,
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
    ];
    expect(await rawStatus(s, upgrade('https://kubus.example.com'))).toContain('101');
    expect(await rawStatus(s, upgrade('https://evil.example'))).not.toContain('101');
  });

  it('keeps requiring the token in the default mode, even from an allowed origin', async () => {
    const s = await boot({ token: 'secret', allowedOrigins: ['https://kubus.example.com'] });
    expect(await get(s, '/api/app/info', { origin: 'https://kubus.example.com' })).toBe(401);
    expect(await get(s, '/api/app/info', { authorization: 'Bearer secret' })).toBe(200);
  });

  it('offline mode refuses internet features and reports itself', async () => {
    const s = await boot({ auth: 'none', offline: true });
    expect(await get(s, '/api/helm/hub/search?q=nginx')).toBe(403);
    const info = (await (await fetch(`http://127.0.0.1:${s.port}/api/app/info`)).json()) as { offline?: boolean };
    expect(info.offline).toBe(true);
    const update = (await (await fetch(`http://127.0.0.1:${s.port}/api/app/update-check`)).json()) as { reason?: string };
    expect(update.reason).toBe('offline');
    expect(await get(s, '/api/helm/repos')).toBe(200);
  });

  it('online mode leaves the hub route alone', async () => {
    const s = await boot({ auth: 'none' });
    expect(await get(s, '/api/helm/hub/search')).not.toBe(403);
  });

  it('answers the health probe without auth', async () => {
    const s = await boot({ token: 'secret' });
    expect(await get(s, '/healthz')).toBe(200);
  });
});
