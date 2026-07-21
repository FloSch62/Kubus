import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
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
import { cachedTopologyLayout, layoutTopology, routeEdges, topologyNodeBox, type RoutePoint, type TopologyLayout } from './topology-layout.js';
import type { TopologyGraphProps } from './TopologyGraph.js';

interface TopologyNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
}

interface TopologyEdgeData extends Record<string, unknown> {
  routePoints: RoutePoint[];
  labelPoint?: RoutePoint;
}

type TopologyFlowNode = Node<TopologyNodeData>;
type TopologyFlowEdge = Edge<TopologyEdgeData>;

const STATUS_COLOR: Record<GraphNodeStatus, string> = {
  success: '#2e7d32',
  warning: '#ed6c02',
  error: '#d32f2f',
  unknown: '#6b7280',
};

const EDGE_COLOR: Record<GraphEdge['kind'], string> = {
  owns: '#64748b',
  selects: '#2563eb',
  routes: '#7c3aed',
  mounts: '#0891b2',
  binds: '#0f766e',
  schedules: '#ca8a04',
  manages: '#9333ea',
};

function TopologyNode({ data, selected }: NodeProps) {
  const node = (data as TopologyNodeData).graphNode;
  const color = STATUS_COLOR[node.status];
  return (
    <Box
      sx={{
        position: 'relative',
        width: 236,
        border: 1,
        borderColor: selected ? 'primary.main' : 'divider',
        borderLeft: `5px solid ${color}`,
        bgcolor: 'background.paper',
        borderRadius: 1,
        boxShadow: selected ? 5 : 1,
        cursor: 'pointer',
        px: 1.25,
        py: 0.9,
      }}
    >
      {/* xyflow anchors handles to the padding box, so the asymmetric borders
          (5px status stripe left, 1px right) need compensating offsets to put
          both dots on the outer edge. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 8, height: 8, border: 0, background: color, left: -5 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 8, height: 8, border: 0, background: color, right: -1 }}
      />
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <Chip label={node.ref.kind} size="small" sx={{ height: 18, fontSize: 10, maxWidth: 120 }} />
        <Typography variant="caption" color="text.secondary" noWrap>
          {node.layer}
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ fontWeight: 700, mt: 0.5 }} noWrap title={node.label}>
        {node.label}
      </Typography>
      {node.sublabel && (
        <Typography variant="caption" color="text.secondary" noWrap title={node.sublabel}>
          {node.sublabel}
        </Typography>
      )}
      {node.reason && (
        <Typography variant="caption" sx={{ display: 'block', color, mt: 0.25 }} noWrap title={node.reason}>
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
    return { ...edge, data: { ...edge.data, routePoints: points, labelPoint: chosen } };
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

function toFlowState(layout: TopologyLayout): FlowState {
  return {
    nodes: layout.nodes.map(({ node, position }) => ({
      id: node.id,
      type: 'topology',
      position,
      data: { graphNode: node },
      draggable: true,
    })),
    edges: placeEdgeLabels(layout.edges.map(({ edge, routePoints }) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'routed',
      label: edge.kind === 'owns' ? undefined : (edge.label ?? edge.kind),
      animated: edge.kind === 'routes' || edge.kind === 'selects',
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[edge.kind] },
      style: { strokeWidth: 1.7, stroke: EDGE_COLOR[edge.kind] },
      labelStyle: { fill: EDGE_COLOR[edge.kind], fontWeight: 700, fontSize: 11 },
      data: { routePoints },
    }))),
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

export default function TopologyGraphImpl({
  contexts,
  namespaces,
  focus,
  hideDisconnected = true,
  emptyTitle = 'No connected topology found',
}: TopologyGraphProps) {
  const theme = useTheme();
  const { data: graphs, isLoading, isPlaceholderData } = useTopologyGraphs(contexts, namespaces, focus);
  const openDetail = useDetailStore((s) => s.open);
  const pushDetail = useDetailStore((s) => s.push);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  // Remounts (tab switches, drawer reopens) reuse the cached layout for the
  // current data synchronously, so the finished graph is on screen from the
  // very first frame instead of after an async layout pass.
  const laidOut = useRef<{ graphs: RelationshipGraph[] | undefined; hide: boolean } | null>(null);
  const [flow, setFlow] = useState<FlowState>(() => {
    const cached = cachedTopologyLayout(graphs, hideDisconnected);
    if (!cached) return emptyFlow;
    laidOut.current = { graphs, hide: hideDisconnected };
    return toFlowState(cached);
  });
  const [layoutPending, setLayoutPending] = useState(false);
  const instanceRef = useRef<ReactFlowInstance<TopologyFlowNode, TopologyFlowEdge> | null>(null);

  // ELK layout is async, so positions land in state instead of a useMemo.
  useEffect(() => {
    if (laidOut.current && laidOut.current.graphs === graphs && laidOut.current.hide === hideDisconnected) return;
    let cancelled = false;
    setLayoutPending(true);
    layoutTopology(graphs, hideDisconnected)
      .then((layout) => {
        if (cancelled) return;
        laidOut.current = { graphs, hide: hideDisconnected };
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
  }, [graphs, hideDisconnected]);

  // Re-fit the viewport when the set of displayed nodes changes (not on drag).
  // Focused graphs (opened from a resource drawer) center on the focused
  // resource instead of fitting the whole topology.
  const nodeIdsKey = useMemo(() => flow.nodes.map((node) => node.id).sort().join(), [flow.nodes]);
  const focusedNodeId = useMemo(
    () => (focus ? flow.nodes.find((node) => isFocusedNode(node.data.graphNode, focus))?.id : undefined),
    [flow.nodes, focus],
  );
  useEffect(() => {
    if (!nodeIdsKey) return;
    const frame = requestAnimationFrame(() => {
      void instanceRef.current?.fitView({
        maxZoom: 1,
        ...(focusedNodeId ? { nodes: [{ id: focusedNodeId }] } : {}),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeIdsKey, focusedNodeId]);

  const onNodesChange = useCallback((changes: NodeChange<TopologyFlowNode>[]) => {
    setFlow((f) => ({ ...f, nodes: applyNodeChanges(changes, f.nodes) }));
  }, []);

  const onNodeDragStop = useCallback(() => {
    setFlow((f) => {
      const boxes = f.nodes.map((node) => topologyNodeBox(node.id, node.position, node.data.graphNode));
      const routes = routeEdges(boxes, f.edges);
      return { ...f, edges: placeEdgeLabels(f.edges.map((edge) => ({ ...edge, data: { routePoints: routes.get(edge.id) ?? [] } }))) };
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
      const styled = flow.edges.map((edge) => {
        const connected = !activeSelectedNodeId || edge.source === activeSelectedNodeId || edge.target === activeSelectedNodeId;
        return {
          ...edge,
          selected: !!activeSelectedNodeId && connected,
          style: { ...edge.style, strokeWidth: activeSelectedNodeId && connected ? 2.8 : edge.style?.strokeWidth, opacity: connected ? 1 : 0.1 },
          labelStyle: { ...edge.labelStyle, opacity: connected ? 1 : 0.1 },
        };
      });
      // Edges paint in array order within the edge layer, and every edge
      // carries a background-colored halo, so a dimmed edge drawn later would
      // mask a highlighted one. Keep the selected node's edges on top (stable
      // sort preserves order within each group).
      return activeSelectedNodeId ? styled.sort((a, b) => Number(a.selected) - Number(b.selected)) : styled;
    },
    [activeSelectedNodeId, flow.edges],
  );
  const { warnings, problemNodes } = flow;
  // keepPreviousData preserves the prior graph while a new scope is fetched.
  // Keep it visible for a fast transition, but mark it as stale until both the
  // request and layout for the current data have completed.
  const layoutOutOfDate =
    graphs !== undefined && (laidOut.current?.graphs !== graphs || laidOut.current.hide !== hideDisconnected);
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
        fitView
        minZoom={0.12}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onInit={(instance) => {
          instanceRef.current = instance;
        }}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
        onNodeDoubleClick={(_event, node) => inspectNode(node)}
        onPaneClick={() => setSelectedNodeId(undefined)}
      >
        <Background color={theme.palette.divider} />
        <Controls />
      </ReactFlow>

      {!loading && !updating && (
      <Box
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          width: 280,
          maxWidth: 'calc(100% - 24px)',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          boxShadow: 4,
          p: 1.25,
        }}
      >
        <Stack direction="row" spacing={0.75} sx={{ mb: 0.75, flexWrap: 'wrap' }}>
          <Chip size="small" label={`${nodes.length} nodes`} variant="outlined" />
          <Chip size="small" label={`${edges.length} links`} variant="outlined" />
          {problemNodes.length > 0 && <Chip size="small" label={`${problemNodes.length} issues`} color="warning" variant="outlined" />}
        </Stack>
        {problemNodes.slice(0, 4).map((node) => (
          <Typography key={node.id} variant="caption" color={node.status === 'error' ? 'error.main' : 'warning.main'} sx={{ display: 'block' }} noWrap title={`${node.ref.kind}/${node.label}: ${node.reason ?? node.status}`}>
            {node.ref.kind}/{node.label}: {node.reason ?? node.status}
          </Typography>
        ))}
        {problemNodes.length === 0 && warnings.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap title={warnings[0]}>
            {warnings[0]}
          </Typography>
        )}
        {problemNodes.length === 0 && warnings.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            Click a node to highlight its connections. Double-click to inspect it.
          </Typography>
        )}
      </Box>
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
