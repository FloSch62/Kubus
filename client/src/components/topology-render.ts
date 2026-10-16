import type { Theme } from '@mui/material/styles';
import type { GraphEdge, GraphNode, GraphNodeStatus } from '@kubus/shared';
import { NODE_WIDTH, type RoutePoint } from './topology-layout.js';

/** Edge hues per theme mode: label text sits on background.paper chips, so
 *  light mode needs the darker tones and dark mode the brighter ones. */
export const EDGE_COLOR: Record<'light' | 'dark', Record<GraphEdge['kind'], string>> = {
  light: {
    owns: '#64748b',
    selects: '#2563eb',
    routes: '#7c3aed',
    mounts: '#0e7490',
    binds: '#0f766e',
    schedules: '#8f6209',
    manages: '#9333ea',
  },
  dark: {
    owns: '#94a3b8',
    selects: '#60a5fa',
    routes: '#a78bfa',
    mounts: '#22d3ee',
    binds: '#2dd4bf',
    schedules: '#e7b341',
    manages: '#c084fc',
  },
};

// Traffic edges animate as dashed lines; the legend draws them dashed too.
export const DASHED_KINDS = new Set<GraphEdge['kind']>(['routes', 'selects']);

export function nodeStatusColor(status: GraphNodeStatus, theme: Theme): string {
  return status === 'unknown' ? theme.palette.text.secondary : theme.palette[status].main;
}

// Cards are narrow so a namespace fits the screen at a readable zoom; long
// names keep their tail (a pod's random suffix) and elide the middle instead.
export const LABEL_FONT_SIZE = 13.5;
export const LABEL_WIDTH = NODE_WIDTH - 24;

let measureContext: CanvasRenderingContext2D | null | undefined;

export function textWidth(text: string, font: string): number {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d') ?? null;
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return text.length * LABEL_FONT_SIZE * 0.56;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

export function compactLabel(label: string, maxWidth: number, font: string): string {
  if (textWidth(label, font) <= maxWidth) return label;
  // Keep the last dash segment whole when it is short, otherwise an even tail.
  const lastDash = label.lastIndexOf('-');
  const segment = lastDash > 0 ? label.slice(lastDash) : '';
  const tail = segment.length > 1 && segment.length <= 8 ? segment : label.slice(-Math.ceil(label.length / 3));
  let head = label.slice(0, label.length - tail.length);
  while (head.length > 1 && textWidth(`${head}…${tail}`, font) > maxWidth) head = head.slice(0, -1);
  return `${head}…${tail}`;
}

export const LAYER_GAP = 6;
export const LAYER_LETTER_SPACING = 0.5;

/**
 * The layer caption beside the kind ("workload", "entry", "storage"…), or
 * undefined when it would only repeat the kind (a Pod's "pod" layer), says
 * nothing ("other"), or does not fit next to a long kind name.
 */
export function layerCaption(node: GraphNode, fontFamily: string): string | undefined {
  const layer = node.layer;
  if (layer === 'other' || layer === node.ref.kind.toLowerCase()) return undefined;
  const text = layer.toUpperCase();
  const width =
    textWidth(node.ref.kind, `400 11px ${fontFamily}`) + textWidth(text, `600 9.5px ${fontFamily}`) + text.length * LAYER_LETTER_SPACING + LAYER_GAP;
  return width <= LABEL_WIDTH ? text : undefined;
}

export function alignRouteEndpoints(routePoints: RoutePoint[], source: RoutePoint, target: RoutePoint): RoutePoint[] {
  const aligned = routePoints.map((point) => ({ ...point }));
  const lastIndex = aligned.length - 1;
  aligned[0] = { x: source.x, y: source.y };
  aligned[lastIndex] = { x: target.x, y: target.y };
  if (aligned.length > 2) {
    aligned[1] = { ...aligned[1]!, y: source.y };
    aligned[lastIndex - 1] = { ...aligned[lastIndex - 1]!, y: target.y };
  }
  return aligned;
}

export function roundedRoutePath(points: RoutePoint[], radius = 14): string {
  if (!points.length) return '';
  const [start] = points;
  const commands = [`M ${start!.x} ${start!.y}`];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1];

    if (!next) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }
    const incomingDistance = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoingDistance = Math.hypot(next.x - current.x, next.y - current.y);
    if (incomingDistance === 0 || outgoingDistance === 0) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }
    const cornerRadius = Math.min(radius, incomingDistance / 2, outgoingDistance / 2);
    const beforeCorner = {
      x: current.x - ((current.x - previous.x) / incomingDistance) * cornerRadius,
      y: current.y - ((current.y - previous.y) / incomingDistance) * cornerRadius,
    };
    const afterCorner = {
      x: current.x + ((next.x - current.x) / outgoingDistance) * cornerRadius,
      y: current.y + ((next.y - current.y) / outgoingDistance) * cornerRadius,
    };
    commands.push(
      `L ${round2(beforeCorner.x)} ${round2(beforeCorner.y)}`,
      `Q ${current.x} ${current.y} ${round2(afterCorner.x)} ${round2(afterCorner.y)}`,
    );
  }
  return commands.join(' ');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function pointAtFraction(points: RoutePoint[], fraction: number): RoutePoint {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1]!.x - points[index]!.x, points[index + 1]!.y - points[index]!.y);
  }
  let remaining = total * fraction;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length >= remaining) {
      const t = length === 0 ? 0 : remaining / length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    remaining -= length;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}
