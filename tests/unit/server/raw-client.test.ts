import { describe, expect, it } from 'vitest';
import { isRetryableTransportError, resourcePath } from '../../../server/src/kube/raw-client.js';

describe('resourcePath', () => {
  it('uses /api for the core group and /apis otherwise', () => {
    expect(resourcePath('', 'v1', 'nodes')).toBe('/api/v1/nodes');
    expect(resourcePath('apps', 'v1', 'deployments')).toBe('/apis/apps/v1/deployments');
    expect(resourcePath('networking.k8s.io', 'v1', 'ingresses')).toBe('/apis/networking.k8s.io/v1/ingresses');
  });

  it('inserts the namespace segment before the plural', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'kube-system' })).toBe('/api/v1/namespaces/kube-system/pods');
    expect(resourcePath('apps', 'v1', 'deployments', { namespace: 'default' })).toBe(
      '/apis/apps/v1/namespaces/default/deployments',
    );
  });

  it('appends name and subresource', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'ns', name: 'web-0', subresource: 'log' })).toBe(
      '/api/v1/namespaces/ns/pods/web-0/log',
    );
    expect(resourcePath('apps', 'v1', 'deployments', { namespace: 'default', name: 'web', subresource: 'scale' })).toBe(
      '/apis/apps/v1/namespaces/default/deployments/web/scale',
    );
  });

  it('percent-encodes namespace and name', () => {
    expect(resourcePath('', 'v1', 'pods', { namespace: 'a b', name: 'p:1' })).toBe('/api/v1/namespaces/a%20b/pods/p%3A1');
  });

  it('appends query parameters when present', () => {
    const query = new URLSearchParams({ labelSelector: 'owner=helm', limit: '500' });
    expect(resourcePath('', 'v1', 'secrets', { namespace: 'default', query })).toBe(
      '/api/v1/namespaces/default/secrets?labelSelector=owner%3Dhelm&limit=500',
    );
  });

  it('omits the question mark for an empty query', () => {
    expect(resourcePath('', 'v1', 'pods', { query: new URLSearchParams() })).toBe('/api/v1/pods');
  });
});

describe('isRetryableTransportError', () => {
  it.each(['ECONNABORTED', 'ECONNRESET', 'ENETRESET', 'EPIPE', 'ETIMEDOUT'])('retries %s', (code) => {
    expect(isRetryableTransportError(Object.assign(new Error('boom'), { code }))).toBe(true);
    expect(isRetryableTransportError({ code })).toBe(true);
  });

  it('rejects non-transport and unknown codes', () => {
    expect(isRetryableTransportError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isRetryableTransportError(Object.assign(new Error('tls'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }))).toBe(false);
    expect(isRetryableTransportError({ code: 500 })).toBe(false);
    expect(isRetryableTransportError(new Error('plain'))).toBe(false);
    expect(isRetryableTransportError('ECONNRESET')).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
    expect(isRetryableTransportError(null)).toBe(false);
  });

  it('unwraps nested causes up to three levels deep', () => {
    const wrap = (cause: unknown) => Object.assign(new Error('wrapped'), { cause });
    const reset = { code: 'ECONNRESET' };
    expect(isRetryableTransportError(wrap(reset))).toBe(true);
    expect(isRetryableTransportError(wrap(wrap(reset)))).toBe(true);
    expect(isRetryableTransportError(wrap(wrap(wrap(reset))))).toBe(true);
    // Depth cap: the fifth object in the chain is never inspected.
    expect(isRetryableTransportError(wrap(wrap(wrap(wrap(reset)))))).toBe(false);
  });
});
