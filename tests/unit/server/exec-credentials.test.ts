/* oxlint-disable typescript/unbound-method -- process methods are asserted as mocks. */
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import type { FastifyBaseLogger } from 'fastify';
import { KubeConfig, type User } from '@kubernetes/client-node';
import { HttpMethod, RequestContext } from '@kubernetes/client-node/dist/gen/http/http.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecCredentialManager, EXEC_AUTH_TIMEOUT_MS } from '../../../server/src/kube/exec-credentials.js';
import { ClusterHandle, ClusterManager } from '../../../server/src/kube/cluster-manager.js';
import { describeProbeFailure } from '../../../server/src/kube/auth-diagnostics.js';
import { RawClient } from '../../../server/src/kube/raw-client.js';

vi.mock('../../../server/node_modules/node-fetch/src/index.js', () => ({
  default: vi.fn(async () => new Response(JSON.stringify({ gitVersion: 'v1.test', items: [] }))),
}));

class Helper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 99_999_999;
  readonly kill = vi.fn();
  closed = false;

  finish(status: Record<string, unknown> = { token: 'fresh' }, code = 0, apiVersion = 'client.authentication.k8s.io/v1beta1'): void {
    this.close(JSON.stringify({ apiVersion, kind: 'ExecCredential', status }), code);
  }

  close(stdout = '', code = 1): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end(stdout);
    this.stderr.end();
    this.emit('close', code);
  }
}

const children: Helper[] = [];
const managers: ExecCredentialManager[] = [];
const clusters: ClusterManager[] = [];
const dirs: string[] = [];

function config(options: { context?: string; server?: string; exec?: Record<string, unknown>; user?: User } = {}): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'cluster', server: options.server ?? 'https://cluster.test', skipTLSVerify: true }],
    users: [options.user ?? { name: 'user', exec: {
      command: '/fake/cloud-cli', args: ['get-token', '--profile', 'a'],
      apiVersion: 'client.authentication.k8s.io/v1beta1', interactiveMode: 'IfAvailable', ...options.exec,
    } }],
    contexts: [{ name: options.context ?? 'ctx', user: 'user', cluster: 'cluster' }], currentContext: options.context ?? 'ctx',
  });
  return kc;
}

function manager(): ExecCredentialManager {
  const value = new ExecCredentialManager();
  managers.push(value);
  return value;
}

async function authenticate(kc: KubeConfig): Promise<RequestOptions> {
  const options: RequestOptions = {};
  await kc.applyToHTTPSOptions(options);
  return options;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const expires = () => ({ token: 'short-lived', expirationTimestamp: new Date(Date.now() + 1000).toISOString() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
    const child = new Helper();
    children.push(child);
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
});

afterEach(async () => {
  for (const cluster of clusters.splice(0)) cluster.dispose();
  for (const value of managers.splice(0)) value.dispose();
  for (const child of children.splice(0)) child.close();
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared exec credentials', () => {
  it('runs one helper for 100 concurrent requests across HTTPS and typed-client authentication, including expiry', async () => {
    const credentials = manager();
    const kc = config();
    const probe = config();
    credentials.attach(kc);
    credentials.attach(probe);
    const typed = new RequestContext('https://cluster.test/api/v1/pods', HttpMethod.GET);
    const first = Promise.all([kc.applySecurityAuthentication(typed), ...Array.from({ length: 99 }, () => authenticate(probe))]);
    await flush();
    expect(children).toHaveLength(1);
    children[0]!.finish(expires());
    await first;
    expect(typed.getHeaders().Authorization).toBe('Bearer short-lived');
    expect((await authenticate(kc)).headers).toMatchObject({ Authorization: 'Bearer short-lived' });
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1001);
    const refreshed = Promise.all(Array.from({ length: 100 }, (_, i) => authenticate(i % 2 ? kc : probe)));
    await flush();
    expect(children).toHaveLength(2);
    children[1]!.finish({ token: 'renewed' });
    expect((await refreshed).every((o) => (o.headers as Record<string, string>).Authorization === 'Bearer renewed')).toBe(true);
  });

  it('keeps failed refreshes paused across retries and new config clones until explicitly retried', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const first = Promise.allSettled(Array.from({ length: 100 }, () => authenticate(kc)));
    await flush();
    children[0]!.stderr.write('cloud session expired');
    children[0]!.close();
    const results = await first;
    expect(results.every((r) => r.status === 'rejected' && r.reason.reason === 'AuthenticationRequired')).toBe(true);
    const error = (results[0] as PromiseRejectedResult).reason;
    expect(await describeProbeFailure(error, kc.getCurrentUser())).toContain('Reconnect or Test connection');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const clone = config();
    credentials.attach(clone);
    await expect(authenticate(clone)).rejects.toBe(error);
    expect(children).toHaveLength(1);

    credentials.retry('ctx');
    const retried = authenticate(clone);
    await flush();
    children[1]!.finish();
    await expect(retried).resolves.toMatchObject({ headers: { Authorization: 'Bearer fresh' } });
  });

  it('shares aliases but separates profiles, effective environments and cluster-specific plugin input', async () => {
    const credentials = manager();
    const configs = [
      config(), config({ context: 'alias' }),
      config({ exec: { args: ['get-token', '--profile', 'b'] } }),
      config({ exec: { env: [{ name: 'CLOUD_PROFILE', value: 'another' }] } }),
      config({ exec: { provideClusterInfo: true } }),
      config({ exec: { provideClusterInfo: true }, server: 'https://other.test' }),
    ];
    configs.forEach((kc) => credentials.attach(kc));
    const pending = Promise.all(configs.map(authenticate));
    await flush();
    expect(children).toHaveLength(5);
    children.forEach((child, i) => child.finish({ token: `identity-${i}` }));
    const results = await pending;
    expect(results.map((r) => (r.headers as Record<string, string>).Authorization)).toEqual([
      'Bearer identity-0', 'Bearer identity-0', 'Bearer identity-1', 'Bearer identity-2', 'Bearer identity-3', 'Bearer identity-4',
    ]);
    const calls = vi.mocked(childProcess.spawn).mock.calls;
    const env = (calls[4]![2] as { env: NodeJS.ProcessEnv }).env;
    expect(JSON.parse(env.KUBERNETES_EXEC_INFO!)).toMatchObject({ spec: { interactive: false, cluster: { server: 'https://other.test' } } });
  });

  it('leaves a refresh shared when a resource deadline expires or a caller cancels', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const raw = new RawClient(kc);
    const aborted = new AbortController();
    const first = raw.json('/version', { deadlineMs: 10 });
    const cancelled = raw.json('/version', { signal: aborted.signal });
    const settled = Promise.allSettled([first, cancelled]);
    await flush();
    aborted.abort();
    await vi.advanceTimersByTimeAsync(11);
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    credentials.retry('ctx');
    const next = raw.json('/version');
    await flush();
    expect(children).toHaveLength(1);
    expect(process.kill).not.toHaveBeenCalled();
    children[0]!.finish();
    await expect(next).resolves.toMatchObject({ gitVersion: 'v1.test' });
    raw.dispose();
  });

  it('terminates a timed-out helper and holds the attempt until process close before allowing an explicit retry', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const first = Promise.allSettled([authenticate(kc)]);
    await flush();
    await vi.advanceTimersByTimeAsync(EXEC_AUTH_TIMEOUT_MS);
    if (process.platform !== 'win32') expect(process.kill).toHaveBeenCalledWith(-children[0]!.pid, 'SIGKILL');
    credentials.retry('ctx');
    const second = Promise.allSettled([authenticate(kc)]);
    await flush();
    expect(vi.mocked(childProcess.spawn).mock.calls.filter(([command]) => command === '/fake/cloud-cli')).toHaveLength(1);
    children[0]!.close();
    expect((await first)[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('timed out') } });
    await second;
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'AuthenticationRequired' });
    credentials.retry('ctx');
    const retry = authenticate(kc);
    await flush();
    children.at(-1)!.finish();
    await expect(retry).resolves.toBeDefined();
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['missing credentials', JSON.stringify({ kind: 'ExecCredential', apiVersion: 'client.authentication.k8s.io/v1beta1', status: {} })],
    ['expired credentials', JSON.stringify({ kind: 'ExecCredential', apiVersion: 'client.authentication.k8s.io/v1beta1', status: { token: 'old', expirationTimestamp: '2000-01-01T00:00:00Z' } })],
  ])('pauses after %s instead of repeatedly executing the helper', async (_name, output) => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const pending = Promise.allSettled([authenticate(kc)]);
    await flush();
    children[0]!.close(output, 0);
    expect((await pending)[0]).toMatchObject({ status: 'rejected', reason: { reason: 'AuthenticationRequired' } });
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'AuthenticationRequired' });
    expect(children).toHaveLength(1);
  });

  it('caches certificate credentials and handles legacy nested exec entries', async () => {
    const credentials = manager();
    const kc = config({ user: { name: 'user', authProvider: { name: 'exec', config: { exec: { command: '/fake/cloud-cli', apiVersion: 'client.authentication.k8s.io/v1' } } } } });
    credentials.attach(kc);
    const pending = authenticate(kc);
    await flush();
    children[0]!.finish({ clientCertificateData: 'certificate', clientKeyData: 'key' }, 0, 'client.authentication.k8s.io/v1');
    expect(await pending).toMatchObject({ cert: 'certificate', key: 'key' });
    await authenticate(kc);
    expect(children).toHaveLength(1);
  });

  it('pauses synchronous spawn errors and invalid helper configurations', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => { throw new Error('spawn failed'); });
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'AuthenticationRequired' });
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'AuthenticationRequired' });
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const missingCommand = config({ exec: { command: undefined } });
    credentials.attach(missingCommand);
    await expect(authenticate(missingCommand)).rejects.toThrow('no credential command');
    const needsTerminal = config({ exec: { interactiveMode: 'Always' } });
    credentials.attach(needsTerminal);
    await expect(authenticate(needsTerminal)).rejects.toThrow('requires a terminal');
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds helper output and keeps failures paused after terminating it', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const pending = Promise.allSettled([authenticate(kc)]);
    await flush();
    children[0]!.stdout.write('x'.repeat(1024 * 1024 + 1));
    if (process.platform !== 'win32') expect(process.kill).toHaveBeenCalled();
    children[0]!.close();
    expect((await pending)[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('output exceeded') } });
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'AuthenticationRequired' });
  });

  it('cancels outstanding authentication on shutdown and refuses later attachments', async () => {
    const credentials = manager();
    const kc = config();
    credentials.attach(kc);
    const pending = Promise.allSettled([authenticate(kc)]);
    await flush();
    credentials.dispose();
    children[0]!.close();
    expect((await pending)[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('cancelled') } });
    expect(() => credentials.attach(config())).toThrow('session is closed');
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'NotConnected' });
  });

  it('does not change static authentication or kubeconfig exports', async () => {
    const credentials = manager();
    const kc = config({ user: { name: 'user', token: 'static' } });
    const original = kc.exportConfig();
    credentials.attach(kc);
    expect(await authenticate(kc)).toMatchObject({ headers: { Authorization: 'Bearer static' } });
    const exec = config();
    const originalExec = exec.exportConfig();
    credentials.attach(exec);
    expect(exec.exportConfig()).toBe(originalExec);
    expect(kc.exportConfig()).toBe(original);
    expect(children).toHaveLength(0);
  });

  it('retires removed sessions and prevents disposed clients from launching helpers', async () => {
    const credentials = manager();
    const kc = config();
    const release = credentials.attach(kc);
    const pending = Promise.allSettled([authenticate(kc)]);
    await flush();
    credentials.retainContexts(new Set());
    children[0]!.close();
    await pending;
    release();
    await expect(authenticate(kc)).rejects.toMatchObject({ reason: 'NotConnected' });
    expect(children).toHaveLength(1);
  });
});

it('shares background probes with live handles, preserves failure on reload, and recovers through Test connection and Reconnect', async () => {
  vi.spyOn(ClusterHandle.prototype, 'activate').mockImplementation(() => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-exec-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, config().exportConfig());
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
  const cluster = new ClusterManager(log, file);
  clusters.push(cluster);
  const connected = cluster.connect('ctx');
  await flush();
  expect(children).toHaveLength(1);
  children[0]!.finish(expires());
  const handle = await connected;
  await vi.advanceTimersByTimeAsync(1001);
  const failed = Promise.allSettled(Array.from({ length: 100 }, () => handle.raw.json('/version')));
  await flush();
  children[1]!.close();
  await failed;
  cluster.reload();
  await flush();
  expect(children).toHaveLength(2);
  const test = cluster.test('ctx');
  await flush();
  children[2]!.finish(expires());
  expect(await test).toMatchObject({ health: 'connected' });
  await expect(handle.raw.json('/version')).resolves.toMatchObject({ gitVersion: 'v1.test' });
  await vi.advanceTimersByTimeAsync(1001);
  const failedAgain = Promise.allSettled([handle.raw.json('/version')]);
  await flush();
  children[3]!.close();
  await failedAgain;
  const reconnect = cluster.reconnect('ctx');
  await flush();
  children[4]!.finish();
  expect((await reconnect).health).toBe('connected');
  expect(children).toHaveLength(5);
  await expect(handle.raw.json('/version')).rejects.toMatchObject({ reason: 'NotConnected' });
});
