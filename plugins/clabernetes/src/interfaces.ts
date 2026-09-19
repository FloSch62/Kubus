import type { PodInterfaceSnapshot } from '@kubus/plugin-sdk';
import { key, object, type Located } from './model.js';
import { nodeTargets } from './runtime.js';

export interface InterfaceObservation {
  snapshot?: PodInterfaceSnapshot;
  error?: string;
  pending?: boolean;
}
export function interfaceTarget(node: Located, pods: Located[]) {
  return nodeTargets(node, pods).find((t) => !t.helper && t.running);
}
export function endpointState(link: Located, side: 'A' | 'B', nodes: Located[], observations: Record<string, InterfaceObservation>) {
  const endpoint = object(link.spec?.[`endpoint${side}`]);
  const node = nodes.find(
    (n) => n.ctx === link.ctx && n.metadata.namespace === link.metadata.namespace && n.metadata.name === endpoint.nodeName,
  );
  if (!node)
    return { label: endpoint.nodeName === 'host' ? 'Host' : 'Unavailable', detail: 'No device container is available for this endpoint.' };
  const bound = object(object(link.status?.resolvedEndpoints)[`endpoint${side}`]);
  if (bound.uid && bound.uid !== node.metadata.uid) return { label: 'Stale', detail: 'Link refers to a replaced Node.' };
  const observation = observations[key(node)];
  if (!observation) return { label: 'Waiting', detail: 'Waiting for the device Pod.' };
  if (observation.error) return { label: 'Unavailable', detail: observation.error };
  if (!observation.snapshot) return { label: 'Checking', detail: 'Reading device interfaces…' };
  const iface = observation.snapshot.interfaces.find((i) => i.name === endpoint.interfaceName);
  if (!iface) return { label: 'Missing', detail: `Interface is absent in the inspected container (${observation.snapshot.observedAt}).` };
  const label = !iface.adminUp ? 'Admin down' : iface.carrier === false ? 'Down' : iface.carrier === true ? 'Up' : 'Unknown';
  return {
    label,
    iface,
    detail: `Observed ${new Date(observation.snapshot.observedAt).toLocaleTimeString()} · admin ${iface.adminUp ? 'up' : 'down'} · operstate ${iface.operState} · MTU ${iface.mtu ?? 'unknown'}`,
  };
}
export function observedLinkState(a: string, b: string): string {
  if ([a, b].some((s) => s === 'Down' || s === 'Admin down')) return 'Down';
  if (a === 'Up' && b === 'Up') return 'Up';
  if ([a, b].includes('Missing')) return 'Missing interface';
  if ([a, b].includes('Checking')) return 'Checking';
  return 'Unknown';
}
