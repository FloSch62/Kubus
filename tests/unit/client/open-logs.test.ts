import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockTab } from '../../../client/src/state/dock';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('../../../client/src/api/queries.js', () => ({ resolveLogTargetPods: resolve }));

const { openLogsForTarget } = await import('../../../client/src/actions/open-logs');

const ref = { ctx: 'dev', group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment' as const, namespace: 'shop', name: 'web' };

describe('openLogsForTarget', () => {
  let tabs: DockTab[];
  const addTab = (tab: DockTab) => tabs.push(tab);

  beforeEach(() => {
    tabs = [];
    resolve.mockReset();
  });

  it('opens one tab per namespace that follows the workload', async () => {
    resolve.mockResolvedValue({ pods: [{ name: 'web-a', namespace: 'shop', containers: ['app'] }, { name: 'web-b', namespace: 'shop', containers: ['app'] }] });
    await openLogsForTarget(ref, addTab);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'logs', title: 'logs: Deployment/web', pods: ['web-a', 'web-b'], target: { kind: 'Deployment', name: 'web' } });
  });

  it('opens a waiting tab for a workload with no pods yet', async () => {
    resolve.mockResolvedValue({ pods: [] });
    await openLogsForTarget(ref, addTab);
    expect(tabs).toEqual([expect.objectContaining({ kind: 'logs', namespace: 'shop', pods: [], sources: [], target: { kind: 'Deployment', name: 'web' }, follow: true })]);
  });

  it('reports a Service without a selector instead of waiting for pods that cannot come', async () => {
    resolve.mockResolvedValue({ pods: [], noPodsReason: 'it has no pod selector' });
    const service = { ...ref, group: '', plural: 'services', kind: 'Service' as const, namespace: 'default', name: 'kubernetes' };
    await expect(openLogsForTarget(service, addTab)).rejects.toThrow('No pods found for Service default/kubernetes: it has no pod selector');
    expect(tabs).toHaveLength(0);
  });

  it('opens a waiting tab for a Service whose selector matches nothing yet', async () => {
    resolve.mockResolvedValue({ pods: [] });
    await openLogsForTarget({ ...ref, group: '', plural: 'services', kind: 'Service', name: 'web' }, addTab);
    expect(tabs).toEqual([expect.objectContaining({ pods: [], target: { kind: 'Service', name: 'web' } })]);
  });

  it('still reports a pod that cannot be found', async () => {
    resolve.mockResolvedValue({ pods: [] });
    await expect(openLogsForTarget({ ...ref, group: '', plural: 'pods', kind: 'Pod', name: 'gone' }, addTab)).rejects.toThrow('No pods found for Pod shop/gone');
    expect(tabs).toHaveLength(0);
  });
});
