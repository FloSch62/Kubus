import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { groupFromPath, type CordonRequest, type DebugPodRequest, type DrainRequest, type RerunJobRequest, type RolloutPauseRequest, type RolloutRestartRequest, type RolloutUndoRequest, type ScaleRequest, type SetImageRequest, type StopDebugRequest, type SuspendCronJobRequest } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { drainNode, rerunJob, rolloutRestart, scaleResource, setCordon, setCronJobSuspend, setImage, type DrainProgress } from '../kube/actions.js';
import { addDebugContainer, stopDebugContainer } from '../kube/debug.js';
import { rolloutUndo, setRolloutPaused } from '../kube/rollout.js';
import { sendError } from '../util/errors.js';
import { broadcastWatchMessage } from '../ws/watch-socket.js';

export function registerActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { ctx: string }; Body: ScaleRequest }>('/api/contexts/:ctx/actions/scale', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const b = req.body;
      await scaleResource(handle, groupFromPath(b.group), b.version, b.plural, b.namespace, b.name, b.replicas);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: RolloutRestartRequest }>('/api/contexts/:ctx/actions/rollout-restart', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await rolloutRestart(handle, req.body.kind, req.body.namespace, req.body.name);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: CordonRequest }>('/api/contexts/:ctx/actions/cordon', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await setCordon(handle, req.body.node, req.body.unschedulable);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: RolloutUndoRequest }>('/api/contexts/:ctx/actions/rollout-undo', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await rolloutUndo(handle, req.body.kind, req.body.namespace, req.body.name, req.body.toRevision);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: RolloutPauseRequest }>('/api/contexts/:ctx/actions/rollout-pause', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await setRolloutPaused(handle, req.body.namespace, req.body.name, req.body.paused);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: RerunJobRequest }>('/api/contexts/:ctx/actions/rerun-job', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await rerunJob(handle, req.body.namespace, req.body.name);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: SuspendCronJobRequest }>('/api/contexts/:ctx/actions/suspend-cronjob', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await setCronJobSuspend(handle, req.body.namespace, req.body.name, req.body.suspend);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: SetImageRequest }>('/api/contexts/:ctx/actions/set-image', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await setImage(handle, req.body);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: DebugPodRequest }>('/api/contexts/:ctx/actions/debug-pod', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await addDebugContainer(handle, req.body);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: StopDebugRequest }>('/api/contexts/:ctx/actions/stop-debug', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      await stopDebugContainer(handle, req.body);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: DrainRequest }>('/api/contexts/:ctx/actions/drain', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const drainId = nanoid(10);
      const report = (p: DrainProgress) => {
        broadcastWatchMessage({ op: 'drain-progress', drainId, evicted: p.evicted, total: p.total, current: p.current, done: p.done, error: p.error });
      };
      // Run async; progress + completion stream over the watch socket.
      void drainNode(handle, req.body.node, { gracePeriodSeconds: req.body.gracePeriodSeconds, force: req.body.force }, report).catch((err) => {
        app.log.warn({ err: String(err) }, 'drain failed');
        broadcastWatchMessage({ op: 'drain-progress', drainId, evicted: 0, total: 0, done: true, error: err instanceof Error ? err.message : String(err) });
      });
      return { drainId };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
