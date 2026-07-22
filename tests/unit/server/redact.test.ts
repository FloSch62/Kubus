import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { REDACTED, isSecretGVR, maybeRedact, redactSecretData } from '../../../server/src/kube/redact.js';

function secret(data?: Record<string, unknown>, stringData?: Record<string, unknown>): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'db-creds', namespace: 'prod', uid: 'u1' },
    type: 'Opaque',
    ...(data ? { data } : {}),
    ...(stringData ? { stringData } : {}),
  } as KubeObject;
}

describe('isSecretGVR', () => {
  it('matches only the core secrets resource', () => {
    expect(isSecretGVR('', 'secrets')).toBe(true);
    expect(isSecretGVR('', 'configmaps')).toBe(false);
    expect(isSecretGVR('', 'pods')).toBe(false);
  });

  it('does not match secrets plurals in non-core groups', () => {
    expect(isSecretGVR('bitnami.com', 'secrets')).toBe(false);
    expect(isSecretGVR('apps', 'secrets')).toBe(false);
  });
});

describe('redactSecretData', () => {
  it('replaces every data value while keeping the keys', () => {
    const out = redactSecretData(secret({ username: 'YWRtaW4=', password: 'aHVudGVyMg==' }));
    expect(out.data).toEqual({ username: REDACTED, password: REDACTED });
  });

  it('replaces stringData values too', () => {
    const out = redactSecretData(secret(undefined, { token: 'plaintext-token' }));
    expect((out as { stringData?: Record<string, unknown> }).stringData).toEqual({ token: REDACTED });
  });

  it('handles data and stringData on the same object', () => {
    const out = redactSecretData(secret({ a: 'eA==' }, { b: 'y' }));
    expect(out.data).toEqual({ a: REDACTED });
    expect((out as { stringData?: Record<string, unknown> }).stringData).toEqual({ b: REDACTED });
  });

  it('redacts non-string data values as well', () => {
    const out = redactSecretData(secret({ nested: { deep: 'value' } }));
    expect(out.data).toEqual({ nested: REDACTED });
  });

  it('leaves metadata and other fields intact', () => {
    const out = redactSecretData(secret({ key: 'dg==' }));
    expect(out.metadata).toEqual({ name: 'db-creds', namespace: 'prod', uid: 'u1' });
    expect(out.kind).toBe('Secret');
    expect(out.type).toBe('Opaque');
  });

  it('does not mutate the input object', () => {
    const input = secret({ password: 'aHVudGVyMg==' }, { token: 't' });
    redactSecretData(input);
    expect(input.data).toEqual({ password: 'aHVudGVyMg==' });
    expect((input as { stringData?: Record<string, unknown> }).stringData).toEqual({ token: 't' });
  });

  it('passes through objects without data or stringData', () => {
    const bare = secret();
    const out = redactSecretData(bare);
    expect(out).toEqual(bare);
  });

  it('handles empty data maps', () => {
    const input = secret();
    input.data = {};
    expect(redactSecretData(input).data).toEqual({});
  });
});

describe('maybeRedact', () => {
  it('redacts when the GVR is the core secrets resource', () => {
    const out = maybeRedact(secret({ password: 'aHVudGVyMg==' }), '', 'secrets');
    expect(out.data).toEqual({ password: REDACTED });
  });

  it('returns non-secret objects unchanged and by reference', () => {
    const cm: KubeObject = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-config', namespace: 'prod', uid: 'u2' },
      data: { 'app.yaml': 'log-level: debug' },
    };
    const out = maybeRedact(cm, '', 'configmaps');
    expect(out).toBe(cm);
    expect(out.data).toEqual({ 'app.yaml': 'log-level: debug' });
  });

  it('does not redact same-plural resources from other groups', () => {
    const cr = secret({ key: 'dmFsdWU=' });
    expect(maybeRedact(cr, 'example.com', 'secrets')).toBe(cr);
  });
});
