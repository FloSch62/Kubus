import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, RelationshipGraph } from '@kubus/shared';
import TopologyGraphImpl, { toFlowState } from '../../../client/src/components/TopologyGraphImpl';
import { compactLabel, layerCaption } from '../../../client/src/components/topology-render';
import { saveTextFile } from '../../../client/src/save-file';

const query = vi.hoisted(() => ({ data: undefined as RelationshipGraph[] | undefined, isLoading: false, isPlaceholderData: false }));
vi.mock('../../../client/src/api/queries.js', () => ({ useTopologyGraphs: () => query }));
vi.mock('../../../client/src/save-file.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../client/src/save-file')>(),
  saveTextFile: vi.fn(),
}));

// jsdom has no canvas; measure 7px per character. The component caches the
// context on first use, so the mock is installed once for the whole file.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 7 }),
  } as unknown as CanvasRenderingContext2D);
});

describe('compactLabel', () => {
  it('keeps names that fit and elides the middle of long ones, keeping the pod suffix', () => {
    expect(compactLabel('podinfo', 140, 'font')).toBe('podinfo');
    const pod = compactLabel('podinfo-5c7cdc845b-cpkl2', 140, 'font');
    expect(pod).toMatch(/^podinfo-5c.*…-cpkl2$/);
    expect(pod.length * 7).toBeLessThanOrEqual(140);
    const long = compactLabel('kube-controller-manager-kubus-a-control-plane', 140, 'font');
    expect(long.endsWith('-plane')).toBe(true);
    expect(long.length * 7).toBeLessThanOrEqual(140);
  });
});

describe('layerCaption', () => {
  const node = (kind: string, layer: GraphNode['layer']): GraphNode => ({
    id: `${kind}/x`,
    label: 'x',
    layer,
    status: 'success',
    ref: { ctx: 'dev', group: '', version: 'v1', plural: 'x', kind, name: 'x', namespace: 'demo' },
  });

  it('names the layer beside the kind', () => {
    expect(layerCaption(node('Job', 'workload'), 'font')).toBe('WORKLOAD');
    expect(layerCaption(node('Ingress', 'entry'), 'font')).toBe('ENTRY');
    expect(layerCaption(node('ConfigMap', 'storage'), 'font')).toBe('STORAGE');
  });

  it('leaves it out when it repeats the kind, says nothing, or does not fit', () => {
    expect(layerCaption(node('Pod', 'pod'), 'font')).toBeUndefined();
    expect(layerCaption(node('Service', 'service'), 'font')).toBeUndefined();
    expect(layerCaption(node('Widget', 'other'), 'font')).toBeUndefined();
    expect(layerCaption(node('HorizontalPodAutoscaler', 'workload'), 'font')).toBeUndefined();
  });
});

describe('topology flow state', () => {
  it('lets the graph-level lock control node movement', () => {
    const graphNode: GraphNode = {
      id: 'pod/team-a/web-0',
      label: 'web-0',
      layer: 'workload',
      status: 'success',
      ref: {
        ctx: 'dev',
        group: '',
        version: 'v1',
        plural: 'pods',
        kind: 'Pod',
        name: 'web-0',
        namespace: 'team-a',
      },
    };

    const flow = toFlowState({
      nodes: [{ node: graphNode, position: { x: 0, y: 0 } }],
      edges: [],
      warnings: [],
      problemNodes: [],
    });

    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0]).not.toHaveProperty('draggable');
  });
});

describe('topology SVG download control', () => {
  beforeEach(() => {
    query.data = undefined;
    query.isLoading = false;
    query.isPlaceholderData = false;
    vi.mocked(saveTextFile).mockClear();
  });

  it('disables export for loading and empty graphs', async () => {
    query.isLoading = true;
    const { rerender } = render(<TopologyGraphImpl contexts={['dev']} namespaces={[]} />);
    expect(screen.getByRole('button', { name: 'Download topology as SVG' })).toBeDisabled();
    query.isLoading = false;
    rerender(<TopologyGraphImpl contexts={['dev']} namespaces={[]} />);
    await screen.findByText('No connected topology found');
    expect(screen.getByRole('button', { name: 'Download topology as SVG' })).toBeDisabled();
  });

  it('downloads a standalone SVG and blocks stale scope exports', async () => {
    query.data = [{ ctx: 'dev', edges: [], warnings: [], nodes: [{
      id: 'pod', label: 'web', status: 'success', layer: 'pod',
      ref: { ctx: 'dev', group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: 'web' },
    }] }];
    const { rerender } = render(<TopologyGraphImpl contexts={['dev']} namespaces={[]} hideDisconnected={false} />);
    const button = screen.getByRole('button', { name: 'Download topology as SVG' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(saveTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^kubus-topology-\d{8}-\d{6}\.svg$/),
      expect.stringContaining('<svg'),
      'image/svg+xml',
    );
    const doc = new DOMParser().parseFromString(vi.mocked(saveTextFile).mock.calls[0]![1], 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('g > title')!.textContent).toContain('Pod/web');
    query.isPlaceholderData = true;
    rerender(<TopologyGraphImpl contexts={['dev']} namespaces={[]} hideDisconnected={false} />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(saveTextFile).toHaveBeenCalledTimes(1);
  });
});
