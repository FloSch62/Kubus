import path from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { repoRoot } from '../helpers/cluster.mjs';

const headers = { Authorization: 'Bearer dev' };
type ResourceQuery = { group: string; plural: string; name?: string; namespace?: string };
type FixtureResource = { metadata: { name: string; namespace?: string; uid?: string } };
async function mockPluginResources(page: Page, read: (query: ResourceQuery) => FixtureResource[]) {
  const subscriptions = new Map<WebSocketRoute, Map<string, ResourceQuery>>();
  let connections = 0;
  const items = (query: ResourceQuery) =>
    read(query).map((r) => ({ ...r, metadata: { ...r.metadata, uid: r.metadata.uid ?? `${r.metadata.namespace}/${r.metadata.name}` } }));
  await page.route('**/api/plugins/clabernetes/resources', async (route) => {
    const query = route.request().postDataJSON() as ResourceQuery;
    const resources = items(query);
    await route.fulfill({
      json: { data: query.name ? resources.find((r) => r.metadata.name === query.name) : { items: resources }, kind: { namespaced: true } },
    });
  });
  await page.routeWebSocket('**/ws/watch**', (socket) => {
    connections++;
    const upstream = socket.connectToServer();
    const watches = new Map<string, ResourceQuery>();
    subscriptions.set(socket, watches);
    socket.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.op === 'sub' && message.pluginId === 'clabernetes') {
        watches.set(message.id, message);
        socket.send(JSON.stringify({ op: 'snapshot', id: message.id, items: items(message) }));
        socket.send(JSON.stringify({ op: 'status', id: message.id, state: 'live' }));
      } else if (message.op !== 'unsub' || !watches.delete(message.id)) upstream.send(data);
    });
    socket.onClose(() => {
      subscriptions.delete(socket);
      void upstream.close();
    });
  });
  return {
    connections: () => connections,
    watchCount: () => [...subscriptions.values()].reduce((count, watches) => count + watches.size, 0),
    disconnect: async () => {
      const sockets = [...subscriptions.keys()];
      subscriptions.clear();
      await Promise.all(sockets.map((socket) => socket.close({ code: 1012, reason: 'Reconnect test' })));
    },
    publish: () => {
      for (const [socket, watches] of subscriptions)
        for (const [id, query] of watches) {
          socket.send(JSON.stringify({ op: 'events', id, events: items(query).map((object) => ({ type: 'MODIFIED', object })) }));
        }
    },
  };
}

test('shipped plugin lifecycle, isolated viewer, and page reload', async ({ page, request }) => {
  let degraded = false;
  const topology = {
    apiVersion: 'c9s.run/v1alpha1',
    kind: 'Topology',
    metadata: { name: 'browser-lab', namespace: 'kubus-e2e', uid: 'lab', generation: 1 },
    spec: {
      definition: {
        containerlab:
          'name: browser-lab\ntopology:\n  nodes:\n    leaf1: {kind: linux, image: alpine}\n    leaf2: {kind: linux, image: alpine}\n  links:\n    - endpoints: [leaf1:eth1, leaf2:eth1]\n',
      },
    },
    status: { topologyState: 'running', topologyReady: true, observedGeneration: 1, nodeCount: 2, readyNodeCount: 2, linkCount: 1 },
  };
  const stream = await mockPluginResources(page, (query) => {
    const pods = ['leaf1', 'leaf2'].map((name) => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `${name}-pod`,
        namespace: 'kubus-e2e',
        labels: { 'c9s.run/topologyOwner': 'browser-lab', 'c9s.run/direct-workload': name },
      },
      spec: {
        containers: [{ name: `${name}-device`, image: 'alpine' }],
        initContainers: [{ name: 'planner' }, { name: 'clabwire', restartPolicy: 'Always' }],
      },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: `${name}-device`, ready: true, state: { running: {} } }],
        initContainerStatuses: [
          { name: 'planner', state: { terminated: { reason: 'Completed' } } },
          { name: 'clabwire', state: { running: {} } },
        ],
      },
    }));
    const items =
      query.plural === 'topologies'
        ? [topology]
        : query.plural === 'nodes'
          ? ['leaf1', 'leaf2'].map((name) => ({
              apiVersion: 'c9s.run/v1alpha1',
              kind: 'Node',
              metadata: { name, namespace: 'kubus-e2e', labels: { 'c9s.run/topologyOwner': 'browser-lab' } },
              status: {
                readiness: degraded && name === 'leaf2' ? 'notready' : 'ready',
                directContainers: [{ name: `${name}-device` }],
                conditions: ['NodeProfileResolved', 'PlanApplied', 'Prepared', 'ConnectivityReady', 'ContainersReady'].map((type) => ({
                  type,
                  status: degraded && name === 'leaf2' && type === 'ConnectivityReady' ? 'False' : 'True',
                  reason: degraded && name === 'leaf2' && type === 'ConnectivityReady' ? 'PeerUnavailable' : 'Ready',
                })),
              },
              spec: { kind: 'linux', image: 'alpine' },
            }))
          : query.plural === 'pods'
            ? pods
            : [];
    return items;
  });
  try {
    await gotoApp(page, '/plugins/clabernetes');
    await expect(page.getByText('This plugin is disabled or unavailable.', { exact: false })).toBeVisible();
    await page.locator('.MuiToolbar-root button').last().click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await page.getByRole('switch', { name: 'Enable Clabernetes' }).click();
    await expect(page.getByRole('switch', { name: 'Enable Clabernetes' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: 'Clabernetes', exact: true })).toBeVisible();
    expect(await page.getByRole('link', { name: 'Diff', exact: true }).evaluate((link) => link.nextElementSibling?.textContent)).toBe(
      'Clabernetes',
    );
    const plugin = page.frameLocator('iframe[title="Clabernetes"]');
    await plugin.getByRole('button', { name: 'browser-lab', exact: true }).click();
    await expect(plugin.locator('.react-flow__node')).toHaveCount(2);
    const frame = page.frames().find((f) => f.url().includes('/plugin-assets/clabernetes/'))!;
    expect(
      await frame.evaluate(() => {
        try {
          return parent.document.title;
        } catch (error) {
          return (error as Error).name;
        }
      }),
    ).toBe('SecurityError');
    expect(
      await frame.evaluate(() => {
        try {
          return sessionStorage.getItem('kubus-token');
        } catch (error) {
          return (error as Error).name;
        }
      }),
    ).toBe('SecurityError');
    await page.reload();
    await plugin.getByRole('button', { name: 'browser-lab', exact: true }).click();
    await expect(plugin.locator('.react-flow__node')).toHaveCount(2);
    await plugin.locator('.react-flow').evaluate((el) => el.setAttribute('data-refresh-check', 'keep'));
    stream.publish();
    await expect(plugin.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(plugin.locator('.react-flow[data-refresh-check="keep"]')).toHaveCount(1);
    // MUI node actions resolve helpers separately from the device container.
    await plugin.getByRole('button', { name: 'leaf1', exact: true }).click();
    await expect(plugin.getByRole('complementary', { name: 'Node leaf1', exact: true })).toBeVisible();
    await expect(plugin.getByText('Readiness pipeline', { exact: true })).toBeVisible();
    await expect(plugin.getByRole('button', { name: 'Shell', exact: true })).toBeEnabled();
    await plugin.getByRole('button', { name: 'Containers for leaf1', exact: true }).last().click();
    await expect(plugin.getByRole('menuitem', { name: /Preparation logs/ })).toBeVisible();
    await expect(plugin.getByRole('menuitem', { name: /Connectivity logs/ })).toBeVisible();
    await plugin.getByRole('menuitem', { name: /Connectivity logs/ }).click();
    await expect(page.getByRole('tab', { name: /leaf1-pod/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close leaf1-pod', exact: true }).click();
    await plugin.getByRole('button', { name: 'Close node inspector', exact: true }).click();
    degraded = true;
    topology.status.topologyState = 'degraded';
    topology.status.readyNodeCount = 1;
    stream.publish();
    await expect(plugin.getByRole('button', { name: '1 need attention', exact: true }).last()).toBeVisible();
    const connections = stream.connections();
    await stream.disconnect();
    await expect.poll(stream.connections).toBeGreaterThan(connections);
    await expect.poll(stream.watchCount).toBeGreaterThan(0);
    await expect(plugin.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await plugin.getByRole('button', { name: '1 need attention', exact: true }).last().click();
    await expect(plugin.getByRole('button', { name: 'leaf1', exact: true })).toHaveCount(0);
    await plugin.getByRole('button', { name: 'leaf2', exact: true }).click();
    await expect(plugin.getByText('Wiring · PeerUnavailable', { exact: true })).toBeVisible();
    await expect(plugin.getByRole('button', { name: 'Read clabwire logs', exact: true })).toBeEnabled();
    await page.getByRole('link', { name: 'Pods', exact: true }).click();
    await expect.poll(stream.watchCount).toBe(0);
    await page.getByRole('link', { name: 'Clabernetes', exact: true }).click();
    await expect.poll(stream.watchCount).toBeGreaterThan(0);
    // Another renderer changing settings must revoke this open page too.
    await request.put('/api/plugins/clabernetes', { headers, data: { enabled: false } });
    await expect(page.locator('iframe[title="Clabernetes"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Clabernetes', exact: true })).toHaveCount(0);
  } finally {
    await request.put('/api/plugins/clabernetes', { headers, data: { enabled: false } });
  }
});

test('install and remove an independent local bundle without changing Kubus', async ({ page, request }) => {
  try {
    await gotoApp(page);
    await page.locator('.MuiToolbar-root button').last().click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await page.getByRole('textbox', { name: 'Plugin directory', exact: true }).fill(path.join(repoRoot, 'plugins/examples/hello-world'));
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enable Hello workspace' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Enable Hello workspace' }).click();
    await expect(page.getByRole('switch', { name: 'Enable Hello workspace' })).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Hello workspace', exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Hello workspace"]').getByRole('heading', { name: 'Hello from a Kubus plugin' }),
    ).toBeVisible();
    await expect(page.frameLocator('iframe[title="Hello workspace"]').locator('#context')).toContainText('contexts');
    await page.reload();
    await expect(page.frameLocator('iframe[title="Hello workspace"]').locator('#context')).toContainText('contexts');
    await request.delete('/api/plugins/hello-world', { headers });
    await expect(page.locator('iframe[title="Hello workspace"]')).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await request.delete('/api/plugins/hello-world', { headers });
  }
});

test('fleet scope, live links, configuration files and Helm relationships', async ({ page, request }) => {
  test.setTimeout(60_000);
  const metadata = (name: string, namespace = 'kubus-e2e') => ({ name, namespace, uid: `${namespace}/${name}`, generation: 1 });
  const nodes = ['kubus-e2e', 'second-lab'].flatMap((namespace) =>
    ['r1', 'r2'].map((name) => ({
      apiVersion: 'c9s.run/v1alpha1',
      kind: 'Node',
      metadata: metadata(name, namespace),
      spec: {
        kind: 'linux',
        image: 'alpine',
        profileRef: { name: 'device-policy' },
        'startup-config': 'configs/device.cfg',
        filesFromConfigMap: [{ configMapName: 'startup', configMapPath: 'config', filePath: 'configs/device.cfg' }],
      },
      status: { readiness: 'ready', conditions: [{ type: 'ConnectivityReady', status: 'True', observedGeneration: 1 }] },
    })),
  );
  const links = ['kubus-e2e', 'second-lab'].map((namespace) => ({
    apiVersion: 'c9s.run/v1alpha1',
    kind: 'Link',
    metadata: metadata('r1-r2', namespace),
    spec: { endpointA: { nodeName: 'r1', interfaceName: 'eth1' }, endpointB: { nodeName: 'r2', interfaceName: 'eth1' } },
    status: { wireID: 1, conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }] },
  }));
  const pods = nodes.map((n) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { ...metadata(`${n.metadata.name}-pod`, n.metadata.namespace), labels: { 'c9s.run/direct-workload': n.metadata.name } },
    spec: {
      containers: [{ name: 'device', image: 'alpine' }],
      volumes: [{ name: 'plan', configMap: { name: 'active-plan', items: [{ key: 'plan.json', path: 'plan.json' }] } }],
    },
    status: { phase: 'Running', containerStatuses: [{ name: 'device', ready: true, state: { running: {} } }] },
  }));
  const manager = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      ...metadata('clabernetes-manager'),
      labels: {
        'c9s.run/app': 'clabernetes',
        'c9s.run/component': 'manager',
        heritage: 'Helm',
        release: 'c9s',
        chart: 'clabernetes-0.9.0',
      },
    },
    spec: { template: { spec: { containers: [{ name: 'manager', image: 'manager:0.9.0' }] } } },
  };
  const config = {
    apiVersion: 'c9s.run/v1alpha1',
    kind: 'Config',
    metadata: metadata('clabernetes'),
    spec: { imagePull: { policy: 'Always' } },
  };
  const bootstrap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { ...metadata('clabernetes-config'), labels: { 'c9s.run/component': 'config' } },
    data: { mergeMode: 'merge', imagePullPolicy: 'IfNotPresent' },
  };
  const maps = ['kubus-e2e', 'second-lab'].flatMap((ns) => [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('startup', ns), data: { config: 'hostname r1' } },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { ...metadata('active-plan', ns), labels: { 'c9s.run/component': 'node-plan' } },
      data: { 'plan.json': '{}' },
    },
  ]);
  const profile = {
    apiVersion: 'c9s.run/v1alpha1',
    kind: 'NodeProfile',
    metadata: metadata('device-policy'),
    spec: { deployment: { persistence: { enabled: true, reclaim: 'Retain' } } },
  };
  let down = false;
  let inspectionsPaused: Promise<void> | undefined;
  let resumeInspections: (() => void) | undefined;
  await page.route('**/api/plugins/clabernetes/interfaces', async (route) => {
    await inspectionsPaused;
    const { namespace, name, container } = route.request().postDataJSON() as { namespace: string; name: string; container: string };
    const carrier = !(down && name === 'r2-pod');
    await route.fulfill({
      json: {
        podUID: `${namespace}/${name}`,
        container,
        observedAt: new Date().toISOString(),
        interfaces: [{ name: 'eth1', adminUp: true, carrier, operState: carrier ? 'UP' : 'DOWN', mtu: 9500 }],
      },
    });
  });
  await mockPluginResources(page, ({ plural, namespace }) => {
    const collections: Record<string, Array<{ metadata: { name: string; namespace: string } }>> = {
      nodes,
      links,
      pods,
      deployments: [manager],
      configs: [config],
      configmaps: [bootstrap, ...maps],
      nodeprofiles: [profile],
    };
    const items = (collections[plural] ?? []).filter((r) => !namespace || r.metadata.namespace === namespace);
    return items;
  });
  try {
    await request.put('/api/plugins/clabernetes', { headers, data: { enabled: true } });
    await gotoApp(page, '/plugins/clabernetes');
    const plugin = page.frameLocator('iframe[title="Clabernetes"]');
    await expect(plugin.getByRole('grid', { name: 'Labs', exact: true })).toContainText('second-lab');
    await plugin.getByRole('tab', { name: 'Nodes', exact: true }).click();
    await expect(plugin.getByRole('grid', { name: 'Network nodes' }).getByRole('button', { name: 'r1', exact: true })).toHaveCount(2);
    await plugin.getByRole('tab', { name: 'Links', exact: true }).click();
    await expect(plugin.getByText('2/2 up', { exact: true })).toBeVisible();
    const linkGrid = plugin.getByRole('grid', { name: 'Lab links' });
    await linkGrid.evaluate((element) => element.setAttribute('data-retained-grid', 'links'));
    await plugin.getByRole('textbox', { name: 'Find a link', exact: true }).fill('r1');
    await plugin.getByRole('button', { name: 'Kubernetes details', exact: true }).click();
    await linkGrid.getByRole('columnheader', { name: 'Endpoint A', exact: true }).click();
    // Hold new observations: cached state must remain visible even before a resumed inspection completes.
    inspectionsPaused = new Promise((resolve) => {
      resumeInspections = resolve;
    });
    for (const tab of ['Nodes', 'Labs', 'Platform', 'Pods']) {
      if (tab === 'Pods') {
        await page.getByRole('link', { name: 'Pods', exact: true }).click();
        await page.getByRole('link', { name: 'Clabernetes', exact: true }).click();
      } else {
        await plugin.getByRole('tab', { name: tab, exact: true }).click();
      }
      await plugin.getByRole('tab', { name: 'Links', exact: true }).click();
      await expect(linkGrid).toHaveAttribute('data-retained-grid', 'links');
      await expect(plugin.getByText('2/2 up', { exact: true })).toBeVisible();
      await expect(linkGrid).not.toContainText(/Checking|Waiting/);
      await expect(plugin.getByRole('textbox', { name: 'Find a link', exact: true })).toHaveValue('r1');
      await expect(linkGrid.getByRole('columnheader', { name: /^Endpoint A/ })).toHaveAttribute('aria-sort', 'ascending');
      await expect(linkGrid.getByRole('columnheader', { name: 'Configuration', exact: true })).toBeVisible();
    }
    resumeInspections?.();
    inspectionsPaused = undefined;
    await plugin.getByRole('textbox', { name: 'Find a link', exact: true }).clear();
    down = true;
    await expect(plugin.getByRole('button', { name: 'Check now', exact: true })).toHaveCount(0);
    await expect(plugin.getByText('0/2 up', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(plugin.getByRole('grid', { name: 'Lab links' })).toContainText('Down');
    await plugin.getByRole('combobox', { name: 'Workspace scope' }).click();
    await plugin.getByRole('option').filter({ hasText: 'kubus-e2e' }).click();
    await expect(plugin.getByText('0/1 up', { exact: true })).toBeVisible();
    await plugin.getByRole('tab', { name: 'Topology', exact: true }).click();
    await expect(plugin.locator('.react-flow__node')).toHaveCount(2);
    await expect(plugin.getByRole('tab', { name: 'Nodes', exact: true })).toHaveCount(1);
    await plugin.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect(plugin.getByRole('grid', { name: 'Device configuration files' })).toContainText('configs/device.cfg');
    await expect(plugin.getByRole('grid', { name: 'Device configuration files' })).toContainText('Startup configuration');
    await plugin.getByRole('tab', { name: 'Runtime artifacts', exact: true }).click();
    await expect(plugin.getByRole('grid', { name: 'Device configuration files' })).toContainText('active-plan');
    await expect(plugin.getByRole('grid', { name: 'Device configuration files' })).toContainText('Mounted');
    await plugin.getByRole('tab', { name: 'Platform', exact: true }).click();
    await expect(plugin.getByText('Chart bootstrap', { exact: true })).toBeVisible();
    await expect(plugin.getByText('IfNotPresent', { exact: true })).toBeVisible();
    await expect(plugin.getByText('clabernetes-0.9.0', { exact: true })).toBeVisible();
    await plugin.getByRole('button', { name: 'Helm release · c9s', exact: true }).click();
    await expect(page).toHaveURL(/\/helm\/kind-kubus-a\/kubus-e2e\/c9s$/);
  } finally {
    resumeInspections?.();
    await request.put('/api/plugins/clabernetes', { headers, data: { enabled: false } });
  }
});
