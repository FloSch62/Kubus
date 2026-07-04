import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { PortForwardInfo, PortForwardRequest } from '@kubus/shared';
import type { ClusterManager } from './cluster-manager.js';
import { HttpProblem } from '../util/errors.js';

interface ActiveForward {
  info: PortForwardInfo;
  server: net.Server;
  sockets: Set<net.Socket>;
}

/**
 * Local TCP listeners forwarding into pods. One upstream Kubernetes
 * port-forward websocket per incoming TCP connection — the channelized
 * WS protocol does not multiplex independent streams reliably.
 */
export class PortForwardManager extends EventEmitter {
  private forwards = new Map<string, ActiveForward>();

  constructor(
    private clusters: ClusterManager,
    private log: FastifyBaseLogger,
  ) {
    super();
  }

  list(): PortForwardInfo[] {
    return [...this.forwards.values()].map((f) => ({ ...f.info, connections: f.sockets.size }));
  }

  async start(ctx: string, req: PortForwardRequest): Promise<PortForwardInfo> {
    const handle = this.clusters.get(ctx);
    const id = nanoid(10);

    // Validate the target up front so obvious errors fail the request.
    const target = await this.resolveTarget(ctx, req);

    const info: PortForwardInfo = {
      id,
      ctx,
      namespace: req.namespace,
      kind: req.kind,
      name: req.name,
      targetPod: target.pod,
      remotePort: req.remotePort,
      localPort: req.localPort ?? 0,
      state: 'active',
      connections: 0,
    };

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      void this.handleConnection(ctx, req, info, socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(info.localPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === 'object') info.localPort = address.port;

    this.forwards.set(id, { info, server, sockets });
    this.log.info({ id, ctx, target: `${req.namespace}/${req.name}:${req.remotePort}`, localPort: info.localPort }, 'port-forward started');
    this.emitUpdate();
    void handle; // handle validated above
    return { ...info };
  }

  private async handleConnection(ctx: string, req: PortForwardRequest, info: PortForwardInfo, socket: net.Socket): Promise<void> {
    try {
      const handle = this.clusters.get(ctx);
      // Re-resolve per connection so service forwards survive pod churn.
      const target = await this.resolveTarget(ctx, req);
      info.targetPod = target.pod;
      const errStream = new PassThrough();
      let errText = '';
      errStream.on('data', (chunk: Buffer) => {
        errText += chunk.toString('utf8');
      });
      const ws = await handle.makePortForward().portForward(req.namespace, target.pod, [target.port], socket, errStream, socket);
      info.state = 'active';
      info.error = undefined;
      this.emitUpdate();
      socket.on('close', () => {
        if (ws && typeof ws === 'object' && 'close' in ws) {
          try {
            (ws as { close: () => void }).close();
          } catch {
            /* already closed */
          }
        }
        if (errText.trim()) {
          info.state = 'error';
          info.error = errText.trim();
          this.emitUpdate();
        }
      });
    } catch (err) {
      info.state = 'error';
      info.error = err instanceof Error ? err.message : String(err);
      this.log.warn({ id: info.id, err: info.error }, 'port-forward connection failed');
      socket.destroy();
      this.emitUpdate();
    }
  }

  /**
   * Resolve the concrete pod and container port. Pod targets pass through;
   * service targets pick a ready endpoint pod and map the service port to
   * its targetPort (numeric or named), like kubectl does.
   */
  private async resolveTarget(ctx: string, req: PortForwardRequest): Promise<{ pod: string; port: number }> {
    if (req.kind === 'pod') return { pod: req.name, port: req.remotePort };
    const handle = this.clusters.get(ctx);

    const svcPromise = handle.core.readNamespacedService({ name: req.name, namespace: req.namespace });
    svcPromise.catch(() => undefined);
    const endpoints = await handle.core.readNamespacedEndpoints({ name: req.name, namespace: req.namespace });
    let podName: string | undefined;
    for (const subset of endpoints.subsets ?? []) {
      for (const addr of subset.addresses ?? []) {
        if (addr.targetRef?.kind === 'Pod' && addr.targetRef.name) {
          podName = addr.targetRef.name;
          break;
        }
      }
      if (podName) break;
    }
    if (!podName) throw new HttpProblem(503, `service "${req.namespace}/${req.name}" has no ready pod endpoints`);

    const svc = await svcPromise;
    const portSpec = (svc.spec?.ports ?? []).find((p) => p.port === req.remotePort);
    const targetPort = portSpec?.targetPort ?? req.remotePort;
    if (typeof targetPort === 'number') return { pod: podName, port: targetPort };

    // Named targetPort: look it up in the pod's container ports.
    const pod = await handle.core.readNamespacedPod({ name: podName, namespace: req.namespace });
    for (const container of pod.spec?.containers ?? []) {
      const match = (container.ports ?? []).find((p) => p.name === targetPort);
      if (match) return { pod: podName, port: match.containerPort };
    }
    throw new HttpProblem(422, `could not resolve named port "${targetPort}" on pod ${podName}`);
  }

  stop(id: string): void {
    const fwd = this.forwards.get(id);
    if (!fwd) throw new HttpProblem(404, `port-forward "${id}" not found`);
    for (const socket of fwd.sockets) socket.destroy();
    fwd.server.close();
    this.forwards.delete(id);
    this.emitUpdate();
  }

  stopAll(): void {
    for (const id of [...this.forwards.keys()]) {
      try {
        this.stop(id);
      } catch {
        /* already gone */
      }
    }
  }

  private emitUpdate(): void {
    this.emit('update', this.list());
  }
}
