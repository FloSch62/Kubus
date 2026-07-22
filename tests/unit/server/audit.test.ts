/* oxlint-disable typescript/unbound-method -- this test intentionally inspects mocked methods. */
import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_CHECKS, runAudit } from '../../../server/src/kube/audit';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';

type ObjectsByPlural = Record<string, KubeObject[]>;

function object(name: string, overrides: Record<string, unknown> = {}): KubeObject {
  const metadata = (overrides.metadata ?? {}) as Record<string, unknown>;
  return {
    apiVersion: 'v1',
    kind: 'Unknown',
    ...overrides,
    metadata: { name, namespace: 'apps', uid: `${name}-uid`, ...metadata },
  } as KubeObject;
}

function pluralFromPath(path: string): string {
  return path.split('?')[0]!.split('/').at(-1)!;
}

function handleFor(
  objects: ObjectsByPlural,
  options: { livePlural?: string; failures?: Record<string, unknown> } = {},
): ClusterHandle {
  return {
    contextName: 'kind-a',
    watchers: {
      peek: vi.fn((_group: string, _version: string, plural: string) =>
        plural === options.livePlural
          ? {
              currentState: () => 'live',
              items: () => objects[plural] ?? [],
            }
          : undefined,
      ),
    },
    raw: {
      json: vi.fn(async (path: string) => {
        const plural = pluralFromPath(path);
        if (plural in (options.failures ?? {})) throw options.failures![plural];
        return { items: objects[plural] };
      }),
    },
  } as unknown as ClusterHandle;
}

function hostilePodSpec() {
  return {
    hostNetwork: true,
    hostPID: true,
    hostIPC: true,
    serviceAccountName: 'default',
    volumes: [
      { name: 'docker', hostPath: { path: '/var/run/docker.sock' } },
      { name: 'host', hostPath: { path: '/etc' } },
      { name: 'empty' },
    ],
    securityContext: { seccompProfile: { type: 'Unconfined' } },
    containers: [
      {
        name: 'unsafe',
        image: 'repo/app:latest',
        ports: [{ hostPort: 30080, containerPort: 8080 }, {}],
        env: [
          { name: 'DATABASE_PASSWORD', value: 'cleartext' },
          { name: 'SAFE', value: 'okay' },
        ],
        securityContext: {
          privileged: true,
          capabilities: { add: ['SYS_ADMIN'] },
          seccompProfile: { type: 'Unconfined' },
        },
      },
      {
        name: 'less-unsafe',
        image: 'registry.example.com/team/app',
        livenessProbe: {},
        readinessProbe: {},
        resources: { limits: { cpu: '1', memory: '1Gi' }, requests: { cpu: '100m', memory: '64Mi' } },
        securityContext: {
          allowPrivilegeEscalation: false,
          runAsNonRoot: true,
          readOnlyRootFilesystem: true,
          capabilities: { add: ['CHOWN'], drop: ['ALL'] },
        },
      },
    ],
    initContainers: [{ name: 'init', image: 'busybox:1.36' }],
  };
}

function comprehensiveObjects(): ObjectsByPlural {
  const hostileTemplate = {
    metadata: {
      labels: { app: 'hostile' },
      annotations: { 'container.apparmor.security.beta.kubernetes.io/unsafe': 'unconfined' },
    },
    spec: hostilePodSpec(),
  };
  const healthyTemplate = {
    metadata: { labels: { app: 'healthy' } },
    spec: {
      serviceAccountName: 'app',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'app',
          image: 'app@sha256:1234',
          livenessProbe: {},
          readinessProbe: {},
          resources: { limits: { cpu: '1', memory: '1Gi' }, requests: { cpu: '100m', memory: '64Mi' } },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
        },
      ],
    },
  };

  return {
    pods: [
      object('bare-hostile', { kind: 'Pod', spec: hostilePodSpec() }),
      object('owned', { kind: 'Pod', metadata: { name: 'owned', namespace: 'apps', ownerReferences: [{ kind: 'ReplicaSet', name: 'rs' }] } }),
      object('pod-in-open-ns', { kind: 'Pod', metadata: { name: 'pod-in-open-ns', namespace: 'open' }, spec: healthyTemplate.spec }),
      object('pod-in-secure-ns', { kind: 'Pod', metadata: { name: 'pod-in-secure-ns', namespace: 'secure' }, spec: healthyTemplate.spec }),
    ],
    deployments: [
      object('hostile-deployment', { kind: 'Deployment', spec: { replicas: 1, template: hostileTemplate } }),
      object('resilient-uncovered', {
        kind: 'Deployment',
        metadata: { name: 'resilient-uncovered', namespace: 'open' },
        spec: { replicas: 3, template: { ...healthyTemplate, metadata: { labels: { app: 'uncovered' } } } },
      }),
      object('resilient-covered', {
        kind: 'Deployment',
        metadata: { name: 'resilient-covered', namespace: 'secure' },
        spec: { replicas: 3, template: healthyTemplate },
      }),
      object('no-template', { kind: 'Deployment', spec: {} }),
    ],
    statefulsets: [object('stateful', { kind: 'StatefulSet', spec: { replicas: 2, template: healthyTemplate } })],
    daemonsets: [object('daemon', { kind: 'DaemonSet', spec: { template: healthyTemplate } })],
    jobs: [
      object('job', { kind: 'Job', spec: { template: healthyTemplate } }),
      object('cron-owned-job', {
        kind: 'Job',
        metadata: { name: 'cron-owned-job', namespace: 'apps', ownerReferences: [{ kind: 'CronJob', name: 'nightly' }] },
        spec: { template: hostileTemplate },
      }),
    ],
    cronjobs: [
      object('nightly', { kind: 'CronJob', spec: { jobTemplate: { spec: { template: healthyTemplate } } } }),
      object('empty-cron', { kind: 'CronJob', spec: {} }),
    ],
    services: [
      object('node-port', { kind: 'Service', spec: { type: 'NodePort', ports: [{ nodePort: 30080 }, {}] } }),
      object('node-port-auto', { kind: 'Service', spec: { type: 'NodePort', ports: [] } }),
      object('cluster-ip', { kind: 'Service', spec: { type: 'ClusterIP' } }),
    ],
    ingresses: [
      object('plain', { kind: 'Ingress', spec: { rules: [{ host: 'plain.example.com' }] } }),
      object('partial-tls', {
        kind: 'Ingress',
        spec: { tls: [{ hosts: ['secure.example.com'] }], rules: [{ host: 'secure.example.com' }, { host: 'plain.example.com' }, {}] },
      }),
      object('secure-ingress', {
        kind: 'Ingress',
        spec: { tls: [{ hosts: ['secure.example.com'] }], rules: [{ host: 'secure.example.com' }] },
      }),
    ],
    networkpolicies: [object('default-deny', { kind: 'NetworkPolicy', metadata: { name: 'default-deny', namespace: 'secure' } })],
    poddisruptionbudgets: [
      object('healthy-pdb', {
        kind: 'PodDisruptionBudget',
        metadata: { name: 'healthy-pdb', namespace: 'secure' },
        spec: { selector: { matchLabels: { app: 'healthy' } } },
      }),
      object('expression-pdb', {
        kind: 'PodDisruptionBudget',
        metadata: { name: 'expression-pdb', namespace: 'other' },
        spec: { selector: { matchExpressions: [{ key: 'app', operator: 'Exists' }] } },
      }),
    ],
    namespaces: [
      object('open', { kind: 'Namespace', metadata: { name: 'open' } }),
      object('secure', { kind: 'Namespace', metadata: { name: 'secure' } }),
      object('kube-system', { kind: 'Namespace', metadata: { name: 'kube-system' } }),
    ],
    nodes: [
      object('not-ready', {
        kind: 'Node',
        metadata: { name: 'not-ready' },
        status: { conditions: [{ type: 'Ready', status: 'False', message: 'kubelet stopped' }] },
      }),
      object('unknown-ready', {
        kind: 'Node',
        metadata: { name: 'unknown-ready' },
        status: { conditions: [{ type: 'Ready', status: 'Unknown' }] },
      }),
      object('ready', { kind: 'Node', metadata: { name: 'ready' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    ],
    clusterroles: [
      object('dangerous-cluster-role', {
        kind: 'ClusterRole',
        metadata: { name: 'dangerous-cluster-role' },
        rules: [
          { apiGroups: ['*'], resources: ['*'], verbs: ['*'] },
          { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles'], verbs: ['bind', 'escalate'] },
          { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'watch'] },
        ],
      }),
      object('system:controller', {
        kind: 'ClusterRole',
        metadata: { name: 'system:controller' },
        rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
      }),
    ],
    roles: [
      object('named-secret-reader', {
        kind: 'Role',
        rules: [{ resources: ['secrets'], verbs: ['get'], resourceNames: ['one'] }],
      }),
    ],
    clusterrolebindings: [
      object('admins', {
        kind: 'ClusterRoleBinding',
        metadata: { name: 'admins' },
        roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
        subjects: [
          { kind: 'User', name: 'alice' },
          { kind: 'ServiceAccount', namespace: 'apps', name: 'builder' },
        ],
      }),
      object('system:masters', {
        kind: 'ClusterRoleBinding',
        metadata: { name: 'system:masters' },
        roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
      }),
    ],
    rolebindings: [
      object('namespace-admin', {
        kind: 'RoleBinding',
        roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
        subjects: [],
      }),
    ],
    configmaps: [
      object('credentials', { kind: 'ConfigMap', data: { password: 'clear', api_key: 'key', cert_path: '/mounted/file', empty_secret: '' } }),
      object('normal-config', { kind: 'ConfigMap', data: { color: 'blue', token: 42 } }),
    ],
    serviceaccounts: [
      object('default', {
        kind: 'ServiceAccount',
        metadata: { name: 'default', namespace: 'open' },
        automountServiceAccountToken: false,
      }),
    ],
  };
}

describe('runAudit', () => {
  it('runs every check family, reuses live watcher data, sorts findings, and suppresses opted-out default tokens', async () => {
    const objects = comprehensiveObjects();
    const handle = handleFor(objects, { livePlural: 'pods' });
    const report = await runAudit(handle);

    const ids = new Set(report.findings.map((finding) => finding.checkId));
    expect(ids).toEqual(new Set(AUDIT_CHECKS.map((check) => check.id)));
    expect(report.findings[0]?.severity).toBe('critical');
    expect(report.findings.some((finding) => finding.checkId === 'default-service-account' && finding.resource.namespace === 'open')).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ checkId: 'cluster-admin-binding', message: 'binds cluster-admin to User/alice, ServiceAccount/apps/builder' }),
    );
    expect(report.findings).toContainEqual(expect.objectContaining({ checkId: 'node-not-ready', message: 'Ready condition is Unknown' }));
    expect(report.errors).toEqual([]);
    expect(report.truncated).toBe(false);
    expect(report.stats.checksRun).toBe(AUDIT_CHECKS.length);
    expect(report.stats.resourcesScanned).toBe(Object.values(objects).flat().length);
    expect(report.stats.durationMs).toBeGreaterThanOrEqual(0);

    const rawJson = handle.raw.json as unknown as ReturnType<typeof vi.fn>;
    expect(rawJson.mock.calls.some(([path]) => String(path).includes('/pods?'))).toBe(false);
  });

  it('degrades list failures into report errors for Error and non-Error failures', async () => {
    const report = await runAudit(
      handleFor({}, { failures: { pods: new Error('forbidden'), services: 'socket closed' } }),
    );
    expect(report.findings).toEqual([]);
    expect(report.errors).toContain('Pod: forbidden');
    expect(report.errors).toContain('Service: socket closed');
    expect(report.stats.resourcesScanned).toBe(0);
  });

  it('caps pathological reports at 2,000 findings and marks them truncated', async () => {
    const pods = Array.from({ length: 180 }, (_, index) =>
      object(`hostile-${index}`, {
        kind: 'Pod',
        metadata: { name: `hostile-${index}`, namespace: 'unsafe' },
        spec: hostilePodSpec(),
      }),
    );
    const report = await runAudit(handleFor({ pods }));
    expect(report.truncated).toBe(true);
    expect(report.findings).toHaveLength(2000);
    expect(report.stats.resourcesScanned).toBe(180);
  });
});
