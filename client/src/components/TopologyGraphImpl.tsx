import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { GraphEdge, GraphNode, GraphNodeStatus, RelationshipGraph } from '@kubus/shared';
import { useTopologyGraphs } from '../api/queries.js';
import { useDetailStore } from '../state/detail.js';
import { statusTextColor } from '../theme.js';
import { FOLDED_REPLICASETS_PREFIX, NODE_WIDTH, cachedTopologyLayout, estimateNodeHeight, isFoldedReplicaSets, layoutTopology, routeEdges, topologyNodeBox, type RoutePoint, type TopologyLayout } from './topology-layout.js';
import type { TopologyGraphProps } from './TopologyGraph.js';

interface TopologyNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
}

interface TopologyEdgeData extends Record<string, unknown> {
  routePoints: RoutePoint[];
  labelPoint?: RoutePoint;
  kind: GraphEdge['kind'];
}

type TopologyFlowNode = Node<TopologyNodeData>;
type TopologyFlowEdge = Edge<TopologyEdgeData>;

/** Edge hues per theme mode: label text sits on background.paper chips, so
 *  light mode needs the darker tones and dark mode the brighter ones. */
const EDGE_COLOR: Record<'light' | 'dark', Record<GraphEdge['kind'], string>> = {
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
const DASHED_KINDS = new Set<GraphEdge['kind']>(['routes', 'selects']);

const countLabel = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function nodeStatusColor(status: GraphNodeStatus, theme: Theme): string {
  return status === 'unknown' ? theme.palette.text.secondary : theme.palette[status].main;
}

// Cards are narrow so a namespace fits the screen at a readable zoom; long
// names keep their tail (a pod's random suffix) and elide the middle instead.
const LABEL_FONT_SIZE = 13.5;
const LABEL_WIDTH = NODE_WIDTH - 24;

let measureContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
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

const LAYER_GAP = 6;
const LAYER_LETTER_SPACING = 0.5;

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

function TopologyNode({ data, selected }: NodeProps) {
  const node = (data as TopologyNodeData).graphNode;
  const theme = useTheme();
  const folded = isFoldedReplicaSets(node);
  const color = nodeStatusColor(node.status, theme);
  // Small status text needs the AA-safe tone; the status stripe can stay bright.
  const reasonColor = node.status === 'unknown' ? theme.palette.text.secondary : statusTextColor(node.status)(theme);
  const stripe = folded ? 1 : 4;
  const layer = folded ? undefined : layerCaption(node, theme.typography.fontFamily ?? 'sans-serif');
  return (
    <Box
      sx={{
        position: 'relative',
        width: NODE_WIDTH,
        border: 1,
        borderStyle: folded ? 'dashed' : 'solid',
        borderColor: selected ? 'primary.main' : folded ? 'text.disabled' : 'divider',
        borderLeft: folded ? undefined : `${stripe}px solid ${color}`,
        bgcolor: folded ? 'transparent' : 'background.paper',
        borderRadius: 1,
        boxShadow: folded ? 0 : selected ? 5 : 1,
        cursor: 'pointer',
        px: 1.1,
        py: 0.75,
        '&:hover': folded ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : undefined,
      }}
    >
      {/* xyflow anchors handles to the padding box, so the asymmetric borders
          (status stripe left, 1px right) need compensating offsets to put
          both dots on the outer edge. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 8, height: 8, border: 0, background: folded ? theme.palette.text.disabled : color, left: -stripe }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 8, height: 8, border: 0, background: folded ? theme.palette.text.disabled : color, right: -1 }}
      />
      <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', gap: `${LAYER_GAP}px`, minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', fontSize: 11, lineHeight: 1.35, minWidth: 0 }}>
          {node.ref.kind}
        </Typography>
        {layer && (
          <Typography
            component="span"
            aria-label={`${node.layer} layer`}
            sx={{
              flexShrink: 0,
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: `${LAYER_LETTER_SPACING}px`,
              lineHeight: 1.35,
              color: alpha(theme.palette.text.secondary, 0.85),
            }}
          >
            {layer}
          </Typography>
        )}
      </Stack>
      <Typography
        variant="body2"
        noWrap
        title={folded ? undefined : node.label}
        sx={{ fontSize: LABEL_FONT_SIZE, fontWeight: folded ? 500 : 600, lineHeight: 1.35, color: folded ? 'text.secondary' : undefined }}
      >
        {folded ? node.label : compactLabel(node.label, LABEL_WIDTH, `600 ${LABEL_FONT_SIZE}px ${theme.typography.fontFamily ?? 'sans-serif'}`)}
      </Typography>
      {node.sublabel && (
        <Typography variant="caption" color="text.secondary" noWrap title={node.sublabel} sx={{ display: 'block', lineHeight: 1.4 }}>
          {node.sublabel}
        </Typography>
      )}
      {node.reason && (
        <Typography variant="caption" sx={{ display: 'block', color: reasonColor, lineHeight: 1.4 }} noWrap title={node.reason}>
          {node.reason}
        </Typography>
      )}
    </Box>
  );
}

// The layout pre-routes every edge around the node boxes; this just draws the
// polyline with rounded corners plus a background-colored halo so crossings
// stay readable. Endpoints are snapped to the live handle positions so edges
// stay attached while a node is dragged (routes are recomputed on drag stop).
function TopologyEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd, style, label, labelStyle, interactionWidth }: EdgeProps<TopologyFlowEdge>) {
  const theme = useTheme();
  const routePoints =
    data?.routePoints && data.routePoints.length > 1
      ? alignRouteEndpoints(data.routePoints, { x: sourceX, y: sourceY }, { x: targetX, y: targetY })
      : [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY },
        ];
  const path = roundedRoutePath(routePoints);
  const mid = data?.labelPoint ?? pointAtFraction(routePoints, 0.5);
  const strokeWidth = typeof style?.strokeWidth === 'number' ? style.strokeWidth : 1.7;
  const opacity = typeof style?.opacity === 'number' ? style.opacity : 1;
  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={theme.palette.background.default}
        strokeWidth={strokeWidth + 4}
        strokeLinejoin="round"
        opacity={opacity}
      />
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth ?? 24} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
              background: theme.palette.background.paper,
              color: typeof labelStyle?.fill === 'string' ? labelStyle.fill : undefined,
              opacity,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1.2,
              padding: '1px 4px',
              borderRadius: 3,
              pointerEvents: 'none',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function alignRouteEndpoints(routePoints: RoutePoint[], source: RoutePoint, target: RoutePoint): RoutePoint[] {
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

function roundedRoutePath(points: RoutePoint[], radius = 14): string {
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

function pointAtFraction(points: RoutePoint[], fraction: number): RoutePoint {
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

// Parallel edges of the same kind often share a corridor, which would stack
// their labels on the exact same midpoint. Slide colliding labels along their
// own route until they find a free spot.
function placeEdgeLabels(edges: TopologyFlowEdge[]): TopologyFlowEdge[] {
  const fractions = [0.5, 0.38, 0.62, 0.26, 0.74, 0.14, 0.86];
  const occupied: RoutePoint[] = [];
  return edges.map((edge) => {
    const points = edge.data?.routePoints ?? [];
    if (!edge.label || points.length < 2) return edge;
    let chosen: RoutePoint | undefined;
    for (const fraction of fractions) {
      const candidate = pointAtFraction(points, fraction);
      if (!occupied.some((point) => Math.abs(point.x - candidate.x) < 64 && Math.abs(point.y - candidate.y) < 18)) {
        chosen = candidate;
        break;
      }
    }
    chosen ??= pointAtFraction(points, 0.5);
    occupied.push(chosen);
    return { ...edge, data: { ...edge.data!, routePoints: points, labelPoint: chosen } };
  });
}

const nodeTypes = { topology: TopologyNode };
const edgeTypes = { routed: TopologyEdge };

interface FlowState {
  nodes: TopologyFlowNode[];
  edges: TopologyFlowEdge[];
  warnings: string[];
  problemNodes: GraphNode[];
}

const emptyFlow: FlowState = { nodes: [], edges: [], warnings: [], problemNodes: [] };

export function toFlowState(layout: TopologyLayout): FlowState {
  // Fan-in/fan-out groups (a Service selecting 3 pods, 5 pods scheduled onto
  // one node) would repeat the same label on every edge — label each identical
  // text once per shared endpoint and let the rest stay bare lines.
  const labeled = new Set<string>();
  return {
    nodes: layout.nodes.map(({ node, position }) => ({
      id: node.id,
      type: 'topology',
      position,
      data: { graphNode: node },
    })),
    edges: placeEdgeLabels(layout.edges.map(({ edge, routePoints }) => {
      const text = edge.kind === 'owns' ? undefined : (edge.label ?? edge.kind);
      let label: string | undefined;
      if (text) {
        const bySource = `${text}|s|${edge.source}`;
        const byTarget = `${text}|t|${edge.target}`;
        if (!labeled.has(bySource) && !labeled.has(byTarget)) {
          labeled.add(bySource);
          labeled.add(byTarget);
          label = text;
        }
      }
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'routed',
        label,
        animated: DASHED_KINDS.has(edge.kind),
        // Colors resolve per theme mode in the render-side edges memo.
        style: { strokeWidth: 1.7 },
        labelStyle: { fontWeight: 700, fontSize: 11 },
        data: { routePoints, kind: edge.kind },
      };
    })),
    warnings: layout.warnings,
    problemNodes: layout.problemNodes,
  };
}

function isFocusedNode(node: GraphNode, focus: NonNullable<TopologyGraphProps['focus']>): boolean {
  return (
    node.ref.group === focus.group &&
    node.ref.version === focus.version &&
    node.ref.plural === focus.plural &&
    node.ref.name === focus.name &&
    node.ref.namespace === focus.namespace
  );
}

// Below this zoom the card text is too small to read, so a graph that only
// fits by shrinking further opens at this zoom instead, anchored on its entry
// side, and the minimap covers the rest.
const READABLE_ZOOM = 0.75;
const VIEW_PADDING = 32;

function layoutBounds(nodes: TopologyFlowNode[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
    maxY = Math.max(maxY, node.position.y + estimateNodeHeight(node.data.graphNode));
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export default function TopologyGraphImpl({
  contexts,
  namespaces,
  focus,
  hideDisconnected = true,
  foldReplicaSets,
  onFoldReplicaSetsChange,
  onStats,
  emptyTitle = 'No connected topology found',
}: TopologyGraphProps) {
  const theme = useTheme();
  const { data: graphs, isLoading, isPlaceholderData } = useTopologyGraphs(contexts, namespaces, focus);
  const openDetail = useDetailStore((s) => s.open);
  const pushDetail = useDetailStore((s) => s.push);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [interactive, setInteractive] = useState(false);
  // Folding is controlled by the Topology page (header switch) and local
  // everywhere else, e.g. the resource drawer's Map tab.
  const [localFold, setLocalFold] = useState(true);
  const fold = foldReplicaSets ?? localFold;
  const setFold = useCallback(
    (next: boolean) => {
      if (foldReplicaSets === undefined) setLocalFold(next);
      onFoldReplicaSetsChange?.(next);
    },
    [foldReplicaSets, onFoldReplicaSetsChange],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // On a graph larger than the screen the issue list would cover nodes, so it
  // starts collapsed there; the header still shows the count.
  const [issuesOpen, setIssuesOpen] = useState<boolean>();
  const showIssues = issuesOpen ?? !overflowing;
  // Remounts (tab switches, drawer reopens) reuse the cached layout for the
  // current data synchronously, so the finished graph is on screen from the
  // very first frame instead of after an async layout pass.
  const laidOut = useRef<{ graphs: RelationshipGraph[] | undefined; hide: boolean; fold: boolean } | null>(null);
  const [flow, setFlow] = useState<FlowState>(() => {
    const initialFold = foldReplicaSets ?? true;
    const cached = cachedTopologyLayout(graphs, hideDisconnected, initialFold);
    if (!cached) return emptyFlow;
    laidOut.current = { graphs, hide: hideDisconnected, fold: initialFold };
    return toFlowState(cached);
  });
  const [layoutPending, setLayoutPending] = useState(false);
  const instanceRef = useRef<ReactFlowInstance<TopologyFlowNode, TopologyFlowEdge> | null>(null);

  // ELK layout is async, so positions land in state instead of a useMemo.
  useEffect(() => {
    const current = laidOut.current;
    if (current && current.graphs === graphs && current.hide === hideDisconnected && current.fold === fold) return;
    let cancelled = false;
    setLayoutPending(true);
    layoutTopology(graphs, hideDisconnected, fold)
      .then((layout) => {
        if (cancelled) return;
        laidOut.current = { graphs, hide: hideDisconnected, fold };
        // Transition: rendering hundreds of nodes shouldn't block clicks/pans.
        // layoutPending clears inside it so the loading state holds until the
        // graph actually commits.
        startTransition(() => {
          setFlow(toFlowState(layout));
          setLayoutPending(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('topology layout failed', err);
        setFlow(emptyFlow);
        setLayoutPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graphs, hideDisconnected, fold]);

  // Re-fit the viewport when the set of displayed nodes changes (not on drag).
  // Focused graphs (opened from a resource drawer) center on the focused
  // resource instead of fitting the whole topology.
  const nodeIdsKey = useMemo(() => flow.nodes.map((node) => node.id).sort().join(), [flow.nodes]);
  const focusedNodeId = useMemo(
    () => (focus ? flow.nodes.find((node) => isFocusedNode(node.data.graphNode, focus))?.id : undefined),
    [flow.nodes, focus],
  );
  // Bounds come from the layout itself (known card sizes), so this doesn't
  // wait for xyflow to measure the rendered nodes.
  const flowNodesRef = useRef(flow.nodes);
  flowNodesRef.current = flow.nodes;
  useEffect(() => {
    if (!nodeIdsKey) return;
    const frame = requestAnimationFrame(() => {
      const instance = instanceRef.current;
      const container = containerRef.current;
      if (!instance || !container) return;
      const bounds = layoutBounds(flowNodesRef.current);
      const { width, height } = container.getBoundingClientRect();
      const fitZoom = Math.min((width - VIEW_PADDING * 2) / bounds.width, (height - VIEW_PADDING * 2) / bounds.height, 1);
      if (fitZoom >= READABLE_ZOOM) {
        void instance.fitView({ maxZoom: 1, padding: 0.08 });
        setOverflowing(false);
        return;
      }
      setOverflowing(true);
      // A focused map (a drawer's Map tab) centres on its resource instead.
      const focused = focusedNodeId ? flowNodesRef.current.find((node) => node.id === focusedNodeId) : undefined;
      if (focused) {
        const centerY = focused.position.y + estimateNodeHeight(focused.data.graphNode) / 2;
        void instance.setCenter(focused.position.x + NODE_WIDTH / 2, centerY, { zoom: READABLE_ZOOM });
        return;
      }
      const contentHeight = bounds.height * READABLE_ZOOM;
      const y = contentHeight <= height - VIEW_PADDING * 2 ? (height - contentHeight) / 2 - bounds.y * READABLE_ZOOM : VIEW_PADDING - bounds.y * READABLE_ZOOM;
      void instance.setViewport({ x: VIEW_PADDING - bounds.x * READABLE_ZOOM, y, zoom: READABLE_ZOOM });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeIdsKey, focusedNodeId]);

  const focusNode = useCallback((id: string) => {
    const node = flowNodesRef.current.find((candidate) => candidate.id === id);
    const instance = instanceRef.current;
    if (!node || !instance) return;
    setSelectedNodeId(id);
    const zoom = Math.max(instance.getZoom(), READABLE_ZOOM);
    void instance.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + estimateNodeHeight(node.data.graphNode) / 2, { zoom, duration: 300 });
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<TopologyFlowNode>[]) => {
    setFlow((f) => ({ ...f, nodes: applyNodeChanges(changes, f.nodes) }));
  }, []);

  const onNodeDragStop = useCallback(() => {
    setFlow((f) => {
      const boxes = f.nodes.map((node) => topologyNodeBox(node.id, node.position, node.data.graphNode));
      const routes = routeEdges(boxes, f.edges);
      return { ...f, edges: placeEdgeLabels(f.edges.map((edge) => ({ ...edge, data: { ...edge.data!, routePoints: routes.get(edge.id) ?? [] } }))) };
    });
  }, []);

  const activeSelectedNodeId = flow.nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : undefined;

  const connectedNodeIds = useMemo(() => {
    if (!activeSelectedNodeId) return undefined;
    const connected = new Set([activeSelectedNodeId]);
    for (const edge of flow.edges) {
      if (edge.source === activeSelectedNodeId) connected.add(edge.target);
      if (edge.target === activeSelectedNodeId) connected.add(edge.source);
    }
    return connected;
  }, [activeSelectedNodeId, flow.edges]);

  const nodes = useMemo<TopologyFlowNode[]>(
    () =>
      flow.nodes.map((node) => ({
        ...node,
        selected: node.id === activeSelectedNodeId,
        style: { ...node.style, opacity: !connectedNodeIds || connectedNodeIds.has(node.id) ? 1 : 0.22 },
      })),
    [activeSelectedNodeId, connectedNodeIds, flow.nodes],
  );

  const edges = useMemo<TopologyFlowEdge[]>(
    () => {
      const edgeColors = EDGE_COLOR[theme.palette.mode];
      const styled = flow.edges.map((edge) => {
        const connected = !activeSelectedNodeId || edge.source === activeSelectedNodeId || edge.target === activeSelectedNodeId;
        const color = edgeColors[edge.data!.kind];
        return {
          ...edge,
          selected: !!activeSelectedNodeId && connected,
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: { ...edge.style, stroke: color, strokeWidth: activeSelectedNodeId && connected ? 2.8 : edge.style?.strokeWidth, opacity: connected ? 1 : 0.1 },
          // Labels would need wide gaps between columns; the footer legend
          // explains the colors, and a highlighted node names its links.
          label: activeSelectedNodeId && connected ? edge.label : undefined,
          labelStyle: { ...edge.labelStyle, fill: color },
        };
      });
      // Edges paint in array order within the edge layer, and every edge
      // carries a background-colored halo, so a dimmed edge drawn later would
      // mask a highlighted one. Keep the selected node's edges on top (stable
      // sort preserves order within each group).
      return activeSelectedNodeId ? styled.sort((a, b) => Number(a.selected) - Number(b.selected)) : styled;
    },
    [activeSelectedNodeId, flow.edges, theme.palette.mode],
  );
  const { warnings, problemNodes } = flow;
  const foldedCount = useMemo(() => flow.nodes.filter((node) => isFoldedReplicaSets(node.data.graphNode)).length, [flow.nodes]);
  const resourceCount = flow.nodes.length - foldedCount;
  // A folded placeholder's owner edge stands in for hidden links, so it isn't counted.
  const linkCount = useMemo(() => flow.edges.filter((edge) => !edge.target.startsWith(FOLDED_REPLICASETS_PREFIX)).length, [flow.edges]);
  const edgeKinds = useMemo(() => [...new Set(flow.edges.map((edge) => edge.data!.kind))].sort(), [flow.edges]);
  useEffect(() => {
    onStats?.({ resources: resourceCount, links: linkCount, issues: problemNodes.length, folded: foldedCount });
  }, [onStats, resourceCount, linkCount, problemNodes.length, foldedCount]);
  // keepPreviousData preserves the prior graph while a new scope is fetched.
  // Keep it visible for a fast transition, but mark it as stale until both the
  // request and layout for the current data have completed.
  const layoutOutOfDate =
    graphs !== undefined && (laidOut.current?.graphs !== graphs || laidOut.current.hide !== hideDisconnected || laidOut.current.fold !== fold);
  const topologyPending = isPlaceholderData || layoutPending || layoutOutOfDate;
  const loading = nodes.length === 0 && (isLoading || topologyPending);
  const updating = nodes.length > 0 && topologyPending;

  const inspectNode = (node: Node) => {
    const graphNode = (node.data as TopologyNodeData).graphNode;
    const selection = {
      ctx: graphNode.ref.ctx,
      group: graphNode.ref.group,
      version: graphNode.ref.version,
      plural: graphNode.ref.plural,
      kind: graphNode.ref.kind,
      name: graphNode.ref.name,
      namespace: graphNode.ref.namespace,
    };
    if (focus) {
      if (!isFocusedNode(graphNode, focus)) pushDetail(selection);
    } else {
      openDetail(selection);
    }
  };

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'relative',
        height: '100%',
        minHeight: 360,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.default',
        '& .react-flow__controls': {
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          boxShadow: theme.shadows[4],
        },
        '& .react-flow__controls-button': {
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottomColor: 'divider',
          '&:hover': { bgcolor: 'action.hover' },
          '& svg': { fill: 'currentColor' },
        },
        '& .react-flow__minimap': { overflow: 'hidden' },
        '& .react-flow__attribution': {
          bgcolor: 'background.paper',
          color: 'text.secondary',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          px: 0.5,
        },
      }}
      aria-busy={loading || updating}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.12}
        maxZoom={2}
        // Double-click opens a node. Locked nodes aren't draggable, so xyflow
        // doesn't mark them `nopan`, and its double-click zoom would swallow
        // the event before onNodeDoubleClick sees it.
        zoomOnDoubleClick={false}
        nodesDraggable={interactive}
        nodesConnectable={false}
        elementsSelectable={interactive}
        onInit={(instance) => {
          instanceRef.current = instance;
        }}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => {
          if (isFoldedReplicaSets((node.data as TopologyNodeData).graphNode)) setFold(false);
          else setSelectedNodeId(node.id);
        }}
        onNodeDoubleClick={(_event, node) => {
          if (!isFoldedReplicaSets((node.data as TopologyNodeData).graphNode)) inspectNode(node);
        }}
        onPaneClick={() => setSelectedNodeId(undefined)}
      >
        <Background color={theme.palette.divider} />
        <Controls onInteractiveChange={setInteractive} />
        {overflowing && nodes.length > 0 && (
          <MiniMap
            pannable
            zoomable
            ariaLabel="Topology overview"
            nodeColor={(node) => nodeStatusColor((node.data as TopologyNodeData).graphNode.status, theme)}
            nodeStrokeWidth={0}
            nodeBorderRadius={2}
            maskColor={alpha(theme.palette.background.default, 0.72)}
            style={{ width: 168, height: 104, backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 8 }}
          />
        )}
      </ReactFlow>

      {!loading && !updating && (problemNodes.length > 0 || warnings.length > 0) && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 300,
            maxWidth: 'calc(100% - 24px)',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            boxShadow: 4,
            overflow: 'hidden',
          }}
        >
          {problemNodes.length > 0 ? (
            <>
              <ButtonBase
                onClick={() => setIssuesOpen((open) => !open)}
                aria-expanded={showIssues}
                sx={{ width: '100%', justifyContent: 'space-between', px: 1.25, py: 0.75, typography: 'caption', fontWeight: 600 }}
              >
                {problemNodes.length} {problemNodes.length === 1 ? 'issue' : 'issues'}
                <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary', transform: showIssues ? 'rotate(180deg)' : undefined }} />
              </ButtonBase>
              {showIssues && (
                <Box sx={{ maxHeight: 208, overflowY: 'auto', pb: 0.5 }}>
                  {problemNodes.map((node) => (
                    <ButtonBase
                      key={node.id}
                      onClick={() => focusNode(node.id)}
                      title={`${node.ref.kind}/${node.label}: ${node.reason ?? node.status}`}
                      sx={{ display: 'block', width: '100%', textAlign: 'left', px: 1.25, py: 0.25, '&:hover': { bgcolor: 'action.hover' } }}
                    >
                      <Typography variant="caption" noWrap sx={{ display: 'block', color: statusTextColor(node.status === 'error' ? 'error' : 'warning')(theme) }}>
                        {node.ref.kind}/{node.label}: {node.reason ?? node.status}
                      </Typography>
                    </ButtonBase>
                  ))}
                </Box>
              )}
            </>
          ) : (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.25, py: 0.75 }} noWrap title={warnings[0]}>
              {warnings[0]}
            </Typography>
          )}
        </Box>
      )}

      {!loading && !updating && nodes.length > 0 && (
        <Stack
          direction="row"
          useFlexGap
          sx={{
            position: 'absolute',
            left: 52,
            bottom: 10,
            // Stays clear of the minimap, or else of the attribution badge.
            maxWidth: `calc(100% - ${overflowing ? 248 : 160}px)`,
            flexWrap: 'wrap',
            columnGap: 1.5,
            rowGap: 0.25,
            alignItems: 'center',
            pointerEvents: 'none',
            overflow: 'hidden',
            px: 1,
            py: 0.25,
            borderRadius: 1,
            bgcolor: alpha(theme.palette.background.default, 0.9),
          }}
        >
          {/* Without a page header (a drawer's Map tab) the counts lead the
              footer so a narrow drawer wraps the hint, never the numbers. */}
          {!onStats && (
            <Typography variant="caption" sx={{ flexShrink: 0, fontWeight: 600, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
              {countLabel(resourceCount, 'resource')} · {countLabel(linkCount, 'link')}
            </Typography>
          )}
          {edgeKinds.map((kind) => (
            <Stack key={kind} direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
              <svg width="18" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="18" y2="3" stroke={EDGE_COLOR[theme.palette.mode][kind]} strokeWidth="2" strokeDasharray={DASHED_KINDS.has(kind) ? '4 3' : undefined} />
              </svg>
              <Typography variant="caption" color="text.secondary">
                {kind}
              </Typography>
            </Stack>
          ))}
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, maxWidth: '100%' }}>
            Click a node to highlight its links, double-click to open it.
            {foldedCount > 0 && ' Dashed cards hold old ReplicaSets.'}
          </Typography>
        </Stack>
      )}

      {!isLoading && !topologyPending && nodes.length === 0 && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Box sx={{ textAlign: 'center', px: 2 }}>
            <Typography variant="subtitle2">{emptyTitle}</Typography>
            <Typography variant="body2" color="text.secondary">
              Try a workload, service, pod, PVC, ingress, or a namespace with related resources.
            </Typography>
          </Box>
        </Box>
      )}

      {(loading || updating) && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: updating ? 'auto' : 'none',
            bgcolor: updating ? 'action.disabledBackground' : undefined,
          }}
        >
          <Stack
            component="output"
            spacing={1}
            aria-live="polite"
            sx={{
              alignItems: 'center',
              ...(updating && {
                bgcolor: 'background.paper',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                boxShadow: 2,
                px: 2,
                py: 1.5,
              }),
            }}
          >
            <CircularProgress size={24} />
            <Typography component="span" variant="body2" color="text.secondary">
              {updating ? 'Updating topology…' : 'Loading topology…'}
            </Typography>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
