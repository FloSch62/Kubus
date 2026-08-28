import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
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
import { registerLogRoutes } from './routes/logs.js';
import { broadcastWatchMessage, registerWatchSocket } from './ws/watch-socket.js';
import { registerLogsSocket } from './ws/logs-socket.js';
import { registerExecSocket } from './ws/exec-socket.js';
import { registerNodeShellSocket } from './ws/node-shell-socket.js';
import { ExecSessionRegistry } from './ws/transferable-exec.js';
import { HelmOperationManager } from './helm/operations.js';
import { appLogPinoSink } from './logging/log-buffer.js';

export interface AppContext {
  config: ServerConfig;
  clusters: ClusterManager;
  portForwards: PortForwardManager;
  sshTunnels: SshTunnelManager;
  settings: SettingsStore;
  helmOperations: HelmOperationManager;
  execSessions: ExecSessionRegistry;
  /** Raw --kubeconfig CLI flag (cleared when the user resets the override). */
  cliKubeconfig: string | undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The level the server returns to when debug logging is switched off. */
export function baseLogLevel(): string {
  return process.env.LOG_LEVEL ?? 'info';
}

/** Mirror every accepted pino record to the console and in-memory log viewer. */
function buildLogger(config: ServerConfig): FastifyBaseLogger {
  const console = config.prettyLogs
    ? (pino.transport({ target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }) as pino.DestinationStream)
    : process.stdout;
  return pino(
    { level: baseLogLevel() },
    pino.multistream([
      { level: 'trace', stream: console },
      { level: 'trace', stream: appLogPinoSink() },
    ]),
  ) as FastifyBaseLogger;
}

export async function buildApp(config: ServerConfig): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    loggerInstance: buildLogger(config),
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
  const execSessions = new ExecSessionRegistry();
  const ctx: AppContext = { config, clusters, portForwards, sshTunnels, settings, helmOperations, execSessions, cliKubeconfig: config.kubeconfigOverride };

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
    // The renderer disappears with the desktop window and cannot always
    // complete a WebSocket close handshake. Terminate sockets during server
    // shutdown so app.close() cannot wait forever for an absent peer.
    preClose(done) {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close(done);
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
  registerLogRoutes(app);
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
    execSessions.dispose();
    portForwards.stopAll();
    clusters.dispose();
    sshTunnels.stopAll();
  });

  return { app, ctx };
}
