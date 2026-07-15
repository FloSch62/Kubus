import type { FastifyBaseLogger } from 'fastify';
import type { MetricsServerInstallResult, MetricsServerStatus, MetricsServerUninstallResult } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { loadAllYaml } from '../util/yaml.js';
import { HttpProblem } from '../util/errors.js';

export const METRICS_SERVER_VERSION = 'v0.8.0';

const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'kubus';
const NAMESPACE = 'kube-system';
const DEPLOYMENT_PATH = resourcePath('apps', 'v1', 'deployments', { namespace: NAMESPACE, name: 'metrics-server' });
const APISERVICE_PATH = resourcePath('apiregistration.k8s.io', 'v1', 'apiservices', { name: 'v1beta1.metrics.k8s.io' });

/**
 * The upstream components.yaml for metrics-server, pinned. Kept verbatim so
 * it can be diffed against
 * https://github.com/kubernetes-sigs/metrics-server/releases when bumping
 * METRICS_SERVER_VERSION. Kubus stamps its managed-by label at install time.
 */
const COMPONENTS_YAML = `
apiVersion: v1
kind: ServiceAccount
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  labels:
    k8s-app: metrics-server
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
    rbac.authorization.k8s.io/aggregate-to-view: "true"
  name: system:aggregated-metrics-reader
rules:
- apiGroups:
  - metrics.k8s.io
  resources:
  - pods
  - nodes
  verbs:
  - get
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  labels:
    k8s-app: metrics-server
  name: system:metrics-server
rules:
- apiGroups:
  - ""
  resources:
  - nodes/metrics
  verbs:
  - get
- apiGroups:
  - ""
  resources:
  - pods
  - nodes
  verbs:
  - get
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server-auth-reader
  namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: extension-apiserver-authentication-reader
subjects:
- kind: ServiceAccount
  name: metrics-server
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server:system:auth-delegator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
- kind: ServiceAccount
  name: metrics-server
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  labels:
    k8s-app: metrics-server
  name: system:metrics-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:metrics-server
subjects:
- kind: ServiceAccount
  name: metrics-server
  namespace: kube-system
---
apiVersion: v1
kind: Service
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server
  namespace: kube-system
spec:
  ports:
  - name: https
    port: 443
    protocol: TCP
    targetPort: https
  selector:
    k8s-app: metrics-server
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: metrics-server
  strategy:
    rollingUpdate:
      maxUnavailable: 0
  template:
    metadata:
      labels:
        k8s-app: metrics-server
    spec:
      containers:
      - args:
        - --cert-dir=/tmp
        - --secure-port=10250
        - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
        - --kubelet-use-node-status-port
        - --metric-resolution=15s
        image: registry.k8s.io/metrics-server/metrics-server:${METRICS_SERVER_VERSION}
        imagePullPolicy: IfNotPresent
        livenessProbe:
          failureThreshold: 3
          httpGet:
            path: /livez
            port: https
            scheme: HTTPS
          periodSeconds: 10
        name: metrics-server
        ports:
        - containerPort: 10250
          name: https
          protocol: TCP
        readinessProbe:
          failureThreshold: 3
          httpGet:
            path: /readyz
            port: https
            scheme: HTTPS
          initialDelaySeconds: 20
          periodSeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 200Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          seccompProfile:
            type: RuntimeDefault
        volumeMounts:
        - mountPath: /tmp
          name: tmp-dir
      nodeSelector:
        kubernetes.io/os: linux
      priorityClassName: system-cluster-critical
      serviceAccountName: metrics-server
      volumes:
      - emptyDir: {}
        name: tmp-dir
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  labels:
    k8s-app: metrics-server
  name: v1beta1.metrics.k8s.io
spec:
  group: metrics.k8s.io
  groupPriorityMinimum: 100
  insecureSkipTLSVerify: true
  service:
    name: metrics-server
    namespace: kube-system
  version: v1beta1
  versionPriority: 100
`;

/** Resource paths per manifest kind — the manifest is vendored, so this stays in lockstep. */
const KIND_PATHS: Record<string, { group: string; version: string; plural: string; namespaced: boolean }> = {
  ServiceAccount: { group: '', version: 'v1', plural: 'serviceaccounts', namespaced: true },
  ClusterRole: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterroles', namespaced: false },
  ClusterRoleBinding: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterrolebindings', namespaced: false },
  RoleBinding: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'rolebindings', namespaced: true },
  Service: { group: '', version: 'v1', plural: 'services', namespaced: true },
  Deployment: { group: 'apps', version: 'v1', plural: 'deployments', namespaced: true },
  APIService: { group: 'apiregistration.k8s.io', version: 'v1', plural: 'apiservices', namespaced: false },
};

interface ManifestDoc {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: { template?: { spec?: { containers?: Array<{ name: string; args?: string[] }> } } };
  [key: string]: unknown;
}

function manifestDocs(opts?: { insecureTls?: boolean }): ManifestDoc[] {
  const docs = loadAllYaml(COMPONENTS_YAML) as ManifestDoc[];
  for (const doc of docs) {
    doc.metadata.labels = { ...doc.metadata.labels, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE };
    if (opts?.insecureTls && doc.kind === 'Deployment') {
      const container = doc.spec?.template?.spec?.containers?.find((c) => c.name === 'metrics-server');
      container?.args?.push('--kubelet-insecure-tls');
    }
  }
  return docs;
}

function docPath(doc: ManifestDoc): { path: string; label: string } {
  const target = KIND_PATHS[doc.kind];
  if (!target) throw new HttpProblem(500, `unexpected kind in metrics-server manifest: ${doc.kind}`);
  const namespace = target.namespaced ? (doc.metadata.namespace ?? NAMESPACE) : undefined;
  return {
    path: resourcePath(target.group, target.version, target.plural, { namespace, name: doc.metadata.name }),
    label: `${doc.kind}/${namespace ? `${namespace}/` : ''}${doc.metadata.name}`,
  };
}

/**
 * Install (or repair) metrics-server via server-side apply of the vendored
 * upstream manifest — idempotent, no helm involved. Fails fast on the first
 * resource the user lacks permissions for.
 */
export async function installMetricsServer(handle: ClusterHandle, opts: { insecureTls?: boolean }): Promise<MetricsServerInstallResult> {
  const applied: string[] = [];
  for (const doc of manifestDocs(opts)) {
    const { path, label } = docPath(doc);
    await handle.raw.json(`${path}?fieldManager=kubus&force=true`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/apply-patch+yaml' },
      body: JSON.stringify(doc),
    });
    applied.push(label);
  }
  handle.metricsPoller.kick();
  return { applied };
}

/**
 * Delete every resource of the vendored manifest (reverse order,
 * best-effort). Works for any standard components.yaml install, not only
 * Kubus-managed ones — the resource names are upstream's.
 */
export async function uninstallMetricsServer(handle: ClusterHandle, log: FastifyBaseLogger): Promise<MetricsServerUninstallResult> {
  const result: MetricsServerUninstallResult = { deleted: [], failed: [] };
  for (const doc of manifestDocs().reverse()) {
    const { path, label } = docPath(doc);
    try {
      await handle.raw.json(path, { method: 'DELETE' });
      result.deleted.push(label);
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        result.deleted.push(label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ label, err: message }, 'metrics-server uninstall: resource delete failed');
        result.failed.push({ resource: label, error: message });
      }
    }
  }
  // Flip to unavailable immediately — the aggregated API can keep answering
  // for a few seconds after the APIService delete, so probing now (kick)
  // would report stale availability until the next poll fails.
  handle.metricsPoller.markUnavailable();
  return result;
}

interface DeploymentProbe {
  metadata?: { labels?: Record<string, string> };
  spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
  status?: { readyReplicas?: number };
}

async function probe<T>(handle: ClusterHandle, path: string): Promise<T | undefined> {
  try {
    return await handle.raw.json<T>(path);
  } catch (err) {
    if ((err as { code?: number }).code === 404) return undefined;
    throw err;
  }
}

export async function metricsServerStatus(handle: ClusterHandle): Promise<MetricsServerStatus> {
  const [deployment, apiService] = await Promise.all([
    probe<DeploymentProbe>(handle, DEPLOYMENT_PATH),
    probe<{ metadata?: { labels?: Record<string, string> } }>(handle, APISERVICE_PATH),
  ]);
  const installed = !!deployment || !!apiService;
  const labels = deployment?.metadata?.labels ?? apiService?.metadata?.labels;
  const image = deployment?.spec?.template?.spec?.containers?.find((c) => c.name === 'metrics-server')?.image;
  const tag = image?.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : undefined;
  // Freshly installed but not yet polled: probe promptly so the UI flips to
  // "available" within seconds instead of the slow unavailable interval.
  if (installed && !handle.metricsPoller.available) handle.metricsPoller.kick();
  return {
    installed,
    managedByKubus: labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
    ready: (deployment?.status?.readyReplicas ?? 0) > 0,
    version: tag,
    metricsAvailable: handle.metricsPoller.available,
  };
}
