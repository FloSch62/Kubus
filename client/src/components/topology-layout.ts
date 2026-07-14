import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';
import type { GraphEdge, GraphNode, RelationshipGraph } from '@kubus/shared';

export const NODE_WIDTH = 236;

export const LAYERS: GraphNode['layer'][] = ['entry', 'route', 'service', 'workload', 'replicaset', 'pod', 'storage', 'node', 'operator', 'other'];

// The ELK engine is ~1.4MB of generated code; running it in a worker keeps
// both its parse cost and the layout computation off the main thread.
const elk = new ELK({ workerFactory: () => new ElkWorker() });

const layerSpacing = 150;
const nodeSpacing = 48;
const graphGap = 140;
const routePadding = 18;
const routeEndpointOffset = 34;
const routeOuterMargin = 160;
const routeBendPenalty = 42;

export interface RoutePoint {
  x: number;
  y: number;
}

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedNode {
  node: GraphNode;
  position: RoutePoint;
}

export interface RoutedGraphEdge {
  edge: GraphEdge;
  routePoints: RoutePoint[];
}

export interface TopologyLayout {
  nodes: PlacedNode[];
  edges: RoutedGraphEdge[];
  warnings: string[];
  problemNodes: GraphNode[];
}

// Mirrors the rendered TopologyNode: chip row + title, plus optional
// sublabel/reason rows. Only used to size layout/routing obstacle boxes,
// so being a few pixels off is harmless.
export function estimateNodeHeight(node: GraphNode): number {
  return 58 + (node.sublabel ? 20 : 0) + (node.reason ? 22 : 0);
}

export function topologyNodeBox(id: string, position: RoutePoint, node: GraphNode): LayoutBox {
  return { id, x: position.x, y: position.y, width: NODE_WIDTH, height: estimateNodeHeight(node) };
}

function degreeMap(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

// React Query's structural sharing keeps the graphs array reference stable
// across refetches with identical data and across remounts, so keying on the
// reference lets remounts (tab switches, drawer reopens) reuse the finished
// layout instead of re-running ELK and the edge router.
const layoutCache = new WeakMap<RelationshipGraph[], Map<boolean, TopologyLayout>>();

export function cachedTopologyLayout(graphs: RelationshipGraph[] | undefined, hideDisconnected: boolean): TopologyLayout | undefined {
  return graphs ? layoutCache.get(graphs)?.get(hideDisconnected) : undefined;
}

// Lays out each graph with ELK (layered, semantic layers pinned via
// partitioning so columns keep their entry→…→other order), stacks the graphs
// vertically, then routes every edge orthogonally around the node boxes so
// lines never run underneath panels.
export async function layoutTopology(graphs: RelationshipGraph[] | undefined, hideDisconnected: boolean): Promise<TopologyLayout> {
  const cached = cachedTopologyLayout(graphs, hideDisconnected);
  if (cached) return cached;
  const placed: PlacedNode[] = [];
  const keptEdges: GraphEdge[] = [];
  const warnings: string[] = [];
  const problemNodes: GraphNode[] = [];
  let yOffset = 0;

  for (const [graphIdx, graph] of (graphs ?? []).entries()) {
    warnings.push(...graph.warnings.map((w) => `${graph.ctx}: ${w}`));
    const degree = degreeMap(graph.edges);
    const kept: GraphNode[] = [];
    const keep = new Set<string>();
    for (const node of graph.nodes) {
      const isProblem = node.status === 'warning' || node.status === 'error';
      if (hideDisconnected && (degree.get(node.id) ?? 0) === 0 && !isProblem) continue;
      keep.add(node.id);
      kept.push(node);
      if (isProblem) problemNodes.push(node);
    }
    if (kept.length === 0) continue;
    const graphEdges = graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
    keptEdges.push(...graphEdges);

    const elkGraph: ElkNode = {
      id: `graph-${graphIdx}`,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.partitioning.activate': 'true',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.spacing.nodeNodeBetweenLayers': `${layerSpacing}`,
        'elk.spacing.nodeNode': `${nodeSpacing}`,
        'elk.spacing.edgeEdge': '26',
        'elk.spacing.edgeNode': '42',
        'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      },
      children: kept.map((node) => ({
        id: node.id,
        width: NODE_WIDTH,
        height: estimateNodeHeight(node),
        layoutOptions: {
          'elk.partitioning.partition': `${Math.max(0, LAYERS.indexOf(node.layer))}`,
        },
      })),
      edges: graphEdges.map<ElkExtendedEdge>((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    };

    const result = await elk.layout(elkGraph);
    const layoutById = new Map((result.children ?? []).map((child) => [child.id, child]));
    let maxY = yOffset;
    for (const node of kept) {
      const child = layoutById.get(node.id);
      const position = { x: Math.round(child?.x ?? 0), y: Math.round(child?.y ?? 0) + yOffset };
      placed.push({ node, position });
      maxY = Math.max(maxY, position.y + estimateNodeHeight(node));
    }
    yOffset = maxY + graphGap;
  }

  const boxes = placed.map((p) => topologyNodeBox(p.node.id, p.position, p.node));
  const routes = routeEdges(boxes, keptEdges);
  const layout: TopologyLayout = {
    nodes: placed,
    edges: keptEdges.map((edge) => ({ edge, routePoints: routes.get(edge.id) ?? [] })),
    warnings,
    problemNodes,
  };
  if (graphs) {
    let byMode = layoutCache.get(graphs);
    if (!byMode) {
      byMode = new Map();
      layoutCache.set(graphs, byMode);
    }
    byMode.set(hideDisconnected, layout);
  }
  return layout;
}

// Routes every edge from the right side of its source box to the left side of
// its target box, avoiding all node boxes. Also used to re-route after the
// user drags a node.
export function routeEdges(boxes: LayoutBox[], edges: Array<{ id: string; source: string; target: string }>): Map<string, RoutePoint[]> {
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const bounds = boxesBounds(boxes);
  const obstacles = boxes.map((box) => expandedBox(box, routePadding));
  const routes = new Map<string, RoutePoint[]>();
  for (const edge of edges) {
    const source = boxById.get(edge.source);
    const target = boxById.get(edge.target);
    if (!source || !target) continue;
    routes.set(edge.id, routeSingleEdge(source, target, boxes, obstacles, bounds));
  }
  return routes;
}

function routeSingleEdge(source: LayoutBox, target: LayoutBox, boxes: LayoutBox[], obstacles: LayoutBox[], bounds: LayoutBox): RoutePoint[] {
  const start: RoutePoint = { x: source.x + source.width, y: Math.round(source.y + source.height / 2) };
  const end: RoutePoint = { x: target.x, y: Math.round(target.y + target.height / 2) };

  // Cheap path first: a single bend in the gap between layers covers the vast
  // majority of forward edges without touching the grid router.
  if (start.x <= end.x) {
    const direct = compactRoute([
      start,
      { x: Math.round((start.x + end.x) / 2), y: start.y },
      { x: Math.round((start.x + end.x) / 2), y: end.y },
      end,
    ]);
    if (!routeIntersectsBoxes(direct, boxes)) return direct;
  }

  const routeStart = { x: start.x + routeEndpointOffset, y: start.y };
  const routeEnd = { x: end.x - routeEndpointOffset, y: end.y };
  // Restrict the routing grid to boxes near the corridor between the two
  // endpoints — candidate coordinates only span that region, so far-away
  // boxes can never intersect a candidate segment.
  const corridor = expandedBox(pointsBounds([routeStart, routeEnd]), routeOuterMargin + routePadding + 1);
  const localObstacles = obstacles.filter((box) => boxesIntersect(box, corridor));
  const routed = findOrthogonalRoute(routeStart, routeEnd, localObstacles, pointsBounds([routeStart, routeEnd]));

  return compactRoute([
    start,
    routeStart,
    ...(routed ?? fallbackRoute(routeStart, routeEnd, bounds)).slice(1, -1),
    routeEnd,
    end,
  ]);
}

// A* over the Hanan grid spanned by obstacle borders, with a penalty per bend
// so routes prefer straight runs.
function findOrthogonalRoute(start: RoutePoint, end: RoutePoint, obstacles: LayoutBox[], bounds: LayoutBox): RoutePoint[] | null {
  const xCoordinates = uniqueSortedNumbers([
    start.x,
    end.x,
    bounds.x - routeOuterMargin,
    bounds.x + bounds.width + routeOuterMargin,
    ...obstacles.flatMap((box) => [box.x - routePadding, box.x + box.width + routePadding]),
  ]);
  const yCoordinates = uniqueSortedNumbers([
    start.y,
    end.y,
    bounds.y - routeOuterMargin,
    bounds.y + bounds.height + routeOuterMargin,
    ...obstacles.flatMap((box) => [box.y - routePadding, box.y + box.height + routePadding]),
  ]);
  const points: RoutePoint[] = [];
  const pointIndex = new Map<string, number>();

  for (const y of yCoordinates) {
    for (const x of xCoordinates) {
      const point = { x, y };
      if (obstacles.some((box) => pointInsideBox(point, box))) continue;
      pointIndex.set(pointKey(point), points.length);
      points.push(point);
    }
  }

  const startIndex = pointIndex.get(pointKey(start));
  const endIndex = pointIndex.get(pointKey(end));
  if (startIndex === undefined || endIndex === undefined) return null;

  const adjacency = buildRouteAdjacency(points, obstacles);
  const path = shortestRoute(points, adjacency, startIndex, endIndex);
  return path ? compactRoute(path.map((index) => points[index]!)) : null;
}

function buildRouteAdjacency(points: RoutePoint[], obstacles: LayoutBox[]): number[][] {
  const adjacency = Array.from({ length: points.length }, () => [] as number[]);
  const rows = new Map<number, number[]>();
  const columns = new Map<number, number[]>();

  points.forEach((point, index) => {
    rows.set(point.y, [...(rows.get(point.y) ?? []), index]);
    columns.set(point.x, [...(columns.get(point.x) ?? []), index]);
  });

  for (const row of rows.values()) {
    row.sort((first, second) => points[first]!.x - points[second]!.x);
    connectVisibleNeighbors(row, adjacency, points, obstacles);
  }
  for (const column of columns.values()) {
    column.sort((first, second) => points[first]!.y - points[second]!.y);
    connectVisibleNeighbors(column, adjacency, points, obstacles);
  }
  return adjacency;
}

function connectVisibleNeighbors(sortedIndexes: number[], adjacency: number[][], points: RoutePoint[], obstacles: LayoutBox[]): void {
  for (let index = 0; index < sortedIndexes.length - 1; index += 1) {
    const first = sortedIndexes[index]!;
    const second = sortedIndexes[index + 1]!;
    if (obstacles.some((box) => segmentIntersectsBox(points[first]!, points[second]!, box))) continue;
    adjacency[first]!.push(second);
    adjacency[second]!.push(first);
  }
}

function shortestRoute(points: RoutePoint[], adjacency: number[][], startIndex: number, endIndex: number): number[] | null {
  const directions = 3;
  const directionStart = 0;
  const directionHorizontal = 1;
  const directionVertical = 2;
  const totalStates = points.length * directions;
  const distances = Array.from({ length: totalStates }, () => Number.POSITIVE_INFINITY);
  const previous = Array<{ state: number; pointIndex: number } | null>(totalStates).fill(null);
  const heap = new RouteHeap();
  const startState = startIndex * directions + directionStart;
  distances[startState] = 0;
  heap.push({ state: startState, distance: 0, priority: 0 });

  while (heap.size) {
    const current = heap.pop();
    if (!current || current.distance !== distances[current.state]) continue;

    const currentPointIndex = Math.floor(current.state / directions);
    const currentDirection = current.state % directions;
    if (currentPointIndex === endIndex) return reconstructRoute(previous, current.state);

    for (const nextPointIndex of adjacency[currentPointIndex] ?? []) {
      const nextDirection = points[currentPointIndex]!.x === points[nextPointIndex]!.x ? directionVertical : directionHorizontal;
      const bendCost = currentDirection !== directionStart && currentDirection !== nextDirection ? routeBendPenalty : 0;
      const nextState = nextPointIndex * directions + nextDirection;
      const nextDistance = distances[current.state]! + manhattanDistance(points[currentPointIndex]!, points[nextPointIndex]!) + bendCost;
      if (nextDistance >= distances[nextState]!) continue;

      distances[nextState] = nextDistance;
      previous[nextState] = { state: current.state, pointIndex: currentPointIndex };
      heap.push({
        state: nextState,
        distance: nextDistance,
        priority: nextDistance + manhattanDistance(points[nextPointIndex]!, points[endIndex]!),
      });
    }
  }
  return null;
}

function reconstructRoute(previous: Array<{ state: number; pointIndex: number } | null>, endState: number): number[] {
  const directions = 3;
  const path = [Math.floor(endState / directions)];
  let currentState = endState;
  while (previous[currentState]) {
    const currentPrevious = previous[currentState]!;
    path.push(currentPrevious.pointIndex);
    currentState = currentPrevious.state;
  }
  return path.reverse();
}

// Last resort when the grid router fails: loop around the nearer outer edge
// of the whole layout, which is always clear of nodes.
function fallbackRoute(start: RoutePoint, end: RoutePoint, bounds: LayoutBox): RoutePoint[] {
  const y =
    Math.abs(start.y - (bounds.y - routeOuterMargin)) < Math.abs(start.y - (bounds.y + bounds.height + routeOuterMargin))
      ? bounds.y - routeOuterMargin
      : bounds.y + bounds.height + routeOuterMargin;
  return compactRoute([start, { x: start.x, y }, { x: end.x, y }, end]);
}

// Drops duplicate points and merges collinear runs into single segments.
function compactRoute(points: RoutePoint[]): RoutePoint[] {
  const deduped = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  const compacted: RoutePoint[] = [];
  for (const point of deduped) {
    const previous = compacted[compacted.length - 1];
    const beforePrevious = compacted[compacted.length - 2];
    if (
      previous &&
      beforePrevious &&
      ((beforePrevious.x === previous.x && previous.x === point.x) || (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      compacted[compacted.length - 1] = point;
      continue;
    }
    compacted.push(point);
  }
  return compacted;
}

function routeIntersectsBoxes(routePoints: RoutePoint[], boxes: LayoutBox[]): boolean {
  for (let index = 0; index < routePoints.length - 1; index += 1) {
    if (boxes.some((box) => segmentIntersectsBox(routePoints[index]!, routePoints[index + 1]!, box))) return true;
  }
  return false;
}

function segmentIntersectsBox(start: RoutePoint, end: RoutePoint, box: LayoutBox): boolean {
  if (start.y === end.y) {
    if (start.y <= box.y || start.y >= box.y + box.height) return false;
    return rangesOverlap(start.x, end.x, box.x, box.x + box.width);
  }
  if (start.x === end.x) {
    if (start.x <= box.x || start.x >= box.x + box.width) return false;
    return rangesOverlap(start.y, end.y, box.y, box.y + box.height);
  }
  return false;
}

function rangesOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  const firstMin = Math.min(firstStart, firstEnd);
  const firstMax = Math.max(firstStart, firstEnd);
  const secondMin = Math.min(secondStart, secondEnd);
  const secondMax = Math.max(secondStart, secondEnd);
  return firstMin < secondMax && firstMax > secondMin;
}

function boxesIntersect(first: LayoutBox, second: LayoutBox): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function expandedBox(box: LayoutBox, padding: number): LayoutBox {
  return { id: box.id, x: box.x - padding, y: box.y - padding, width: box.width + padding * 2, height: box.height + padding * 2 };
}

function boxesBounds(boxes: LayoutBox[]): LayoutBox {
  if (!boxes.length) return { id: 'bounds', x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { id: 'bounds', x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointsBounds(points: RoutePoint[]): LayoutBox {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { id: 'bounds', x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointInsideBox(point: RoutePoint, box: LayoutBox): boolean {
  return point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;
}

function pointKey(point: RoutePoint): string {
  return `${point.x}:${point.y}`;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)))].sort((first, second) => first - second);
}

function manhattanDistance(first: RoutePoint, second: RoutePoint): number {
  return Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
}

interface HeapItem {
  state: number;
  distance: number;
  priority: number;
}

class RouteHeap {
  private readonly items: HeapItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapItem): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): HeapItem | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (last && this.items.length) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let currentIndex = index;
    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (this.items[parentIndex]!.priority <= this.items[currentIndex]!.priority) return;
      [this.items[parentIndex], this.items[currentIndex]] = [this.items[currentIndex]!, this.items[parentIndex]!];
      currentIndex = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    let currentIndex = index;
    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = currentIndex * 2 + 2;
      let smallestIndex = currentIndex;
      if (leftIndex < this.items.length && this.items[leftIndex]!.priority < this.items[smallestIndex]!.priority) smallestIndex = leftIndex;
      if (rightIndex < this.items.length && this.items[rightIndex]!.priority < this.items[smallestIndex]!.priority) smallestIndex = rightIndex;
      if (smallestIndex === currentIndex) return;
      [this.items[currentIndex], this.items[smallestIndex]] = [this.items[smallestIndex]!, this.items[currentIndex]!];
      currentIndex = smallestIndex;
    }
  }
}
