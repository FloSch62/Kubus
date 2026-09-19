import { belongsTo, key, object, string, type Located } from './model.js';
import { nodePods, records } from './runtime.js';
import type { Lab } from './labs.js';

export interface ConfigRelation {
  id: string;
  node: Located;
  name: string;
  dataKey: string;
  path: string;
  destination?: string;
  purpose: string;
  source: 'Device files' | 'Runtime artifacts';
  map?: Located;
  pod?: Located;
  state: string;
}
const purposes: Record<string, string> = {
  'node-plan': 'Device plan',
  'node-plan-input': 'Plan inputs',
  'clabwire-revision': 'Connectivity revision',
  'planner-output': 'Planner output',
};
export function fileDestination(node: Located, path: string): string {
  const normalize = (p: string) => p.replace(/^\.\//, '').replace(/\/$/, '');
  const file = normalize(path);
  const binds = Array.isArray(node.spec?.binds) ? node.spec.binds : [];
  return (
    binds
      .flatMap((bind) => {
        if (typeof bind !== 'string') return [];
        const [from, to] = bind.split(':');
        if (!from || !to) return [];
        const source = normalize(from);
        return file === source || file.startsWith(`${source}/`) ? [normalize(to) + file.slice(source.length)] : [];
      })
      .join(', ') || path
  );
}
export function configRelations(nodes: Located[], pods: Located[], maps: Located[]): ConfigRelation[] {
  return nodes.flatMap((node) => {
    const relatedPods = nodePods(node, pods);
    const find = (name: string) =>
      maps.find((m) => m.ctx === node.ctx && m.metadata.namespace === node.metadata.namespace && m.metadata.name === name);
    const rows: ConfigRelation[] = [];
    for (const file of records(node.spec?.filesFromConfigMap)) {
      const name = string(file.configMapName, '');
      const dataKey = string(file.configMapPath, '');
      const map = find(name);
      const present = map && (Object.hasOwn(object(map.data), dataKey) || Object.hasOwn(object(map.binaryData), dataKey));
      rows.push({
        id: `${key(node)}/file/${rows.length}`,
        node,
        name,
        dataKey,
        path: string(file.filePath),
        destination: fileDestination(node, string(file.filePath)),
        purpose: file.filePath === node.spec?.['startup-config'] ? 'Startup configuration' : 'Bound file',
        source: 'Device files',
        map,
        state: !map ? 'Map unavailable' : !present ? 'Key missing' : 'Available',
      });
    }
    for (const pod of relatedPods) {
      for (const volume of records(pod.spec?.volumes)) {
        const refs = [object(volume.configMap), ...records(object(volume.projected).sources).map((s) => object(s.configMap))];
        const mounts = [...records(pod.spec?.containers), ...records(pod.spec?.initContainers)].flatMap((c) =>
          records(c.volumeMounts).filter((m) => m.name === volume.name),
        );
        for (const ref of refs) {
          if (typeof ref.name !== 'string') continue;
          const map = find(ref.name);
          const device = rows.filter((r) => r.name === ref.name && r.source === 'Device files');
          if (device.length) {
            device.forEach((r) => {
              r.pod = pod;
            });
            continue;
          }
          const items = records(ref.items);
          rows.push({
            id: `${key(node)}/${key(pod)}/${string(volume.name)}/${ref.name}`,
            node,
            name: ref.name,
            dataKey: items.length ? items.map((i) => string(i.key)).join(', ') : Object.keys(object(map?.data)).join(', '),
            path: [...new Set(mounts.map((m) => string(m.mountPath)))].join(', '),
            purpose:
              purposes[map?.metadata.labels?.['c9s.run/component'] ?? ''] ??
              (ref.name.startsWith('c9s-peer-directory-') ? 'Peer directory' : 'Mounted ConfigMap'),
            source: 'Runtime artifacts',
            map,
            pod,
            state: map ? 'Mounted' : 'Map unavailable',
          });
        }
      }
    }
    // Keep unmounted planner outputs/revisions visible without calling them the active plan.
    for (const map of maps) {
      if (
        map.ctx !== node.ctx ||
        map.metadata.namespace !== node.metadata.namespace ||
        !node.metadata.uid ||
        map.metadata.labels?.['c9s.run/planOwnerUID'] !== node.metadata.uid ||
        rows.some((r) => r.name === map.metadata.name)
      )
        continue;
      rows.push({
        id: `${key(node)}/${key(map)}`,
        node,
        name: map.metadata.name,
        dataKey: Object.keys(object(map.data)).join(', '),
        path: '—',
        purpose: purposes[map.metadata.labels?.['c9s.run/component'] ?? ''] ?? 'Generated artifact',
        source: 'Runtime artifacts',
        map,
        state: 'Not mounted',
      });
    }
    return rows;
  });
}
export function relatedConfigMaps(labs: Lab[], relations: ConfigRelation[], maps: Located[]): Located[] {
  const used = new Set(relations.flatMap((r) => (r.map ? [key(r.map)] : [])));
  return maps.filter((m) => used.has(key(m)) || labs.some((l) => l.topologies.some((t) => belongsTo(m, t))));
}
