import { dump } from 'js-yaml';
import { belongsTo, belongsToNode, counts, object, phase, source, string, tone, type Located } from './model.js';
import { mountedClaims, nodePods } from './runtime.js';

/** The namespace is c9s's lab boundary. A Topology is an optional authoring shortcut. */
export interface Lab {
  id: string;
  name: string;
  ctx: string;
  namespace: string;
  topologies: Located[];
  nodes: Located[];
  links: Located[];
}
export function discoverLabs(resources: Located[]): Lab[] {
  const labs = new Map<string, Lab>();
  for (const r of resources) {
    if (!['topologies', 'nodes', 'links'].includes(r.plural) || !r.metadata.namespace) continue;
    const id = JSON.stringify([r.ctx, r.metadata.namespace]);
    let lab = labs.get(id);
    if (!lab) {
      lab = { id, name: r.metadata.namespace, ctx: r.ctx, namespace: r.metadata.namespace, topologies: [], nodes: [], links: [] };
      labs.set(id, lab);
    }
    if (r.plural === 'topologies') lab.topologies.push(r);
    else if (r.plural === 'nodes') lab.nodes.push(r);
    else lab.links.push(r);
  }
  return [...labs.values()]
    .map((lab) => {
      const topology = lab.topologies[0];
      if (lab.topologies.length === 1 && topology && [...lab.nodes, ...lab.links].every((r) => belongsTo(r, topology)))
        lab.name = topology.metadata.name;
      lab.nodes.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      lab.links.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      return lab;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function labCounts(lab: Lab) {
  const expected =
    lab.topologies.reduce((n, t) => n + counts(t, lab.nodes, lab.links).nodes, 0) +
    lab.nodes.filter((n) => !lab.topologies.some((t) => belongsTo(n, t))).length;
  return {
    nodes: Math.max(lab.nodes.length, expected),
    ready: lab.nodes.filter((n) => tone(phase(n)) === 'good').length,
    links: lab.links.length,
  };
}
export function labPhase(lab: Lab): string {
  if (lab.topologies.some((t) => tone(phase(t)) === 'bad')) return 'Degraded';
  if (lab.topologies.some((t) => phase(t) === 'Reconciling')) return 'Reconciling';
  const c = labCounts(lab);
  if (!c.nodes) return 'Unknown';
  if (c.ready === c.nodes) return 'Ready';
  return lab.nodes.some((n) => tone(phase(n)) === 'bad') ? 'Degraded' : 'Reconciling';
}
export function labGraph(lab: Lab): { yaml: string; generated: boolean } {
  const topology = lab.topologies[0];
  if (lab.topologies.length === 1 && topology && source(topology) && [...lab.nodes, ...lab.links].every((r) => belongsTo(r, topology))) {
    return { yaml: source(topology), generated: false };
  }
  const nodes = Object.fromEntries(
    lab.nodes.map((n) => [
      n.metadata.name,
      {
        kind: string(n.spec?.kind, 'linux'),
        image: string(n.spec?.image, ''),
      },
    ]),
  );
  const links = lab.links.map((l) => ({
    endpoints: ['A', 'B'].map((side) => {
      const endpoint = object(l.spec?.[`endpoint${side}`]);
      return `${string(endpoint.nodeName, 'unknown')}:${string(endpoint.interfaceName, 'unknown')}`;
    }),
  }));
  return { yaml: dump({ name: lab.namespace, topology: { nodes, links } }, { noRefs: true }), generated: true };
}
export function labPods(lab: Lab, pods: Located[]): Located[] {
  const matched = new Set(lab.nodes.flatMap((n) => nodePods(n, pods)));
  return pods.filter((p) => matched.has(p) || lab.topologies.some((t) => belongsTo(p, t)));
}
export function labRuntime(resource: Located, lab: Lab, pods: Located[]): boolean {
  if (resource.ctx !== lab.ctx || resource.metadata.namespace !== lab.namespace) return false;
  if (lab.topologies.some((t) => belongsTo(resource, t)) || lab.nodes.some((n) => belongsToNode(resource, n))) return true;
  if (resource.plural === 'persistentvolumeclaims') return pods.some((p) => mountedClaims(p).includes(resource.metadata.name));
  const selector = object(resource.spec?.selector);
  if (resource.plural === 'services' && Object.keys(selector).length)
    return pods.some((p) => Object.entries(selector).every(([k, v]) => p.metadata.labels?.[k] === v));
  return false;
}

export function linkWiring(link: Located, nodes: Located[]): { label: string; detail: string } {
  const accepted = link.status?.conditions?.find((c) => c.type === 'Accepted');
  if (accepted?.observedGeneration !== undefined && accepted.observedGeneration < (link.metadata.generation ?? 0))
    return { label: 'Reconciling', detail: 'Link acceptance describes an earlier generation.' };
  if (accepted?.status === 'False')
    return { label: 'Rejected', detail: accepted.message ?? accepted.reason ?? 'Link configuration was rejected.' };
  if (accepted?.status !== 'True') return { label: 'Unknown', detail: 'Link acceptance has not been reported.' };
  const states = ['A', 'B'].map((side) => {
    const name = object(link.spec?.[`endpoint${side}`]).nodeName;
    if (name === 'host') return { state: 'host', detail: 'Host endpoint is observed by its device sidecar.' };
    const node = nodes.find((n) => n.ctx === link.ctx && n.metadata.namespace === link.metadata.namespace && n.metadata.name === name);
    if (!node) return { state: 'unknown', detail: `${String(name)}: Node is unavailable.` };
    const resolved = object(object(link.status?.resolvedEndpoints)[`endpoint${side}`]);
    if (resolved.uid && node.metadata.uid && resolved.uid !== node.metadata.uid)
      return { state: 'unknown', detail: `${String(name)}: Link is bound to a replaced Node.` };
    const c = node.status?.conditions?.find((c) => c.type === 'ConnectivityReady');
    if (!c || (c.observedGeneration !== undefined && c.observedGeneration < (node.metadata.generation ?? 0)))
      return { state: 'unknown', detail: `${String(name)}: current wiring status is unavailable.` };
    return {
      state: c.status === 'True' ? 'ready' : c.status === 'False' ? 'blocked' : 'unknown',
      detail: `${String(name)}: ${c.message ?? c.reason ?? c.status}`,
    };
  });
  return {
    label: states.some((s) => s.state === 'blocked') ? 'Not ready' : states.some((s) => s.state === 'unknown') ? 'Unknown' : 'Ready',
    detail: states.map((s) => s.detail).join(' '),
  };
}
