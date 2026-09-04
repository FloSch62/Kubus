import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeSessionKubeconfig, sessionKubeconfigPath, singleContextKubeconfig, sweepStaleSessionKubeconfigs, writeSessionKubeconfig } from '../../../server/src/local-shell/kubeconfig';
import { resolveShell } from '../../../server/src/local-shell/pty';
import { loadYaml } from '../../../server/src/util/yaml';

const full = {
  apiVersion: 'v1',
  kind: 'Config',
  'current-context': 'prod',
  clusters: [
    { name: 'dev-cluster', cluster: { server: 'https://dev:6443', 'certificate-authority-data': 'ZGV2', 'proxy-url': 'socks5h://127.0.0.1:1080' } },
    { name: 'prod-cluster', cluster: { server: 'https://prod:6443', 'insecure-skip-tls-verify': true } },
  ],
  users: [
    { name: 'dev-user', user: { token: 'dev-token' } },
    { name: 'prod-user', user: { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: 'aws', args: ['eks', 'get-token'] } } },
  ],
  contexts: [
    { name: 'dev', context: { cluster: 'dev-cluster', user: 'dev-user', namespace: 'team-a' } },
    { name: 'prod', context: { cluster: 'prod-cluster', user: 'prod-user' } },
  ],
};

describe('singleContextKubeconfig', () => {
  it('keeps exactly the one context with its cluster and user, and applies the namespace', () => {
    const config = singleContextKubeconfig(full, 'dev', 'payments');
    expect(config['current-context']).toBe('dev');
    expect(config.clusters?.map((c) => c.name)).toEqual(['dev-cluster']);
    expect(config.users?.map((u) => u.name)).toEqual(['dev-user']);
    expect(config.contexts).toEqual([{ name: 'dev', context: { cluster: 'dev-cluster', user: 'dev-user', namespace: 'payments' } }]);
    // The tunnel's proxy-url survives verbatim: kubectl reaches the cluster the same way Kubus does.
    expect(config.clusters?.[0]?.cluster).toMatchObject({ 'proxy-url': 'socks5h://127.0.0.1:1080' });
  });

  it('drops the kubeconfig namespace when none is chosen and preserves exec auth', () => {
    const config = singleContextKubeconfig(full, 'prod', undefined);
    expect(config.contexts?.[0]?.context).toEqual({ cluster: 'prod-cluster', user: 'prod-user' });
    expect(config.users?.[0]?.user).toEqual({ exec: { apiVersion: 'client.authentication.k8s.io/v1', command: 'aws', args: ['eks', 'get-token'] } });
    expect(() => singleContextKubeconfig(full, 'missing', undefined)).toThrow('context "missing" not found');
  });

  it('strips undefined and null leaves so the YAML stays clean', () => {
    const config = singleContextKubeconfig(
      { ...full, clusters: [{ name: 'dev-cluster', cluster: { server: 'https://dev:6443', 'certificate-authority': undefined, 'proxy-url': null } }] },
      'dev',
      undefined,
    );
    expect(config.clusters?.[0]?.cluster).toEqual({ server: 'https://dev:6443' });
  });
});

describe('session kubeconfig files', () => {
  const sessionId = `test-${process.pid}-${Date.now()}`;
  afterEach(() => removeSessionKubeconfig(sessionId));

  it('writes an owner-only YAML file and rewrites it in place on context switches', () => {
    const path = writeSessionKubeconfig(sessionId, singleContextKubeconfig(full, 'dev', 'team-a'));
    expect(path).toBe(sessionKubeconfigPath(sessionId));
    // NTFS has no POSIX mode bits; the owner-only mode is a POSIX guarantee.
    if (process.platform !== 'win32') expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect((loadYaml(fs.readFileSync(path, 'utf8')) as { 'current-context': string })['current-context']).toBe('dev');

    writeSessionKubeconfig(sessionId, singleContextKubeconfig(full, 'prod', undefined));
    const rewritten = loadYaml(fs.readFileSync(path, 'utf8')) as { 'current-context': string; contexts: Array<{ context: Record<string, unknown> }> };
    expect(rewritten['current-context']).toBe('prod');
    expect(rewritten.contexts[0]?.context.namespace).toBeUndefined();
    expect(fs.existsSync(`${path}.tmp`)).toBe(false);

    removeSessionKubeconfig(sessionId);
    expect(fs.existsSync(path)).toBe(false);
    // Removing twice is harmless.
    removeSessionKubeconfig(sessionId);
  });

  it('sanitizes the session id used as a file name and prefixes the server pid', () => {
    expect(sessionKubeconfigPath('../../etc/passwd')).toMatch(new RegExp(`[\\\\/]${process.pid}-______etc_passwd\\.yaml$`));
  });

  it('sweeps files left by dead servers and keeps live ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-sweep-'));
    for (const name of ['1-dead.yaml', '2-dead.yaml.tmp', `${process.pid}-mine.yaml`, '3-live.yaml', 'unrelated.txt']) fs.writeFileSync(path.join(dir, name), 'x');
    const removed = sweepStaleSessionKubeconfigs(dir, (pid) => pid === 3);
    expect(removed.sort()).toEqual(['1-dead.yaml', '2-dead.yaml.tmp']);
    expect(fs.readdirSync(dir).sort()).toEqual(['3-live.yaml', `${process.pid}-mine.yaml`, 'unrelated.txt'].sort());
    fs.rmSync(dir, { recursive: true, force: true });
    expect(sweepStaleSessionKubeconfigs(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('resolveShell', () => {
  it('prefers the requested shell, then $SHELL, with login flags for known shells', () => {
    expect(resolveShell('/usr/local/bin/fish', { SHELL: '/bin/bash' }, 'linux')).toEqual({ file: '/usr/local/bin/fish', args: ['-l'] });
    expect(resolveShell(undefined, { SHELL: '/bin/zsh' }, 'darwin')).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(resolveShell('/opt/tools/nu', { SHELL: '/bin/zsh' }, 'linux')).toEqual({ file: '/opt/tools/nu', args: [] });
    expect(resolveShell('  ', { SHELL: '/bin/bash' }, 'linux')).toEqual({ file: '/bin/bash', args: ['-l'] });
  });

  it('falls back to PowerShell or the command processor on Windows', () => {
    expect(resolveShell(undefined, { PATH: '', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toEqual({ file: 'C:\\Windows\\system32\\cmd.exe', args: [] });
    expect(resolveShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', {}, 'win32')).toEqual({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] });
  });
});
