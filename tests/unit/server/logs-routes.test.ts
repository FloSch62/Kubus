import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_AUTH_CHALLENGE } from '@kubus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { clearAppLog } from '../../../server/src/logging/log-buffer.js';

const TOKEN = 'logs-route-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeEach(async () => {
  clearAppLog();
  ({ app } = await buildApp(
    resolveConfig({
      token: TOKEN,
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  ));
});

afterEach(async () => {
  await app.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('log routes', () => {
  it('serves buffered server log entries', async () => {
    app.log.warn({ ctx: 'kind-dev' }, 'cluster probe failed');

    const response = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.debugEnabled).toBe(false);
    expect(body.capacity).toBeGreaterThan(0);
    expect(body.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        source: 'server',
        msg: 'cluster probe failed',
        context: { ctx: 'kind-dev' },
      }),
    );
  });

  it('captures debug records only after debug mode is enabled', async () => {
    app.log.debug('hidden detail');
    const before = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(before.json().entries).not.toContainEqual(expect.objectContaining({ msg: 'hidden detail' }));

    const put = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ debugEnabled: true });

    app.log.debug('visible detail');
    const after = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(after.json().debugEnabled).toBe(true);
    expect(after.json().entries).toContainEqual(expect.objectContaining({ level: 'debug', msg: 'visible detail' }));
  });

  it('restores the base level and leaves an audit trail when disabled', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: true },
    });
    const off = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: false },
    });
    expect(off.json()).toEqual({ debugEnabled: false });
    expect(app.log.level).toBe('info');

    const logs = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    const messages = logs.json().entries.map((entry: { msg: string }) => entry.msg);
    expect(messages).toContain('debug logging enabled');
    expect(messages).toContain('debug logging disabled');
  });

  it('rejects malformed settings, clears the buffer, and requires authentication', async () => {
    const malformed = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: 'yes' },
    });
    expect(malformed.statusCode).toBe(400);

    app.log.warn('to be cleared');
    const cleared = await app.inject({ method: 'DELETE', url: '/api/logs', headers: auth });
    expect(cleared.json()).toEqual({ cleared: true });
    const logs = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(logs.json().entries).not.toContainEqual(expect.objectContaining({ msg: 'to be cleared' }));

    const unauthorized = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(unauthorized.statusCode).toBe(401);
  });
});

describe('session auth guard', () => {
  it('marks its own 401 with the session challenge so the client can tell it from a cluster 401', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe(SESSION_AUTH_CHALLENGE);
    expect(missing.json()).toEqual({ message: 'unauthorized' });

    const wrong = await app.inject({ method: 'GET', url: '/api/logs', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe(SESSION_AUTH_CHALLENGE);

    const accepted = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['www-authenticate']).toBeUndefined();
  });
});
