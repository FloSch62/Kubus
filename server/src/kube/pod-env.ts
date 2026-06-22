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

/**
 * Resolve a pod's effective environment variables, expanding ConfigMap and
 * Secret references server-side. Secret-sourced values are replaced with the
 * redaction placeholder unless `reveal` is set — raw secret data never leaves
 * the server otherwise (same contract as the Secret resource route).
 */
export async function resolvePodEnv(handle: ClusterHandle, namespace: string, podName: string, reveal: boolean): Promise<PodEnvResponse> {
  const pod = await handle.raw.json<KubeObject>(resourcePath('', 'v1', 'pods', { namespace, name: podName }));
  const spec = (pod.spec ?? {}) as PodSpec;

  // Each referenced ConfigMap/Secret is fetched once per call.
  const cache = new Map<string, KubeObject | null>();
  const fetchRef = async (plural: 'configmaps' | 'secrets', name: string): Promise<KubeObject | null> => {
    const key = `${plural}/${name}`;
    if (!cache.has(key)) {
      const obj = await handle.raw.json<KubeObject>(resourcePath('', 'v1', plural, { namespace, name })).catch(() => null);
      cache.set(key, obj);
    }
    return cache.get(key)!;
  };

  const secretValue = (raw: string): string => (reveal ? Buffer.from(raw, 'base64').toString('utf8') : REDACTED);

  const resolveFieldRef = (fieldPath: string): string | undefined => {
    const meta = pod.metadata;
    const status = (pod.status ?? {}) as { podIP?: string; hostIP?: string; podIPs?: Array<{ ip: string }> };
    const keyed = /^metadata\.(labels|annotations)\['([^']+)'\]$/.exec(fieldPath);
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

  const resolveContainer = async (container: ContainerSpec): Promise<PodEnvVar[]> => {
    const out: PodEnvVar[] = [];

    for (const from of container.envFrom ?? []) {
      const isSecret = !!from.secretRef;
      const refName = from.configMapRef?.name ?? from.secretRef?.name;
      if (!refName) continue;
      const sourceType = isSecret ? 'secretRef' : 'configMapRef';
      const obj = await fetchRef(isSecret ? 'secrets' : 'configmaps', refName);
      if (!obj) {
        const optional = from.configMapRef?.optional ?? from.secretRef?.optional;
        if (!optional) out.push({ name: `${from.prefix ?? ''}*`, source: { type: sourceType, ref: refName }, error: `${isSecret ? 'secret' : 'configmap'} ${refName} not found` });
        continue;
      }
      const data = (obj.data ?? {}) as Record<string, string>;
      for (const [key, raw] of Object.entries(data)) {
        out.push({
          name: `${from.prefix ?? ''}${key}`,
          value: isSecret ? secretValue(raw) : raw,
          source: { type: sourceType, ref: refName, key },
          redacted: isSecret || undefined,
        });
      }
    }

    for (const env of container.env ?? []) {
      if (env.value !== undefined) {
        out.push({ name: env.name, value: env.value, source: { type: 'literal' } });
        continue;
      }
      const vf = env.valueFrom;
      if (vf?.configMapKeyRef) {
        const { name: refName, key, optional } = vf.configMapKeyRef;
        const obj = await fetchRef('configmaps', refName);
        const raw = (obj?.data as Record<string, string> | undefined)?.[key];
        if (raw === undefined) {
          if (!optional) out.push({ name: env.name, source: { type: 'configMapKeyRef', ref: refName, key }, error: `configmap key ${refName}/${key} not found` });
        } else {
          out.push({ name: env.name, value: raw, source: { type: 'configMapKeyRef', ref: refName, key } });
        }
      } else if (vf?.secretKeyRef) {
        const { name: refName, key, optional } = vf.secretKeyRef;
        const obj = await fetchRef('secrets', refName);
        const raw = (obj?.data as Record<string, string> | undefined)?.[key];
        if (raw === undefined) {
          if (!optional) out.push({ name: env.name, source: { type: 'secretKeyRef', ref: refName, key }, error: `secret key ${refName}/${key} not found` });
        } else {
          out.push({ name: env.name, value: secretValue(raw), source: { type: 'secretKeyRef', ref: refName, key }, redacted: true });
        }
      } else if (vf?.fieldRef) {
        const value = resolveFieldRef(vf.fieldRef.fieldPath);
        out.push({ name: env.name, value, source: { type: 'fieldRef', key: vf.fieldRef.fieldPath }, error: value === undefined ? 'unresolvable fieldPath' : undefined });
      } else if (vf?.resourceFieldRef) {
        const { value, error } = resolveResourceFieldRef(container, vf.resourceFieldRef);
        out.push({ name: env.name, value, source: { type: 'resourceFieldRef', key: vf.resourceFieldRef.resource }, error });
      } else {
        out.push({ name: env.name, error: 'unknown valueFrom source' });
      }
    }

    return out;
  };

  const containers: PodEnvResponse['containers'] = [];
  for (const c of spec.initContainers ?? []) {
    containers.push({ name: c.name, init: true, env: await resolveContainer(c) });
  }
  for (const c of spec.containers ?? []) {
    containers.push({ name: c.name, env: await resolveContainer(c) });
  }
  return { containers };
}
