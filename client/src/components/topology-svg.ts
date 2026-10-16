import type { Theme } from '@mui/material/styles';
import { statusTextColor } from '../theme.js';
import { NODE_WIDTH, estimateNodeHeight, isFoldedReplicaSets, type RoutePoint } from './topology-layout.js';
import { EDGE_COLOR, DASHED_KINDS, LABEL_FONT_SIZE, LABEL_WIDTH, compactLabel, layerCaption, nodeStatusColor, alignRouteEndpoints, roundedRoutePath, pointAtFraction, textWidth } from './topology-render.js';
import type { TopologyFlowEdge, TopologyFlowNode } from './TopologyGraphImpl.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 32;

function element(tag: string, attributes: Record<string, string | number> = {}, text?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Standalone vector drawing of the current layout, independent of viewport,
 *  selection dimming, app CSS, and React Flow's HTML cards/label overlays. */
export function topologySvg(nodes: TopologyFlowNode[], edges: TopologyFlowEdge[], theme: Theme): string {
  if (nodes.length === 0) throw new Error('There is no topology to export.');
  const { palette } = theme;
  const fontFamily = theme.typography.fontFamily ?? 'sans-serif';
  const colors = EDGE_COLOR[palette.mode];
  const height = (node: TopologyFlowNode) => node.measured?.height ?? estimateNodeHeight(node.data.graphNode);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const routes = edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || !edge.data) return [];
    const start = { x: source.position.x + NODE_WIDTH, y: source.position.y + height(source) / 2 };
    const end = { x: target.position.x, y: target.position.y + height(target) / 2 };
    const points = edge.data.routePoints.length > 1 ? alignRouteEndpoints(edge.data.routePoints, start, end) : [start, end];
    return [{ edge, points }];
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: RoutePoint) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const node of nodes) {
    include(node.position);
    include({ x: node.position.x + NODE_WIDTH, y: node.position.y + height(node) });
  }
  // Routing can extend above/below the cards. Include the entire route so
  // back edges and arrows are never clipped by a node-only bounding box.
  for (const { points } of routes) for (const point of points) include(point);
  const labels = routes.flatMap(({ edge, points }) => {
    if (typeof edge.label !== 'string' || !edge.label) return [];
    const point = edge.data!.labelPoint ?? pointAtFraction(points, 0.5);
    const labelWidth = textWidth(edge.label, `700 11px ${fontFamily}`) + 8;
    include({ x: point.x - labelWidth / 2, y: point.y - 9 });
    include({ x: point.x + labelWidth / 2, y: point.y + 9 });
    return [{ text: edge.label, point, width: labelWidth, color: colors[edge.data!.kind] }];
  });
  const kinds = [...new Set(routes.map(({ edge }) => edge.data!.kind))].sort();
  const width = Math.ceil(Math.max(maxX - minX, kinds.length * 100) + PADDING * 2);
  const graphHeight = maxY - minY;
  const svgHeight = Math.ceil(graphHeight + PADDING * 2 + (kinds.length ? 28 : 0));
  const svg = element('svg', {
    width, height: svgHeight, viewBox: `0 0 ${width} ${svgHeight}`,
    'font-family': fontFamily, 'font-size': 12, role: 'img', 'aria-labelledby': 'topology-title',
  });
  svg.append(element('title', { id: 'topology-title' }, 'Kubus topology'));
  svg.append(element('desc', {}, 'Resource relationships in the current cluster and namespace scope. Old ReplicaSets follow the current folding setting.'));
  svg.append(element('rect', { width, height: svgHeight, fill: palette.background.default }));
  const defs = element('defs');
  svg.append(defs);
  for (const kind of kinds) {
    const marker = element('marker', {
      id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    });
    marker.append(element('path', { d: 'M 0 0 L 10 5 L 0 10 Z', fill: colors[kind] }));
    defs.append(marker);
  }
  const drawing = element('g', { transform: `translate(${PADDING - minX} ${PADDING - minY})` });
  svg.append(drawing);
  for (const { edge, points } of routes) {
    const kind = edge.data!.kind;
    const d = roundedRoutePath(points);
    drawing.append(element('path', { d, fill: 'none', stroke: palette.background.default, 'stroke-width': 5.7, 'stroke-linejoin': 'round' }));
    drawing.append(element('path', {
      d, fill: 'none', stroke: colors[kind], 'stroke-width': 1.7,
      'stroke-dasharray': DASHED_KINDS.has(kind) ? '5 4' : 'none', 'marker-end': `url(#arrow-${kind})`,
    }));
  }

  nodes.forEach((flowNode, index) => {
    const node = flowNode.data.graphNode;
    const folded = isFoldedReplicaSets(node);
    const color = nodeStatusColor(node.status, theme);
    const cardHeight = height(flowNode);
    const card = element('g', { transform: `translate(${flowNode.position.x} ${flowNode.position.y})` });
    // Full, unshortened text remains available as the card's SVG tooltip.
    card.append(element('title', {}, [node.ref.ctx, node.ref.namespace, `${node.ref.kind}/${node.label}`, node.sublabel, node.reason].filter(Boolean).join('\n')));
    card.append(element('rect', {
      width: NODE_WIDTH, height: cardHeight, rx: 4,
      fill: folded ? palette.background.default : palette.background.paper,
      stroke: folded ? palette.text.disabled : palette.divider,
      'stroke-dasharray': folded ? '4 3' : 'none',
    }));
    if (!folded) card.append(element('path', { d: `M 2 4 V ${cardHeight - 4}`, stroke: color, 'stroke-width': 4 }));
    for (const x of [0, NODE_WIDTH]) card.append(element('circle', { cx: x, cy: cardHeight / 2, r: 4, fill: folded ? palette.text.disabled : color }));

    const clipId = `card-text-${index}`;
    const clip = element('clipPath', { id: clipId });
    clip.append(element('rect', { x: 12, y: 0, width: LABEL_WIDTH, height: cardHeight }));
    defs.append(clip);
    const text = element('g', { 'clip-path': `url(#${clipId})` });
    card.append(text);
    text.append(element('text', { x: 12, y: 19, fill: palette.text.secondary, 'font-size': 11 }, node.ref.kind));
    const layer = folded ? undefined : layerCaption(node, fontFamily);
    if (layer) text.append(element('text', {
      x: NODE_WIDTH - 12, y: 19, fill: palette.text.secondary,
      'font-size': 9.5, 'font-weight': 600, 'letter-spacing': 0.5, 'text-anchor': 'end',
    }, layer));
    text.append(element('text', {
      x: 12, y: 37, fill: folded ? palette.text.secondary : palette.text.primary,
      'font-size': LABEL_FONT_SIZE, 'font-weight': folded ? 500 : 600,
    }, compactLabel(node.label, LABEL_WIDTH, `${folded ? 500 : 600} ${LABEL_FONT_SIZE}px ${fontFamily}`)));
    let rowY = 54;
    if (node.sublabel) {
      text.append(element('text', { x: 12, y: rowY, fill: palette.text.secondary }, node.sublabel));
      rowY += 17;
    }
    if (node.reason) text.append(element('text', {
      x: 12, y: rowY, fill: node.status === 'unknown' ? palette.text.secondary : statusTextColor(node.status)(theme),
    }, node.reason));
    drawing.append(card);
  });

  for (const label of labels) {
    drawing.append(element('rect', {
      x: label.point.x - label.width / 2, y: label.point.y - 9,
      width: label.width, height: 18, rx: 3, fill: palette.background.paper,
    }));
    drawing.append(element('text', {
      x: label.point.x, y: label.point.y + 4, 'text-anchor': 'middle',
      fill: label.color, 'font-size': 11, 'font-weight': 700,
    }, label.text));
  }

  const legendY = PADDING + graphHeight + 28;
  kinds.forEach((kind, index) => {
    const x = PADDING + index * 100;
    svg.append(element('line', {
      x1: x, x2: x + 18, y1: legendY - 4, y2: legendY - 4, stroke: colors[kind],
      'stroke-width': 2, 'stroke-dasharray': DASHED_KINDS.has(kind) ? '4 3' : 'none',
    }));
    svg.append(element('text', { x: x + 24, y: legendY, fill: palette.text.secondary }, kind));
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
}
