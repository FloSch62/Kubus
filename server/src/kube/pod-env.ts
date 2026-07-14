import type { KubeObject, PodEnvResponse, PodEnvVar } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { REDACTED } from './redact.js';
import { parseQuantity } from './quantity.js';

interface EnvVarSource {
  configMapKeyRef?: { name: string; key: string; optional?: boolean };
  secretKeyRef?: { name: string; key: string; optional?: boolean };
  fieldRef?: { fieldPath: string };
  resourceFieldRef?: { containerName?: string; resource: string; divisor?: string };
}

interface ContainerSpec {
  name: string;
  env?: Array<{ name: string; value?: string; valueFrom?: EnvVarSource }>;
  envFrom?: Array<{ prefix?: string; configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean } }>;
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
}

interface PodSpec {
  containers?: ContainerSpec[];
  initContainers?: ContainerSpec[];
  nodeName?: string;
  serviceAccountName?: string;
}

const KEYED_FIELD_REF_RE = /^metadata\.(labels|annotations)\['([^']+)'\]$/;

/**
 * Resolve a pod's effective environment variables, expanding ConfigMap and
 * Secret references server-side. Secret-sourced values are replaced with the
 * redaction placeholder unless `reveal` is set — raw secret data never leaves
 * the server otherwise (same contract as the Secret resource route).
 */
export async function resolvePodEnv(handle: ClusterHandle, namespace: string, podName: string, reveal: boolean): Promise<PodEnvResponse> {
  const pod = await handle.raw.json<KubeObject>(resourcePath('', 'v1', 'pods', { namespace, name: podName }));
  const spec = (pod.spec ?? {}) as PodSpec;

  // Each referenced ConfigMap/Secret is fetched once per call. The cache holds
  // promises so concurrent resolvers share one in-flight fetch per ref.
  const cache = new Map<string, Promise<KubeObject | null>>();
  const fetchRef = (plural: 'configmaps' | 'secrets', name: string): Promise<KubeObject | null> => {
    const key = `${plural}/${name}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = handle.raw.json<KubeObject>(resourcePath('', 'v1', plural, { namespace, name })).catch(() => null);
      cache.set(key, pending);
    }
    return pending;
  };

  const secretValue = (raw: string): string => (reveal ? Buffer.from(raw, 'base64').toString('utf8') : REDACTED);

  const resolveFieldRef = (fieldPath: string): string | undefined => {
    const meta = pod.metadata;
    const status = (pod.status ?? {}) as { podIP?: string; hostIP?: string; podIPs?: Array<{ ip: string }> };
    const keyed = KEYED_FIELD_REF_RE.exec(fieldPath);
    if (keyed) {
      const map = keyed[1] === 'labels' ? meta.labels : meta.annotations;
      return map?.[keyed[2]!];
    }
    switch (fieldPath) {
      case 'metadata.name':
        return meta.name;
      case 'metadata.namespace':
        return meta.namespace;
      case 'metadata.uid':
        return meta.uid;
      case 'spec.nodeName':
        return spec.nodeName;
      case 'spec.serviceAccountName':
        return spec.serviceAccountName;
      case 'status.podIP':
        return status.podIP;
      case 'status.hostIP':
        return status.hostIP;
      case 'status.podIPs':
        return status.podIPs?.map((p) => p.ip).join(',');
      default:
        return undefined;
    }
  };

  const resolveResourceFieldRef = (container: ContainerSpec, ref: NonNullable<EnvVarSource['resourceFieldRef']>): { value?: string; error?: string } => {
    const target = ref.containerName ? [...(spec.containers ?? []), ...(spec.initContainers ?? [])].find((c) => c.name === ref.containerName) : container;
    const [bucket, resource] = ref.resource.split('.', 2) as ['limits' | 'requests', string];
    const raw = target?.resources?.[bucket]?.[resource ?? ''];
    if (raw === undefined) return { error: `${ref.resource} not set (defaults to node allocatable)` };
    const divisor = parseQuantity(ref.divisor || '1') || 1;
    const value = parseQuantity(raw) / divisor;
    return { value: String(Number.isInteger(value) ? value : Math.ceil(value)) };
  };

  // Entries resolve concurrently into per-entry ordered slots, so the output
  // order matches the spec exactly as the sequential version did.
  const resolveContainer = async (container: ContainerSpec): Promise<PodEnvVar[]> => {
    const fromSlots = await Promise.all(
      (container.envFrom ?? []).map(async (from): Promise<PodEnvVar[]> => {
        const isSecret = !!from.secretRef;
        const refName = from.configMapRef?.name ?? from.secretRef?.name;
        if (!refName) return [];
        const sourceType = isSecret ? 'secretRef' : 'configMapRef';
        const obj = await fetchRef(isSecret ? 'secrets' : 'configmaps', refName);
        if (!obj) {
          const optional = from.configMapRef?.optional ?? from.secretRef?.optional;
          if (!optional) return [{ name: `${from.prefix ?? ''}*`, source: { type: sourceType, ref: refName }, error: `${isSecret ? 'secret' : 'configmap'} ${refName} not found` }];
          return [];
        }
        const data = (obj.data ?? {}) as Record<string, string>;
        return Object.entries(data).map(([key, raw]) => ({
          name: `${from.prefix ?? ''}${key}`,
          value: isSecret ? secretValue(raw) : raw,
          source: { type: sourceType, ref: refName, key },
          redacted: isSecret || undefined,
        }));
      }),
    );

    const envSlots = await Promise.all(
      (container.env ?? []).map(async (env): Promise<PodEnvVar[]> => {
        if (env.value !== undefined) {
          return [{ name: env.name, value: env.value, source: { type: 'literal' } }];
        }
        const vf = env.valueFrom;
        if (vf?.configMapKeyRef) {
          const { name: refName, key, optional } = vf.configMapKeyRef;
          const obj = await fetchRef('configmaps', refName);
          const raw = (obj?.data as Record<string, string> | undefined)?.[key];
          if (raw === undefined) {
            return optional ? [] : [{ name: env.name, source: { type: 'configMapKeyRef', ref: refName, key }, error: `configmap key ${refName}/${key} not found` }];
          }
          return [{ name: env.name, value: raw, source: { type: 'configMapKeyRef', ref: refName, key } }];
        }
        if (vf?.secretKeyRef) {
          const { name: refName, key, optional } = vf.secretKeyRef;
          const obj = await fetchRef('secrets', refName);
          const raw = (obj?.data as Record<string, string> | undefined)?.[key];
          if (raw === undefined) {
            return optional ? [] : [{ name: env.name, source: { type: 'secretKeyRef', ref: refName, key }, error: `secret key ${refName}/${key} not found` }];
          }
          return [{ name: env.name, value: secretValue(raw), source: { type: 'secretKeyRef', ref: refName, key }, redacted: true }];
        }
        if (vf?.fieldRef) {
          const value = resolveFieldRef(vf.fieldRef.fieldPath);
          return [{ name: env.name, value, source: { type: 'fieldRef', key: vf.fieldRef.fieldPath }, error: value === undefined ? 'unresolvable fieldPath' : undefined }];
        }
        if (vf?.resourceFieldRef) {
          const { value, error } = resolveResourceFieldRef(container, vf.resourceFieldRef);
          return [{ name: env.name, value, source: { type: 'resourceFieldRef', key: vf.resourceFieldRef.resource }, error }];
        }
        return [{ name: env.name, error: 'unknown valueFrom source' }];
      }),
    );

    return [...fromSlots.flat(), ...envSlots.flat()];
  };

  const [initContainers, mainContainers] = await Promise.all([
    Promise.all((spec.initContainers ?? []).map(async (c) => ({ name: c.name, init: true, env: await resolveContainer(c) }))),
    Promise.all((spec.containers ?? []).map(async (c) => ({ name: c.name, env: await resolveContainer(c) }))),
  ]);
  const containers: PodEnvResponse['containers'] = [...initContainers, ...mainContainers];
  return { containers };
}
