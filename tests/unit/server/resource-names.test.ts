import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { MAX_NAMES, NAMES_ACCEPT, listResourceNames, namesFromPage } from '../../../server/src/kube/resource-names';
import { registerResourceRoutes } from '../../../server/src/routes/resources';

type RawJson = Parameters<typeof listResourceNames>[0];

function table(names: string[], cont?: string) {
  return {
    kind: 'Table',
    apiVersion: 'meta.k8s.io/v1',
    metadata: cont ? { continue: cont } : {},
    columnDefinitions: [
      { name: 'Created At', format: 'date-time' },
      { name: 'Name', format: 'name' },
    ],
    rows: names.map((name) => ({ cells: ['2026-09-29T00:00:00Z', name] })),
  };
}

describe('namesFromPage', () => {
  it('reads the name column of a Table without objects', () => {
    expect(namesFromPage(table(['b', 'a']))).toEqual(['b', 'a']);
  });

  it('falls back to metadata-only and plain lists', () => {
    expect(namesFromPage({ kind: 'PartialObjectMetadataList', items: [{ metadata: { name: 'web' } }, {}] })).toEqual(['web']);
    expect(namesFromPage({ kind: 'CustomResourceDefinitionList', items: [{ metadata: { name: 'x.example.io' } }] })).toEqual(['x.example.io']);
  });
});

describe('listResourceNames', () => {
  it('asks for a Table without objects and follows every page', async () => {
    const json = vi.fn().mockResolvedValueOnce(table(['web', 'api'], 'page-2')).mockResolvedValueOnce(table(['db']));
    const result = await listResourceNames({ json }, { group: 'apps', version: 'v1', plural: 'deployments' }, 'shop');
    expect(result).toEqual({ names: ['api', 'db', 'web'] });
    expect(json).toHaveBeenCalledTimes(2);
    const [firstPath, firstInit] = json.mock.calls[0]!;
    expect(firstPath).toMatch(/^\/apis\/apps\/v1\/namespaces\/shop\/deployments\?/);
    expect(firstPath).toContain('includeObject=None');
    expect(firstPath).toContain('limit=500');
    expect(firstInit).toEqual(expect.objectContaining({ headers: { accept: NAMES_ACCEPT } }));
    expect(json.mock.calls[1]![0]).toContain('continue=page-2');
  });

  it('stops at the cap and says the list is cut short', async () => {
    let page = 0;
    const json = vi.fn(async (_path: string) => {
      page += 1;
      return table(Array.from({ length: 500 }, (_, i) => `obj-${page}-${i}`), 'more');
    });
    const result = await listResourceNames({ json } as unknown as RawJson, { group: '', version: 'v1', plural: 'configmaps' });
    expect(result.truncated).toBe(true);
    expect(result.names).toHaveLength(MAX_NAMES);
    expect(json).toHaveBeenCalledTimes(MAX_NAMES / 500);
    expect(json.mock.calls[0]![0]).toMatch(/^\/api\/v1\/configmaps\?/);
  });
});

describe('resource-names route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it('serves names for a kind in a namespace', async () => {
    const json = vi.fn(async (_path: string) => table(['compare-me', 'healthy-web']));
    const handle = { contextName: 'kind-a', raw: { json } } as unknown as ClusterHandle;
    const app = Fastify();
    apps.push(app);
    registerResourceRoutes(app, { clusters: { get: () => handle } } as unknown as AppContext);
    const response = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/resource-names/apps/v1/deployments?namespace=gap-ns' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ names: ['compare-me', 'healthy-web'] });
    expect(json.mock.calls[0]![0]).toContain('/apis/apps/v1/namespaces/gap-ns/deployments?');
  });
});
