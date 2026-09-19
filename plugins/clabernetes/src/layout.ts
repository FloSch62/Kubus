import ELK from 'elkjs/lib/elk.bundled.js';
import { load } from 'js-yaml';
import { object, string } from './model.js';

/** The viewer owns rendering; its public annotations carry a deterministic layout. */
export async function layoutAnnotations(
  yaml: string,
  mode: 'auto' | 'source',
): Promise<Array<{ id: string; position?: { x: number; y: number } }>> {
  const topology = object(object(load(yaml)).topology);
  const nodes = object(topology.nodes);
  const ids = Object.keys(nodes).sort();
  if (mode === 'source') return ids.map((id) => ({ id }));
  const edges = (Array.isArray(topology.links) ? topology.links : []).flatMap((link, i) => {
    const endpoints = object(link).endpoints;
    if (!Array.isArray(endpoints) || endpoints.length !== 2) return [];
    const names = endpoints.map((e) => (typeof e === 'string' ? e.split(':')[0]! : string(object(e).node, '')));
    return names.every((id) => ids.includes(id)) ? [{ id: `e${i}`, sources: [names[0]!], targets: [names[1]!] }] : [];
  });
  const graph = await new ELK().layout({
    id: 'lab',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.componentComponent': '80',
      'elk.randomSeed': '1',
    },
    children: ids.map((id) => ({ id, width: 70, height: 85 })),
    edges,
  });
  return (graph.children ?? []).map((node) => ({ id: node.id, position: { x: node.x ?? 0, y: node.y ?? 0 } }));
}
