import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dump, load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCurrentContext,
  mergeKubeconfig,
  patchCluster,
  patchClusterEntry,
  patchUserEntry,
  removeKubeconfigEntry,
  writeKubeconfig,
  type ClusterEditPatch,
} from '../../../server/src/kube/kubeconfig-file.js';

interface ConfigDoc {
  'current-context'?: string;
  clusters?: Array<{ name: string; cluster: Record<string, unknown> }>;
  users?: Array<{ name: string; user: Record<string, unknown> }>;
  contexts?: Array<{ name: string; context: { cluster?: string; user?: string } }>;
  [key: string]: unknown;
}

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configDoc(name: string, server = `https://${name}.example.test`): ConfigDoc {
  return {
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': name,
    preferences: { colors: true },
    clusters: [{ name: `${name}-cluster`, cluster: { server, extension: 'preserve-me' } }],
    users: [{ name: `${name}-user`, user: { token: `${name}-token` } }],
    contexts: [{ name, context: { cluster: `${name}-cluster`, user: `${name}-user` } }],
  };
}

function yaml(doc: ConfigDoc): string {
  return dump(doc, { lineWidth: -1 });
}

function parse(source: string): ConfigDoc {
  return load(source) as ConfigDoc;
}

function basePatch(overrides: Partial<ClusterEditPatch> = {}): ClusterEditPatch {
  return {
    server: 'https://new.example.test',
    skipTlsVerify: false,
    caPem: null,
    proxyUrl: null,
    tlsServerName: null,
    auth: { method: 'keep' },
    ...overrides,
  };
}

function expectHttpProblem(fn: () => unknown, statusCode: number, message: RegExp): void {
  try {
    fn();
    throw new Error('expected HttpProblem');
  } catch (error) {
    expect(error).toMatchObject({ statusCode });
    expect((error as Error).message).toMatch(message);
  }
}

describe('mergeKubeconfig', () => {
  it('creates a new config, defaults current-context, and reports every added entry', () => {
    const incoming = configDoc('first');
    delete incoming['current-context'];

    const result = mergeKubeconfig(null, yaml(incoming), false);
    const merged = parse(result.merged);

    expect(merged['current-context']).toBe('first');
    expect(merged.preferences).toEqual({ colors: true });
    expect(result.added).toEqual({
      contexts: ['first'],
      clusters: ['first-cluster'],
      users: ['first-user'],
    });
    expect(result.connectionContexts).toEqual(['first']);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('adds unique entries without changing an existing current-context', () => {
    const result = mergeKubeconfig(yaml(configDoc('alpha')), yaml(configDoc('beta')), false);
    const merged = parse(result.merged);

    expect(merged['current-context']).toBe('alpha');
    expect(merged.contexts?.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(result.added).toEqual({
      contexts: ['beta'],
      clusters: ['beta-cluster'],
      users: ['beta-user'],
    });
    expect(result.connectionContexts).toEqual(['beta']);
  });

  it('applies an imported proxy URL to every incoming cluster', () => {
    const incoming = configDoc('proxied');
    incoming.clusters!.push({
      name: 'second-cluster',
      cluster: { server: 'https://second.example.test', 'proxy-url': 'http://old-proxy' },
    });

    const result = mergeKubeconfig(null, yaml(incoming), false, 'socks5h://jump.example.test:1080');

    expect(parse(result.merged).clusters?.map((entry) => entry.cluster['proxy-url'])).toEqual([
      'socks5h://jump.example.test:1080',
      'socks5h://jump.example.test:1080',
    ]);
  });

  it('removes imported proxy URLs when an SSH jump host will own the connection', () => {
    const incoming = configDoc('jumped');
    incoming.clusters![0]!.cluster['proxy-url'] = 'socks5://old-proxy:1080';

    const result = mergeKubeconfig(null, yaml(incoming), false, null);

    expect(parse(result.merged).clusters?.[0]?.cluster['proxy-url']).toBeUndefined();
  });

  it('separates identical entries from conflicting entries', () => {
    const existing = configDoc('same');
    const incoming = structuredClone(existing);
    incoming.clusters![0]!.cluster.server = 'https://different.example.test';

    const result = mergeKubeconfig(yaml(existing), yaml(incoming), false);

    expect(result.skipped).toEqual(['user/same-user', 'context/same']);
    expect(result.conflicts).toEqual(['cluster/same-cluster']);
    expect(parse(result.merged).clusters?.[0]?.cluster.server).toBe('https://same.example.test');
  });

  it('overwrites conflicts only when explicitly requested', () => {
    const existing = configDoc('same');
    const incoming = structuredClone(existing);
    incoming.clusters![0]!.cluster.server = 'https://replacement.example.test';
    incoming.users![0]!.user.token = 'replacement-token';

    const result = mergeKubeconfig(yaml(existing), yaml(incoming), true);
    const merged = parse(result.merged);

    expect(result.conflicts).toEqual([]);
    expect(result.added.clusters).toEqual(['same-cluster']);
    expect(result.added.users).toEqual(['same-user']);
    expect(merged.clusters?.[0]?.cluster.server).toBe('https://replacement.example.test');
    expect(merged.users?.[0]?.user.token).toBe('replacement-token');
  });

  it('rejects invalid configs and configs without contexts', () => {
    expectHttpProblem(() => mergeKubeconfig(null, 'not: [valid', false), 400, /not a valid kubeconfig/);
    expectHttpProblem(
      () => mergeKubeconfig(null, yaml({ apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [] }), false),
      400,
      /contains no contexts/,
    );
  });
});

describe('cluster and user patches', () => {
  it('patches connection fields, embeds a PEM CA, and preserves auth when requested', () => {
    const doc = configDoc('alpha');
    doc.clusters![0]!.cluster = {
      server: 'https://old.example.test',
      'certificate-authority': '/tmp/ca.pem',
      'proxy-url': 'http://old-proxy',
      extension: 'preserve-me',
    };
    doc.users![0]!.user = { token: 'keep-token', exec: { command: 'kubelogin' } };
    const ca = '-----BEGIN CERTIFICATE-----\nY2E=\n-----END CERTIFICATE-----';

    const patched = parse(
      patchCluster(
        yaml(doc),
        'alpha',
        basePatch({ server: '  https://new.example.test  ', caPem: ca, tlsServerName: ' api.internal ', proxyUrl: null }),
      ),
    );
    const cluster = patched.clusters![0]!.cluster;

    expect(cluster.server).toBe('https://new.example.test');
    expect(cluster['proxy-url']).toBeUndefined();
    expect(cluster['tls-server-name']).toBe('api.internal');
    expect(cluster['certificate-authority']).toBeUndefined();
    expect(Buffer.from(String(cluster['certificate-authority-data']), 'base64').toString('utf8')).toBe(`${ca}\n`);
    expect(cluster.extension).toBe('preserve-me');
    expect(patched.users![0]!.user).toEqual({ token: 'keep-token', exec: { command: 'kubelogin' } });
  });

  it('enabling insecure TLS removes every CA reference', () => {
    const doc = configDoc('alpha');
    doc.clusters![0]!.cluster = {
      server: 'https://old.example.test',
      'certificate-authority': '/tmp/ca.pem',
      'certificate-authority-data': 'Y2E=',
    };

    const patched = parse(patchClusterEntry(yaml(doc), 'alpha-cluster', basePatch({ skipTlsVerify: true })));
    const cluster = patched.clusters![0]!.cluster;

    expect(cluster['insecure-skip-tls-verify']).toBe(true);
    expect(cluster['certificate-authority']).toBeUndefined();
    expect(cluster['certificate-authority-data']).toBeUndefined();
  });

  it('switches to token auth and removes incompatible credential mechanisms', () => {
    const doc = configDoc('alpha');
    doc.users![0]!.user = {
      exec: { command: 'plugin' },
      'auth-provider': { name: 'oidc' },
      username: 'old',
      password: 'old',
      'client-certificate-data': 'old',
      'client-key-data': 'old',
    };

    const patched = parse(patchUserEntry(yaml(doc), 'alpha-user', { method: 'token', token: '  new-token  ' }));

    expect(patched.users![0]!.user).toEqual({ token: 'new-token' });
  });

  it('switches to client certificate auth and accepts copied base64 PEM values', () => {
    const cert = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----';
    const key = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----';
    const patched = parse(
      patchUserEntry(yaml(configDoc('alpha')), 'alpha-user', {
        method: 'client-cert',
        clientCertPem: Buffer.from(cert).toString('base64'),
        clientKeyPem: Buffer.from(key).toString('base64'),
      }),
    );
    const user = patched.users![0]!.user;

    expect(Buffer.from(String(user['client-certificate-data']), 'base64').toString('utf8')).toBe(`${cert}\n`);
    expect(Buffer.from(String(user['client-key-data']), 'base64').toString('utf8')).toBe(`${key}\n`);
    expect(user.token).toBeUndefined();
  });

  it('reports missing context, cluster, and user references precisely', () => {
    const source = yaml(configDoc('alpha'));
    expectHttpProblem(() => patchCluster(source, 'missing', basePatch()), 404, /context "missing"/);
    expectHttpProblem(() => patchClusterEntry(source, undefined, basePatch()), 400, /no cluster reference/);
    expectHttpProblem(() => patchClusterEntry(source, 'missing', basePatch()), 404, /cluster "missing"/);
    expectHttpProblem(() => patchUserEntry(source, undefined, { method: 'token', token: 'x' }), 400, /no user reference/);
    expectHttpProblem(() => patchUserEntry(source, 'missing', { method: 'token', token: 'x' }), 404, /user "missing"/);
  });
});

describe('entry removal and persistence', () => {
  it('removes a current context and clears only its current-context reference', () => {
    const result = parse(removeKubeconfigEntry(yaml(configDoc('alpha')), 'contexts', 'alpha'));

    expect(result.contexts).toEqual([]);
    expect(result['current-context']).toBeUndefined();
    expect(result.clusters).toHaveLength(1);
    expect(result.users).toHaveLength(1);
  });

  it('removes cluster and user entries and rejects unknown names', () => {
    const withoutCluster = parse(removeKubeconfigEntry(yaml(configDoc('alpha')), 'clusters', 'alpha-cluster'));
    expect(withoutCluster.clusters).toEqual([]);

    const withoutUser = parse(removeKubeconfigEntry(yaml(configDoc('alpha')), 'users', 'alpha-user'));
    expect(withoutUser.users).toEqual([]);

    expectHttpProblem(() => removeKubeconfigEntry(yaml(configDoc('alpha')), 'contexts', 'missing'), 404, /not found/);
  });

  it('clears matching current-context references and leaves other files untouched', () => {
    const source = yaml(configDoc('alpha'));
    expect(parse(clearCurrentContext(source, 'alpha')!)['current-context']).toBeUndefined();
    expect(clearCurrentContext(source, 'other')).toBeNull();
  });

  it('writes a new nested kubeconfig atomically', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kubus-kubeconfig-test-'));
    scratchDirs.push(root);
    const target = path.join(root, 'nested', 'config');

    expect(writeKubeconfig(target, 'first')).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('creates a rolling backup and preserves the existing file mode', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kubus-kubeconfig-test-'));
    scratchDirs.push(root);
    const target = path.join(root, 'config');
    writeFileSync(target, 'before', { mode: 0o640 });
    chmodSync(target, 0o640);

    expect(writeKubeconfig(target, 'after')).toBe(`${target}.kubus.bak`);
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(readFileSync(`${target}.kubus.bak`, 'utf8')).toBe('before');
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o640);
  });
});
