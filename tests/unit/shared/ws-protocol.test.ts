import { describe, expect, it } from 'vitest';
import { execClientControlSchema, logSocketQuerySchema, watchClientMessageSchema } from '@kubus/shared/ws-protocol';

describe('watchClientMessageSchema', () => {
  const sub = {
    op: 'sub',
    id: 'w1',
    ctx: 'kind-a',
    group: 'apps',
    version: 'v1',
    plural: 'deployments',
    namespace: 'default',
  };

  it('parses a full sub message', () => {
    const result = watchClientMessageSchema.safeParse(sub);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(sub);
  });

  it('allows an empty group for core resources', () => {
    const result = watchClientMessageSchema.safeParse({ ...sub, group: '' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ group: '' });
  });

  it('allows omitting the namespace', () => {
    const { namespace: _namespace, ...clusterWide } = sub;
    const result = watchClientMessageSchema.safeParse(clusterWide);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(clusterWide);
  });

  it('strips unknown keys instead of failing', () => {
    const result = watchClientMessageSchema.safeParse({ ...sub, extra: 'ignored' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('extra');
  });

  it('parses an unsub message', () => {
    const result = watchClientMessageSchema.safeParse({ op: 'unsub', id: 'w1' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ op: 'unsub', id: 'w1' });
  });

  it('rejects unknown and missing ops', () => {
    expect(watchClientMessageSchema.safeParse({ ...sub, op: 'subscribe' }).success).toBe(false);
    const { op: _op, ...noOp } = sub;
    expect(watchClientMessageSchema.safeParse(noOp).success).toBe(false);
  });

  it('rejects sub messages with missing required fields', () => {
    const { ctx: _ctx, ...noCtx } = sub;
    expect(watchClientMessageSchema.safeParse(noCtx).success).toBe(false);
    const { plural: _plural, ...noPlural } = sub;
    expect(watchClientMessageSchema.safeParse(noPlural).success).toBe(false);
  });

  it('rejects empty strings where min length applies', () => {
    expect(watchClientMessageSchema.safeParse({ ...sub, id: '' }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ ...sub, ctx: '' }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ ...sub, version: '' }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ ...sub, plural: '' }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ op: 'unsub', id: '' }).success).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(watchClientMessageSchema.safeParse({ ...sub, id: 42 }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ ...sub, namespace: 42 }).success).toBe(false);
    expect(watchClientMessageSchema.safeParse({ op: 'unsub', id: null }).success).toBe(false);
  });

  it('rejects unsub messages without an id', () => {
    expect(watchClientMessageSchema.safeParse({ op: 'unsub' }).success).toBe(false);
  });

  it('rejects non-object payloads', () => {
    expect(watchClientMessageSchema.safeParse(null).success).toBe(false);
    expect(watchClientMessageSchema.safeParse('sub').success).toBe(false);
    expect(watchClientMessageSchema.safeParse([sub]).success).toBe(false);
  });
});

describe('execClientControlSchema', () => {
  it('parses a resize message', () => {
    const result = execClientControlSchema.safeParse({ op: 'resize', cols: 120, rows: 40 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ op: 'resize', cols: 120, rows: 40 });
  });

  it('strips unknown keys instead of failing', () => {
    const result = execClientControlSchema.safeParse({ op: 'resize', cols: 80, rows: 24, extra: true });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('extra');
  });

  it('requires positive integer dimensions', () => {
    expect(execClientControlSchema.safeParse({ op: 'resize', cols: 0, rows: 24 }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ op: 'resize', cols: 80, rows: -1 }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ op: 'resize', cols: 79.5, rows: 24 }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ op: 'resize', cols: '80', rows: 24 }).success).toBe(false);
  });

  it('rejects missing fields and unknown ops', () => {
    expect(execClientControlSchema.safeParse({ op: 'resize', cols: 80 }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ op: 'resize', rows: 24 }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ op: 'ping' }).success).toBe(false);
    expect(execClientControlSchema.safeParse({ cols: 80, rows: 24 }).success).toBe(false);
  });

  it('rejects non-object payloads', () => {
    expect(execClientControlSchema.safeParse(null).success).toBe(false);
    expect(execClientControlSchema.safeParse('resize').success).toBe(false);
  });
});

describe('logSocketQuerySchema', () => {
  it('parses a fixed pod session with defaults', () => {
    const result = logSocketQuerySchema.safeParse({ ctx: 'kind-a', namespace: 'ops', pods: 'api-0,api-1,', token: 'ignored' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ctx: 'kind-a',
      namespace: 'ops',
      pods: ['api-0', 'api-1'],
      exclude: [],
      containers: undefined,
      container: undefined,
      follow: true,
      previous: false,
      tailLines: undefined,
      sinceSeconds: undefined,
      resumeAt: {},
    });
  });

  it('parses a followed workload session', () => {
    const result = logSocketQuerySchema.safeParse({
      ctx: 'kind-a',
      namespace: 'ops',
      target: 'Deployment',
      targetName: 'web',
      exclude: 'web-a',
      containers: 'app,sidecar',
      follow: 'false',
      previous: 'true',
      tailLines: '500',
      sinceSeconds: '600',
    });
    expect(result.data).toMatchObject({
      pods: [],
      target: 'Deployment',
      targetName: 'web',
      exclude: ['web-a'],
      containers: ['app', 'sidecar'],
      follow: false,
      previous: true,
      tailLines: 500,
      sinceSeconds: 600,
    });
  });

  it('keeps an empty container list distinct from no filter', () => {
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', pods: 'p', containers: '' }).data?.containers).toEqual([]);
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', pods: 'p', container: '' }).data?.container).toBeUndefined();
  });

  it('drops malformed resume cursors and counts', () => {
    const result = logSocketQuerySchema.safeParse({
      ctx: 'a',
      namespace: 'b',
      pods: 'p',
      tailLines: 'lots',
      sinceSeconds: '-5',
      resumeAt: JSON.stringify({ 'p/app': '2026-07-22T12:00:00.000000000Z', 'p/bad': 'yesterday', 'p/num': 5 }),
    });
    expect(result.data).toMatchObject({ tailLines: undefined, sinceSeconds: undefined, resumeAt: { 'p/app': '2026-07-22T12:00:00.000000000Z' } });
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', pods: 'p', resumeAt: '{oops' }).data?.resumeAt).toEqual({});
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', pods: 'p', resumeAt: '[1]' }).data?.resumeAt).toEqual({});
  });

  it('requires pods or a complete target', () => {
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b' }).success).toBe(false);
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', target: 'Deployment' }).success).toBe(false);
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', target: 'Pod', targetName: 'x' }).success).toBe(false);
    expect(logSocketQuerySchema.safeParse({ ctx: '', namespace: 'b', pods: 'p' }).success).toBe(false);
    expect(logSocketQuerySchema.safeParse({ ctx: 'a', namespace: 'b', target: 'Job', targetName: 'x' }).success).toBe(true);
  });
});
