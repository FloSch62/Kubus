import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTheme } from '../../../client/src/theme';
import { topologySvg } from '../../../client/src/components/topology-svg';
import type { TopologyFlowEdge, TopologyFlowNode } from '../../../client/src/components/TopologyGraphImpl';

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '', measureText: (text: string) => ({ width: text.length * 7 }),
  } as unknown as CanvasRenderingContext2D);
});

function node(id: string, x: number, y: number): TopologyFlowNode {
  return {
    id, position: { x, y }, data: { graphNode: {
      id, label: id, layer: 'pod', status: 'success',
      ref: { ctx: 'dev', namespace: 'demo', group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: id },
    } },
  };
}

function parse(svg: string) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
  return doc;
}

describe('topology SVG export', () => {
  it('exports moved and off-screen nodes plus outer routes and labels within the viewBox', () => {
    const nodes = [node('service', -300, 400), node('pod', 2000, 700)];
    nodes[1]!.measured = { width: 160, height: 84 };
    const edges: TopologyFlowEdge[] = [{
      id: 'selects', source: 'service', target: 'pod', label: 'http:8080',
      data: {
        kind: 'selects', labelPoint: { x: 800, y: -400 },
        routePoints: [{ x: -140, y: 425 }, { x: -100, y: -200 }, { x: 1900, y: -200 }, { x: 2000, y: 725 }],
      },
    }];
    const doc = parse(topologySvg(nodes, edges, buildTheme('light')));
    const [x, y, width, height] = doc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    expect([x, y]).toEqual([0, 0]);
    expect(width).toBeGreaterThan(2460);
    expect(height).toBeGreaterThan(1184);
    expect(doc.querySelector('g[transform="translate(2000 700)"]')).not.toBeNull();
    const path = doc.querySelector('path[marker-end]')!;
    expect(path.getAttribute('d')).toContain('L 2000 742');
    expect(path.getAttribute('stroke-dasharray')).toBe('5 4');
    expect(doc.querySelector('marker#arrow-selects')).not.toBeNull();
    expect([...doc.querySelectorAll('text')].map((text) => text.textContent)).toEqual(expect.arrayContaining(['service', 'pod', 'http:8080', 'selects']));
    expect(doc.querySelector('foreignObject, image, script, style')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('preserves %s theme colours and escapes resource text', (mode) => {
    const theme = buildTheme(mode);
    const resource = node('pod', 0, 0);
    resource.data.graphNode.status = 'error';
    resource.data.graphNode.label = 'a<&"pod';
    resource.data.graphNode.sublabel = 'demo & dev';
    resource.data.graphNode.reason = '<script>alert("bad")</script>';
    const doc = parse(topologySvg([resource], [], theme));
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('rect')!.getAttribute('fill')).toBe(theme.palette.background.default);
    expect(doc.querySelector('circle')!.getAttribute('fill')).toBe(theme.palette.error.main);
    const texts = [...doc.querySelectorAll('text')].map((text) => text.textContent);
    expect(texts).toContain(resource.data.graphNode.label);
    expect(texts).toContain(resource.data.graphNode.reason);
    expect(doc.querySelector('g > title')!.textContent).toContain('demo & dev');
  });

  it('keeps folded placeholders and only exports the supplied filtered layout', () => {
    const folded = node('folded-replicasets:deployment', 20, 30);
    folded.data.graphNode.label = '3 old ReplicaSets';
    const doc = parse(topologySvg([folded], [], buildTheme('light')));
    expect(doc.querySelector('g > rect')!.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(doc.querySelectorAll('clipPath')).toHaveLength(1);
    expect(doc.querySelector('g > title')!.textContent).toContain('3 old ReplicaSets');
  });

  it('rejects empty graphs instead of generating invalid bounds', () => {
    expect(() => topologySvg([], [], buildTheme('light'))).toThrow('There is no topology to export.');
  });
});
