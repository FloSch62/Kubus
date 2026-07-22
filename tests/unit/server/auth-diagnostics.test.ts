/* oxlint-disable typescript/unbound-method -- this test intentionally inspects a mocked method. */
import fs from 'node:fs';
import path from 'node:path';
import type { User } from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawClient } from '../../../server/src/kube/raw-client';
import {
  authTypeOf,
  authWarningForUser,
  describeProbeFailure,
  execCommandOf,
  isCommandOnPath,
  legacyAuthProviderWarning,
  pluginMissingMessage,
  statusCodeOf,
  whoAmI,
} from '../../../server/src/kube/auth-diagnostics';

function user(value: Record<string, unknown>): User {
  return value as unknown as User;
}

function rawJson(value: unknown, reject = false): RawClient {
  return {
    json: vi.fn(async () => {
      if (reject) throw value;
      return value;
    }),
  } as unknown as RawClient;
}

describe('credential classification and proactive warnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('classifies each kubeconfig credential style in priority order', () => {
    expect(authTypeOf(undefined)).toBe('none');
    expect(authTypeOf(user({ exec: { command: 'aws' }, token: 'also-present' }))).toBe('exec');
    expect(authTypeOf(user({ authProvider: { name: 'gcp' }, certData: 'cert' }))).toBe('auth-provider');
    expect(authTypeOf(user({ certData: 'cert' }))).toBe('client-cert');
    expect(authTypeOf(user({ certFile: '/tmp/cert' }))).toBe('client-cert');
    expect(authTypeOf(user({ token: 'token' }))).toBe('token');
    expect(authTypeOf(user({ username: 'alice', password: 'secret' }))).toBe('basic');
    expect(authTypeOf(user({}))).toBe('none');
  });

  it('finds direct and auth-provider nested exec commands', () => {
    expect(execCommandOf(user({ exec: { command: 'aws' } }))).toBe('aws');
    expect(execCommandOf(user({ authProvider: { config: { exec: { command: 'kubelogin' } } } }))).toBe('kubelogin');
    expect(execCommandOf(user({ authProvider: { config: {} } }))).toBeNull();
    expect(execCommandOf(null)).toBeNull();
  });

  it('builds provider-specific and generic missing-plugin guidance', () => {
    expect(pluginMissingMessage('/usr/bin/gke-gcloud-auth-plugin.exe')).toContain('gcloud components install');
    expect(pluginMissingMessage('aws')).toContain('AWS CLI v2');
    expect(pluginMissingMessage('aws-iam-authenticator')).toContain('github.com/kubernetes-sigs');
    expect(pluginMissingMessage('kubelogin')).toContain('az aks install-cli');
    expect(pluginMissingMessage('doctl')).toContain('DigitalOcean CLI');
    expect(pluginMissingMessage('oci')).toContain('Oracle Cloud CLI');
    expect(pluginMissingMessage('vendor/plugin.exe')).toContain('Install "plugin"');
  });

  it('warns for both removed legacy providers', () => {
    expect(legacyAuthProviderWarning('gcp')).toContain('gke-gcloud-auth-plugin');
    expect(legacyAuthProviderWarning('azure')).toContain('kubelogin');
    expect(legacyAuthProviderWarning('oidc')).toBeUndefined();
  });

  it('checks executable files, caches the result briefly, and rejects directories/missing paths', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined);
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    const command = `/tmp/kubus-auth-${Math.random()}`;

    expect(isCommandOnPath(command)).toBe(true);
    expect(isCommandOnPath(command)).toBe(true);
    expect(access).toHaveBeenCalledTimes(1);

    now.mockReturnValue(116_000);
    stat.mockReturnValueOnce({ isFile: () => false } as fs.Stats);
    expect(isCommandOnPath(command)).toBe(false);
    expect(access).toHaveBeenCalledTimes(2);

    const missing = `/tmp/kubus-missing-${Math.random()}`;
    access.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(isCommandOnPath(missing)).toBe(false);
  });

  it('searches PATH and gives legacy warnings precedence over exec checks', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation((candidate) => {
      if (path.basename(String(candidate)) === 'found-tool') return;
      throw new Error('missing');
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.stubEnv('PATH', ['/one', '/two'].join(path.delimiter));

    expect(isCommandOnPath(`found-tool-${Math.random()}`)).toBe(false);
    expect(isCommandOnPath('found-tool')).toBe(true);
    expect(authWarningForUser(user({ authProvider: { name: 'gcp' }, exec: { command: 'missing' } }))).toContain('legacy "gcp"');
    expect(authWarningForUser(user({ exec: { command: `missing-${Math.random()}` } }))).toContain('was not found on PATH');
    expect(authWarningForUser(user({ exec: { command: 'found-tool' } }))).toBeUndefined();
    expect(authWarningForUser(undefined)).toBeUndefined();
  });
});

describe('status and identity diagnostics', () => {
  it('extracts numeric status fields only', () => {
    expect(statusCodeOf({ code: 401 })).toBe(401);
    expect(statusCodeOf({ code: '401', statusCode: 403 })).toBe(403);
    expect(statusCodeOf({ statusCode: 500 })).toBe(500);
    expect(statusCodeOf({ code: 'nope' })).toBeUndefined();
    expect(statusCodeOf(null)).toBeUndefined();
    expect(statusCodeOf('401')).toBeUndefined();
  });

  it('formats SelfSubjectReview identities and filters the default group', async () => {
    const raw = rawJson({
      status: {
        userInfo: {
          username: 'alice',
          groups: ['system:authenticated', 'dev', 'ops', 'security', 'platform', 'extra'],
        },
      },
    });
    expect(await whoAmI(raw, 10)).toBe('user "alice" (groups: dev, ops, security, platform, …)');
    expect(raw.json).toHaveBeenCalledWith(
      '/apis/authentication.k8s.io/v1/selfsubjectreviews',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal) }),
    );

    expect(await whoAmI(rawJson({ status: { userInfo: { username: 'bob', groups: ['system:authenticated'] } } }))).toBe('user "bob"');
    expect(await whoAmI(rawJson({ status: {} }))).toBeNull();
    expect(await whoAmI(rawJson(new Error('forbidden'), true))).toBeNull();
  });
});

describe('describeProbeFailure', () => {
  it('explains every 401 credential style', async () => {
    const unauthorized = { code: 401 };
    expect(await describeProbeFailure(unauthorized, user({ exec: { command: 'aws' } }))).toContain('aws sso login');
    expect(await describeProbeFailure(unauthorized, user({ exec: { command: 'other-plugin' } }))).toContain('Re-authenticate with the cloud CLI');
    expect(await describeProbeFailure(unauthorized, user({ authProvider: { name: 'azure' } }))).toContain('legacy "azure"');
    expect(await describeProbeFailure(unauthorized, user({ token: 'expired' }))).toContain('bearer token');
    expect(await describeProbeFailure(unauthorized, user({ certData: 'cert' }))).toContain('client TLS credentials');
    expect(await describeProbeFailure(unauthorized, undefined)).toContain('request was anonymous');
    expect(await describeProbeFailure(unauthorized, user({ username: 'alice' }))).toBe('The cluster rejected the credentials (401 Unauthorized).');
  });

  it('distinguishes anonymous, authenticated, and unresolved 403 identities', async () => {
    const forbidden = { code: 403, body: { message: 'cannot list pods' } };
    expect(await describeProbeFailure(forbidden, undefined)).toContain('kubeconfig entry has no credentials');

    const anonymousRaw = rawJson({ status: { userInfo: { username: 'system:anonymous' } } });
    expect(await describeProbeFailure(forbidden, user({ token: 'x' }), anonymousRaw)).toContain('treated as anonymous');

    const identifiedRaw = rawJson({ status: { userInfo: { username: 'alice', groups: ['dev'] } } });
    const identified = await describeProbeFailure(forbidden, user({ token: 'x' }), identifiedRaw);
    expect(identified).toContain('Authenticated, but not authorized');
    expect(identified).toContain('user "alice" (groups: dev)');
    expect(identified).toContain('cannot list pods');

    expect(await describeProbeFailure({ statusCode: 403 }, user({ token: 'x' }), rawJson(new Error('down'), true))).toContain(
      'Check the RBAC',
    );
  });

  it('extracts wrapped API details and clips excessively long messages', async () => {
    const wrapped = Object.assign(new Error('HTTP-Code: 403\nMessage: concise detail\nBody: {}'), { code: 403 });
    expect(await describeProbeFailure(wrapped, user({ token: 'x' }))).toContain('concise detail');

    const long = new Error(`  ${'x'.repeat(450)}  `);
    const result = await describeProbeFailure(long, undefined);
    expect(result).toHaveLength(401);
    expect(result.endsWith('…')).toBe(true);
  });

  it('identifies missing and failing exec plugins without mislabeling transport errors', async () => {
    const execUser = user({ exec: { command: '/opt/bin/aws.exe' } });
    const missing = Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall: 'spawn aws' });
    expect(await describeProbeFailure(missing, execUser)).toContain('AWS CLI v2');

    const missingWithoutSyscall = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(await describeProbeFailure(missingWithoutSyscall, execUser)).toContain('was not found on PATH');

    expect(await describeProbeFailure(new Error('cloud login expired'), execUser)).toBe('Credential plugin "aws" failed: cloud login expired');
    expect(await describeProbeFailure(new SyntaxError('bad JSON'), execUser)).toContain('Credential plugin "aws" failed: bad JSON');

    const network = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    expect(await describeProbeFailure(network, execUser)).toBe('connection refused');
    const typed = Object.assign(new Error('fetch failed'), { type: 'system' });
    expect(await describeProbeFailure(typed, execUser)).toBe('fetch failed');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(await describeProbeFailure(aborted, execUser)).toBe('aborted');
    const http = Object.assign(new Error('server exploded'), { code: 500 });
    expect(await describeProbeFailure(http, execUser)).toBe('server exploded');
  });

  it('never returns an empty message for odd failures', async () => {
    const silent = new Error('   ');
    silent.name = '';
    expect(await describeProbeFailure(silent, undefined)).toBe('connection failed (no error message)');
    expect(await describeProbeFailure('', undefined)).toBe('connection failed (no error message)');
    expect(await describeProbeFailure({ reason: 'odd' }, undefined)).toBe('[object Object]');
  });
});
