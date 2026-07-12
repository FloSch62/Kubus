import { useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { GraphEdge, GraphNode, GraphNodeStatus, RelationshipGraph } from '@kubus/shared';
import { useTopologyGraphs } from '../api/queries.js';
import { useDetailStore } from '../state/detail.js';
import type { TopologyGraphProps } from './TopologyGraph.js';

interface TopologyNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
}

const LAYERS: GraphNode['layer'][] = ['entry', 'route', 'service', 'workload', 'replicaset', 'pod', 'storage', 'node', 'operator', 'other'];

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
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 8, height: 8, border: 0, background: color }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 8, height: 8, border: 0, background: color }}
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

const nodeTypes = { topology: TopologyNode };

function degreeMap(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function flowLayout(graphs: RelationshipGraph[] | undefined, hideDisconnected: boolean) {
  const flowNodes: Array<Node<TopologyNodeData>> = [];
  const flowEdges: Edge[] = [];
  const warnings: string[] = [];
  const problemNodes: GraphNode[] = [];
  let yOffset = 0;

  for (const graph of graphs ?? []) {
    warnings.push(...graph.warnings.map((w) => `${graph.ctx}: ${w}`));
    const degree = degreeMap(graph.edges);
    const keep = new Set<string>();
    const byLayer = new Map<GraphNode['layer'], GraphNode[]>();
    for (const node of graph.nodes) {
      const isProblem = node.status === 'warning' || node.status === 'error';
      if (hideDisconnected && (degree.get(node.id) ?? 0) === 0 && !isProblem) continue;
      keep.add(node.id);
      if (isProblem) problemNodes.push(node);
      const layerNodes = byLayer.get(node.layer);
      if (layerNodes) layerNodes.push(node);
      else byLayer.set(node.layer, [node]);
    }
    const layerHeight = Math.max(1, ...[...byLayer.values()].map((items) => items.length)) * 104;

    for (const [layerIdx, layer] of LAYERS.entries()) {
      const items = [...(byLayer.get(layer) ?? [])].sort((a, b) => `${a.ref.namespace ?? ''}/${a.label}`.localeCompare(`${b.ref.namespace ?? ''}/${b.label}`));
      for (const [idx, node] of items.entries()) {
        flowNodes.push({
          id: node.id,
          type: 'topology',
          position: { x: layerIdx * 300, y: yOffset + idx * 104 },
          data: { graphNode: node },
          draggable: true,
        });
      }
    }
    for (const edge of graph.edges) {
      if (!keep.has(edge.source) || !keep.has(edge.target)) continue;
      flowEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.kind === 'owns' ? undefined : (edge.label ?? edge.kind),
        type: 'smoothstep',
        animated: edge.kind === 'routes' || edge.kind === 'selects',
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[edge.kind] },
        style: { strokeWidth: 1.7, stroke: EDGE_COLOR[edge.kind] },
        labelStyle: { fill: EDGE_COLOR[edge.kind], fontWeight: 700, fontSize: 11 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
      });
    }
    yOffset += layerHeight + 140;
  }

  return { nodes: flowNodes, edges: flowEdges, warnings, problemNodes };
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
  const { data: graphs, isLoading } = useTopologyGraphs(contexts, namespaces, focus);
  const openDetail = useDetailStore((s) => s.open);
  const pushDetail = useDetailStore((s) => s.push);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const layout = useMemo(() => flowLayout(graphs, hideDisconnected), [graphs, hideDisconnected]);
  const activeSelectedNodeId = layout.nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : undefined;

  const connectedNodeIds = useMemo(() => {
    if (!activeSelectedNodeId) return undefined;
    const connected = new Set([activeSelectedNodeId]);
    for (const edge of layout.edges) {
      if (edge.source === activeSelectedNodeId) connected.add(edge.target);
      if (edge.target === activeSelectedNodeId) connected.add(edge.source);
    }
    return connected;
  }, [activeSelectedNodeId, layout.edges]);

  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => ({
        ...node,
        selected: node.id === activeSelectedNodeId,
        style: { ...node.style, opacity: !connectedNodeIds || connectedNodeIds.has(node.id) ? 1 : 0.22 },
      })),
    [activeSelectedNodeId, connectedNodeIds, layout.nodes],
  );

  const edges = useMemo(
    () =>
      layout.edges.map((edge) => {
        const connected = !activeSelectedNodeId || edge.source === activeSelectedNodeId || edge.target === activeSelectedNodeId;
        return {
          ...edge,
          selected: !!activeSelectedNodeId && connected,
          style: { ...edge.style, strokeWidth: activeSelectedNodeId && connected ? 2.8 : edge.style?.strokeWidth, opacity: connected ? 1 : 0.1 },
          labelStyle: { ...edge.labelStyle, opacity: connected ? 1 : 0.1 },
        };
      }),
    [activeSelectedNodeId, layout.edges],
  );
  const { warnings, problemNodes } = layout;

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
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.12}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
        onNodeDoubleClick={(_event, node) => inspectNode(node)}
        onPaneClick={() => setSelectedNodeId(undefined)}
      >
        <Background color={theme.palette.divider} />
        <Controls />
      </ReactFlow>

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

      {!isLoading && nodes.length === 0 && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Box sx={{ textAlign: 'center', px: 2 }}>
            <Typography variant="subtitle2">{emptyTitle}</Typography>
            <Typography variant="body2" color="text.secondary">
              Try a workload, service, pod, PVC, ingress, or a namespace with related resources.
            </Typography>
          </Box>
        </Box>
      )}

      {isLoading && (
        <Box sx={{ position: 'absolute', left: 12, bottom: 12, bgcolor: 'background.paper', px: 1, py: 0.5, borderRadius: 1, border: 1, borderColor: 'divider', boxShadow: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Loading topology…
          </Typography>
        </Box>
      )}
    </Box>
  );
}
