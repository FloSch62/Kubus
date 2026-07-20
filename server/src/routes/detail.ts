import { X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { KubeObject, LogTargetKind, LogTargetPodsResponse, PodEnvResponse, SecretTlsResponse, TlsCertInfo } from '@kubus/shared';
import type { AppContext } from '../app.js';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { podContainers } from '../kube/actions.js';
import { getRolloutHistory } from '../kube/rollout.js';
import { resolvePodEnv } from '../kube/pod-env.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem, sendError } from '../util/errors.js';

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }>;
}

const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function selectorToString(selector: LabelSelector | undefined): string | undefined {
  if (!selector) return undefined;
  const parts = Object.entries(selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const expr of selector.matchExpressions ?? []) {
    if (expr.operator === 'In') parts.push(`${expr.key} in (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'NotIn') parts.push(`${expr.key} notin (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'Exists') parts.push(expr.key);
    else if (expr.operator === 'DoesNotExist') parts.push(`!${expr.key}`);
  }
  return parts.length ? parts.join(',') : undefined;
}

async function listPods(handle: ClusterHandle, namespace: string, selector?: string): Promise<KubeObject[]> {
  const query = new URLSearchParams();
  if (selector) query.set('labelSelector', selector);
  const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath('', 'v1', 'pods', { namespace, query }));
  return list.items ?? [];
}

function owns(obj: KubeObject, uid: string | undefined): boolean {
  if (!uid) return false;
  return (obj.metadata.ownerReferences ?? []).some((owner) => owner.uid === uid && owner.controller);
}

async function resolveLogTargetPods(handle: ClusterHandle, target: KubeObject, kind: LogTargetKind, namespace: string): Promise<KubeObject[]> {
  if (kind === 'Pod') return [target];

  if (kind === 'Service') {
    const selector = (target.spec as { selector?: Record<string, string> } | undefined)?.selector;
    const labelSelector = selectorToString({ matchLabels: selector });
    return labelSelector ? listPods(handle, namespace, labelSelector) : [];
  }

  const selector = selectorToString((target.spec as { selector?: LabelSelector } | undefined)?.selector);
  if (kind === 'Job') {
    const pods = await listPods(handle, namespace, selector);
    return pods.filter((pod) => owns(pod, target.metadata.uid));
  }
  if (!selector) return [];

  if (kind === 'Deployment') {
    const query = new URLSearchParams({ labelSelector: selector });
    const [rsList, pods] = await Promise.all([
      handle.raw.json<{ items?: KubeObject[] }>(resourcePath('apps', 'v1', 'replicasets', { namespace, query })),
      listPods(handle, namespace, selector),
    ]);
    const rsUids = new Set((rsList.items ?? []).filter((rs) => owns(rs, target.metadata.uid)).map((rs) => rs.metadata.uid));
    return pods.filter((pod) => (pod.metadata.ownerReferences ?? []).some((owner) => rsUids.has(owner.uid) && owner.controller));
  }

  const pods = await listPods(handle, namespace, selector);
  return pods.filter((pod) => owns(pod, target.metadata.uid));
}

export function registerDetailRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string; name?: string; reveal?: string } }>(
    '/api/contexts/:ctx/detail/pod-env',
    async (req, reply) => {
      try {
        const { namespace, name } = req.query;
        if (!namespace || !name) throw new HttpProblem(422, 'namespace and name are required');
        const handle = ctx.clusters.get(req.params.ctx);
        const response: PodEnvResponse = await resolvePodEnv(handle, namespace, name, req.query.reveal === 'true');
        return response;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.get<{
    Params: { ctx: string };
    Querystring: { group?: string; version?: string; plural?: string; kind?: LogTargetKind; namespace?: string; name?: string };
  }>('/api/contexts/:ctx/detail/log-target-pods', async (req, reply) => {
    try {
      const { group = '', version, plural, kind, namespace, name } = req.query;
      if (!version || !plural || !kind || !namespace || !name) throw new HttpProblem(422, 'group, version, plural, kind, namespace and name are required');
      const handle = ctx.clusters.get(req.params.ctx);
      const target = await handle.raw.json<KubeObject>(resourcePath(group, version, plural, { namespace, name }));
      const pods = await resolveLogTargetPods(handle, target, kind, namespace);
      const response: LogTargetPodsResponse = {
        pods: pods
          .map((pod) => ({
            name: pod.metadata.name,
            namespace: pod.metadata.namespace ?? namespace,
            containers: podContainers(pod),
          }))
          .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
      };
      return response;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { kind?: string; namespace?: string; name?: string } }>(
    '/api/contexts/:ctx/detail/rollout-history',
    async (req, reply) => {
      try {
        const { kind, namespace, name } = req.query;
        if (!kind || !namespace || !name) throw new HttpProblem(422, 'kind, namespace and name are required');
        if (kind !== 'Deployment' && kind !== 'StatefulSet') throw new HttpProblem(422, 'kind must be Deployment or StatefulSet');
        const handle = ctx.clusters.get(req.params.ctx);
        return await getRolloutHistory(handle, kind, namespace, name);
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string; name?: string } }>(
    '/api/contexts/:ctx/detail/secret-tls',
    async (req, reply) => {
      try {
        const { namespace, name } = req.query;
        if (!namespace || !name) throw new HttpProblem(422, 'namespace and name are required');
        const handle = ctx.clusters.get(req.params.ctx);
        const secret = await handle.raw.json<KubeObject>(resourcePath('', 'v1', 'secrets', { namespace, name }));
        if (secret.type !== 'kubernetes.io/tls') throw new HttpProblem(422, 'secret is not of type kubernetes.io/tls');
        const crt = (secret.data as Record<string, string> | undefined)?.['tls.crt'];
        if (!crt) throw new HttpProblem(422, 'secret has no tls.crt');
        // Only the public certificate chain is parsed; tls.key is never read.
        const pem = Buffer.from(crt, 'base64').toString('utf8');
        const blocks = pem.match(CERT_BLOCK_RE) ?? [];
        const certificates: TlsCertInfo[] = blocks.map((block) => {
          const cert = new X509Certificate(block);
          return {
            subject: cert.subject,
            issuer: cert.issuer,
            serialNumber: cert.serialNumber,
            notBefore: new Date(cert.validFrom).toISOString(),
            notAfter: new Date(cert.validTo).toISOString(),
            sans: cert.subjectAltName ? cert.subjectAltName.split(',').map((s) => s.trim()) : [],
            isCA: cert.ca,
            selfSigned: cert.subject === cert.issuer,
          };
        });
        const response: SecretTlsResponse = { certificates };
        return response;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );
}
