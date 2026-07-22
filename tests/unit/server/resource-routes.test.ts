import Fastify from 'fastify';
import { ApiException } from '@kubernetes/client-node';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerResourceRoutes } from '../../../server/src/routes/resources';
import { HttpProblem } from '../../../server/src/util/errors';

const podKind: ResourceKindInfo = {
  group: '',
  version: 'v1',
  kind: 'Pod',
  plural: 'pods',
  namespaced: true,
  verbs: ['get', 'list', 'create', 'update', 'delete'],
};
const deploymentKind: ResourceKindInfo = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
  plural: 'deployments',
  namespaced: true,
  verbs: ['get', 'list', 'create', 'update', 'delete'],
};
const nodeKind: ResourceKindInfo = {
  group: '',
  version: 'v1',
  kind: 'Node',
  plural: 'nodes',
  namespaced: false,
  verbs: ['get', 'list', 'update'],
};

function manifest(kind = 'Pod', name = 'web', namespace?: string): KubeObject {
  return {
    apiVersion: kind === 'Deployment' ? 'apps/v1' : 'v1',
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}) },
  } as KubeObject;
}

function apiError(code: number, body: unknown, message = 'request failed'): ApiException<unknown> {
  return new ApiException(code, message, body, {});
}

describe('resource routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  let rawJson: ReturnType<typeof vi.fn>;
  let getResources: ReturnType<typeof vi.fn>;
  let replace: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let handle: ClusterHandle;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    rawJson = vi.fn(async () => ({}));
    getResources = vi.fn(async () => [podKind, deploymentKind, nodeKind]);
    replace = vi.fn(async (value) => value);
    create = vi.fn(async (value) => value);
    handle = {
      contextName: 'kind-a',
      raw: { json: rawJson },
      discovery: { getResources },
      objects: { replace, create },
    } as unknown as ClusterHandle;
    const clusters = {
      get: vi.fn((ctx: string) => {
        if (ctx === 'bad') throw new HttpProblem(409, 'not connected', 'NotConnected');
        return handle;
      }),
    };
    app = Fastify();
    apps.push(app);
    registerResourceRoutes(app, { clusters } as unknown as AppContext);
    await app.ready();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
  });

  it('lists resources with selectors, paging, managed-field cleanup, and secret redaction', async () => {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'credentials', namespace: 'default', managedFields: [{ manager: 'kubectl' }] },
      data: { password: 'c2VjcmV0' },
      stringData: { token: 'plain' },
    };
    rawJson.mockResolvedValueOnce({ metadata: { resourceVersion: '10', continue: 'next' }, items: [secret] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/contexts/kind-a/resources/core/v1/secrets?namespace=default&labelSelector=app%3Dweb&fieldSelector=status.phase%3DRunning&limit=20&continue=old',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [expect.objectContaining({ data: { password: '••••••••' }, stringData: { token: '••••••••' } })],
      resourceVersion: '10',
      continue: 'next',
    });
    expect(response.json().items[0].metadata.managedFields).toBeUndefined();
    expect(rawJson.mock.calls[0]![0]).toContain('/api/v1/namespaces/default/secrets?');
    expect(rawJson.mock.calls[0]![0]).toContain('labelSelector=app%3Dweb');
    expect(rawJson.mock.calls[0]![0]).toContain('fieldSelector=status.phase%3DRunning');
    expect(rawJson.mock.calls[0]![0]).toContain('limit=20');
    expect(rawJson.mock.calls[0]![0]).toContain('continue=old');
  });

  it('uses list defaults and returns empty metadata safely', async () => {
    rawJson.mockResolvedValueOnce({});
    const response = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/resources/apps/v1/deployments' });
    expect(response.json()).toEqual({ items: [] });
    expect(rawJson.mock.calls[0]![0]).toContain('limit=2000');
  });

  it('reads one resource redacted by default and reveals it only on request', async () => {
    const secret = manifest('Secret', 'credentials', 'default');
    Object.assign(secret, { data: { password: 'c2VjcmV0' } });
    rawJson.mockResolvedValue(secret);
    const hidden = await app.inject({
      method: 'GET',
      url: '/api/contexts/kind-a/resources/core/v1/secrets/credentials?namespace=default',
    });
    expect(hidden.json().data.password).toBe('••••••••');
    const revealed = await app.inject({
      method: 'GET',
      url: '/api/contexts/kind-a/resources/core/v1/secrets/credentials?namespace=default&reveal=true',
    });
    expect(revealed.json().data.password).toBe('c2VjcmV0');
  });

  it('replaces matching manifests and fills a missing namespace from the URL', async () => {
    const body = manifest('Deployment', 'web');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/resources/apps/v1/deployments/web?namespace=apps',
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ metadata: { name: 'web', namespace: 'apps' } }));

    getResources.mockResolvedValueOnce([{ ...deploymentKind, version: 'v1beta1' }]);
    const fallback = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/resources/apps/v1beta1/deployments/web?namespace=apps',
      payload: body,
    });
    expect(fallback.statusCode).toBe(200);
  });

  it.each([
    ['invalid scalar', 'plain text', 'application/yaml', 'body must be a single YAML/JSON object'],
    ['missing identity', { metadata: { name: 'web' } }, 'application/json', 'manifest must have apiVersion'],
    ['unknown kind', { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'web' } }, 'application/json', 'not available'],
    ['wrong plural', manifest('Pod', 'web', 'apps'), 'application/json', 'not the deployments.apps'],
    ['wrong name', manifest('Deployment', 'other', 'apps'), 'application/json', 'not "web"'],
    ['wrong namespace', manifest('Deployment', 'web', 'other'), 'application/json', 'not "apps"'],
  ])('rejects %s on replace', async (_label, payload, contentType, expected) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/resources/apps/v1/deployments/web?namespace=apps',
      headers: { 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain(expected);
  });

  it('returns the current server object on an update conflict, even when reread fails', async () => {
    replace.mockRejectedValue(apiError(409, { reason: 'Conflict' }));
    rawJson.mockResolvedValueOnce(manifest('Deployment', 'web', 'apps'));
    const first = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/resources/apps/v1/deployments/web?namespace=apps',
      payload: manifest('Deployment', 'web', 'apps'),
    });
    expect(first.statusCode).toBe(409);
    expect(first.json()).toEqual(expect.objectContaining({ reason: 'Conflict', current: expect.objectContaining({ kind: 'Deployment' }) }));

    rawJson.mockRejectedValueOnce(new Error('reread failed'));
    const second = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/resources/apps/v1/deployments/web?namespace=apps',
      payload: manifest('Deployment', 'web', 'apps'),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().current).toBeUndefined();
  });

  it('creates JSON and YAML manifests and rejects invalid create bodies', async () => {
    const json = await app.inject({ method: 'POST', url: '/api/contexts/kind-a/resources', payload: manifest() });
    expect(json.statusCode).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Pod' }));

    const yaml = ['apiVersion: v1', 'kind: Pod', 'metadata:', '  name: yaml-pod', ''].join('\n');
    const yamlResponse = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/resources',
      headers: { 'content-type': 'application/yaml' },
      payload: yaml,
    });
    expect(yamlResponse.statusCode).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { name: 'yaml-pod' } }));

    const invalid = await app.inject({ method: 'POST', url: '/api/contexts/kind-a/resources', payload: [] });
    expect(invalid.statusCode).toBe(422);
  });

  it('dry-runs existing resources with PUT and warns about an inferred default namespace', async () => {
    rawJson.mockResolvedValueOnce(manifest()).mockResolvedValueOnce(manifest());
    const response = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/resources/dry-run',
      payload: manifest(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        ref: expect.objectContaining({ namespace: 'default', plural: 'pods' }),
        findings: [expect.objectContaining({ severity: 'warning', field: 'metadata.namespace' })],
      }),
    );
    expect(rawJson.mock.calls[1]![0]).toContain('/namespaces/default/pods/web?dryRun=All&fieldValidation=Strict');
    expect(rawJson.mock.calls[1]![1]).toEqual(expect.objectContaining({ method: 'PUT', body: expect.stringContaining('kind: Pod') }));
  });

  it('dry-runs new resources with POST and converts detailed API validation causes', async () => {
    rawJson
      .mockRejectedValueOnce(apiError(404, { reason: 'NotFound' }))
      .mockRejectedValueOnce(
        apiError(422, {
          message: 'invalid object',
          reason: 'Invalid',
          details: { causes: [{ field: 'spec.containers[0].image', message: 'required', reason: 'FieldValueRequired' }] },
        }),
      );
    const response = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/resources/dry-run',
      headers: { 'content-type': 'text/yaml' },
      payload: ['apiVersion: v1', 'kind: Pod', 'metadata:', '  name: web', '  namespace: apps', ''].join('\n'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: false,
        findings: [
          {
            severity: 'error',
            field: 'spec.containers[0].image',
            message: 'required',
            reason: 'FieldValueRequired',
          },
        ],
      }),
    );
    expect(rawJson.mock.calls[1]![1]).toEqual(expect.objectContaining({ method: 'POST', body: expect.stringContaining('metadata:') }));
  });

  it('uses a single fallback validation finding and propagates non-API read errors', async () => {
    rawJson.mockResolvedValueOnce(manifest()).mockRejectedValueOnce(apiError(422, { reason: 'Invalid' }, 'bad manifest'));
    const validation = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/resources/dry-run',
      payload: manifest('Pod', 'web', 'apps'),
    });
    expect(validation.json().findings).toEqual([
      { severity: 'error', reason: 'Invalid', message: expect.stringContaining('bad manifest') },
    ]);

    rawJson.mockRejectedValueOnce(new Error('transport down'));
    const failure = await app.inject({ method: 'POST', url: '/api/contexts/kind-a/resources/dry-run', payload: manifest() });
    expect(failure.statusCode).toBe(500);
    expect(failure.json().message).toBe('transport down');
  });

  it('deletes with Kubernetes options and maps connection errors consistently', async () => {
    rawJson.mockResolvedValueOnce({ kind: 'Status', status: 'Success' });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/contexts/kind-a/resources/core/v1/pods/web?namespace=apps&gracePeriodSeconds=5&propagationPolicy=Foreground',
    });
    expect(response.statusCode).toBe(200);
    expect(rawJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/namespaces/apps/pods/web?gracePeriodSeconds=5&propagationPolicy=Foreground'),
      { method: 'DELETE' },
    );

    const bad = await app.inject({ method: 'GET', url: '/api/contexts/bad/resources/core/v1/pods' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().reason).toBe('NotConnected');
  });

  it('returns CRD printer columns and degrades missing CRDs to an empty list', async () => {
    rawJson.mockResolvedValueOnce({
      spec: {
        versions: [
          {
            name: 'v1',
            additionalPrinterColumns: [
              { name: 'Ready', type: 'boolean', jsonPath: '.status.ready' },
              { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
              { name: 'Odd', type: 'object', jsonPath: '.status.odd' },
            ],
          },
        ],
      },
    });
    const columns = await app.inject({
      method: 'GET',
      url: '/api/contexts/kind-a/printer-columns/example.com/v1/widgets',
    });
    expect(columns.json()).toEqual([
      { name: 'Ready', type: 'boolean', jsonPath: '.status.ready' },
      { name: 'Odd', type: 'string', jsonPath: '.status.odd' },
    ]);
  });
});
