import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { ServerConfig } from './config.js';
import { ClusterManager } from './kube/cluster-manager.js';
import { PortForwardManager } from './kube/portforward-manager.js';
import { SshTunnelManager } from './ssh/tunnel-manager.js';
import { SettingsStore } from './settings-store.js';
import { registerContextRoutes } from './routes/contexts.js';
import { registerAppRoutes } from './routes/app.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerDetailRoutes } from './routes/detail.js';
import { registerSchemaRoutes } from './routes/schema.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerNetworkMetricsRoutes } from './routes/network-metrics.js';
import { registerHelmRoutes } from './routes/helm.js';
import { registerPortForwardRoutes } from './routes/portforward.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerFileRoutes } from './routes/files.js';
import { broadcastWatchMessage, registerWatchSocket } from './ws/watch-socket.js';
import { registerLogsSocket } from './ws/logs-socket.js';
import { registerExecSocket } from './ws/exec-socket.js';
import { registerNodeShellSocket } from './ws/node-shell-socket.js';
import { HelmOperationManager } from './helm/operations.js';

export interface AppContext {
  config: ServerConfig;
  clusters: ClusterManager;
  portForwards: PortForwardManager;
  sshTunnels: SshTunnelManager;
  settings: SettingsStore;
  helmOperations: HelmOperationManager;
  /** Raw --kubeconfig CLI flag (cleared when the user resets the override). */
  cliKubeconfig: string | undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(config: ServerConfig): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: config.prettyLogs ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } : undefined,
    },
    // Resource lists can be large; YAML applies too.
    bodyLimit: 32 * 1024 * 1024,
  });

  const settings = new SettingsStore(app.log);
  // CLI flag > persisted UI setting > $KUBECONFIG > ~/.kube/config.
  const effectiveOverride = config.kubeconfigOverride ?? settings.load().kubeconfigPath;
  const sshTunnels = new SshTunnelManager(app.log, settings);
  const clusters = new ClusterManager(app.log, effectiveOverride, sshTunnels);
  const portForwards = new PortForwardManager(clusters, app.log);
  const helmOperations = new HelmOperationManager(app.log, (operation) => broadcastWatchMessage({ op: 'helm-operation', operation }));
  const ctx: AppContext = { config, clusters, portForwards, sshTunnels, settings, helmOperations, cliKubeconfig: config.kubeconfigOverride };

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 16 * 1024 * 1024,
      verifyClient: (info: { origin?: string; req: { url?: string; headers: Record<string, unknown> } }) => {
        // Origin check: only same-host browser pages (or non-browser clients
        // without an Origin header) may open sockets — DNS-rebinding defense.
        const origin = info.origin;
        if (origin) {
          try {
            const u = new URL(origin);
            if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
          } catch {
            return false;
          }
        }
        const url = new URL(info.req.url ?? '/', 'http://localhost');
        return url.searchParams.get('token') === config.token;
      },
    },
  });

  // Bearer-token auth for all /api routes.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    const ok = header === `Bearer ${config.token}`;
    if (!ok) {
      await reply.code(401).send({ message: 'unauthorized' });
    }
  });

  registerAppRoutes(app, ctx);
  registerContextRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerSshRoutes(app, ctx);
  registerResourceRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerDetailRoutes(app, ctx);
  registerSchemaRoutes(app, ctx);
  registerMetricsRoutes(app, ctx);
  registerNetworkMetricsRoutes(app, ctx);
  registerHelmRoutes(app, ctx);
  registerPortForwardRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerWatchSocket(app, ctx);
  registerLogsSocket(app, ctx);
  registerExecSocket(app, ctx);
  registerNodeShellSocket(app, ctx);

  // Serve the built client in production (same-origin, no CORS needed).
  const clientDist = config.staticRoot ?? path.resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        void reply.code(404).send({ message: 'not found' });
      } else {
        void reply.sendFile('index.html');
      }
    });
  }

  app.addHook('onClose', async () => {
    portForwards.stopAll();
    clusters.dispose();
    sshTunnels.stopAll();
  });

  return { app, ctx };
}
