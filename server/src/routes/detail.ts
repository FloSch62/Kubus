import { X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { KubeObject, LogTargetKind, LogTargetPodsResponse, PodEnvResponse, SecretTlsResponse, TlsCertInfo } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { podContainers } from '../kube/actions.js';
import { getRolloutHistory } from '../kube/rollout.js';
import { resolvePodEnv } from '../kube/pod-env.js';
import { resourcePath } from '../kube/raw-client.js';
import { resolveTargetPods } from '../kube/target-pods.js';
import { HttpProblem, sendError } from '../util/errors.js';

const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Secret data keys that may hold public certificate chains. */
const TLS_CERT_KEYS = ['tls.crt', 'ca.crt', 'ca.tls'];

function publicKeyAlgorithm(cert: X509Certificate): string | undefined {
  try {
    const key = cert.publicKey;
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType === 'rsa' || key.asymmetricKeyType === 'rsa-pss') {
      return details?.modulusLength ? `RSA ${details.modulusLength}` : 'RSA';
    }
    if (key.asymmetricKeyType === 'ec') return details?.namedCurve ? `ECDSA ${details.namedCurve}` : 'ECDSA';
    return key.asymmetricKeyType?.toUpperCase();
  } catch {
    return undefined;
  }
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
      const pods = await resolveTargetPods(handle, target, kind, namespace);
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
        if (kind !== 'Deployment' && kind !== 'StatefulSet' && kind !== 'DaemonSet') throw new HttpProblem(422, 'kind must be Deployment, StatefulSet or DaemonSet');
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
        const data = secret.data as Record<string, string> | undefined;
        if (!data?.['tls.crt']) throw new HttpProblem(422, 'secret has no tls.crt');
        // Only public certificate chains are parsed; tls.key is never read.
        // Additional CA entries (ca.crt, or ca.tls as some tools write) ride along.
        const certificates: TlsCertInfo[] = [];
        for (const key of TLS_CERT_KEYS) {
          const encoded = data[key];
          if (!encoded) continue;
          const pem = Buffer.from(encoded, 'base64').toString('utf8');
          for (const block of pem.match(CERT_BLOCK_RE) ?? []) {
            let cert: X509Certificate;
            try {
              cert = new X509Certificate(block);
            } catch {
              // A malformed block (often a hand-edited ca.crt) must not hide
              // the certificates that did parse.
              continue;
            }
            certificates.push({
              subject: cert.subject,
              issuer: cert.issuer,
              serialNumber: cert.serialNumber,
              notBefore: new Date(cert.validFrom).toISOString(),
              notAfter: new Date(cert.validTo).toISOString(),
              sans: cert.subjectAltName ? cert.subjectAltName.split(',').map((s) => s.trim()) : [],
              isCA: cert.ca,
              selfSigned: cert.subject === cert.issuer,
              publicKeyAlgorithm: publicKeyAlgorithm(cert),
              source: key,
            });
          }
        }
        const response: SecretTlsResponse = { certificates };
        return response;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );
}
