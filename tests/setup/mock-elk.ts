export interface MockElkGraph {
  children?: Array<{ id: string; width?: number; height?: number }>;
}

export const elkLayoutCalls: MockElkGraph[] = [];

export default class MockElk {
  async layout(graph: MockElkGraph) {
    elkLayoutCalls.push(graph);
    return {
      children: (graph.children ?? []).map((child, index) => ({
        ...child,
        x: index * 360 + 24,
        y: index % 2 === 0 ? 24 : 140,
      })),
    };
  }
}
