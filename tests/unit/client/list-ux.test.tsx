import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GridColDef } from '@mui/x-data-grid';
import type { KubeObject, ObjectSignal } from '@kubus/shared';
import type { ClusterRow } from '../../../client/src/api/queries';
import { buildColumns, buildCrdColumns, signalHostField, withSignalMarker } from '../../../client/src/components/columns';
import { clusterColorIndexes, clusterTagColors, CLUSTER_TAG_PALETTE, shortContextName } from '../../../client/src/cluster-color';
import { ClusterTag } from '../../../client/src/components/ClusterTag';
import { MiddleEllipsis, middleEllipsisTail } from '../../../client/src/components/truncation';
import { nameColumnWidth } from '../../../client/src/components/name-width';
import { PageHeader } from '../../../client/src/components/PageHeader';
import { SmartFilterInput } from '../../../client/src/components/SmartFilterInput';

function pod(name: string, status: Record<string, unknown> = { phase: 'Running' }, labels?: Record<string, string>): ClusterRow {
  return {
    ctx: 'kind-dev',
    obj: { metadata: { name, namespace: 'team-a', uid: `uid-${name}`, labels }, spec: { containers: [{ name: 'app' }] }, status } as KubeObject,
  };
}

function renderCell(column: GridColDef<ClusterRow>, row: ClusterRow) {
  const value = (column.valueGetter as ((...args: unknown[]) => unknown) | undefined)?.(undefined, row, column, {});
  return render(<div data-testid="cell">{column.renderCell?.({ row, value, field: column.field } as never)}</div>);
}

describe('cluster tags', () => {
  it('shortens common kubeconfig context names', () => {
    expect(shortContextName('kind-kubus-a')).toBe('kubus-a');
    expect(shortContextName('arn:aws:eks:eu-west-1:123456789012:cluster/prod')).toBe('prod');
    expect(shortContextName('gke_my-project_europe-west1-b_staging')).toBe('staging');
    expect(shortContextName('minikube')).toBe('minikube');
    expect(shortContextName('kind-')).toBe('kind-');
  });

  it('gives the clusters shown together different, stable colors', () => {
    const a = clusterColorIndexes(['kind-kubus-a', 'kind-kubus-b']);
    expect(a.get('kind-kubus-a')).not.toBe(a.get('kind-kubus-b'));
    expect(clusterColorIndexes(['kind-kubus-b', 'kind-kubus-a'])).toEqual(a);
    const many = [...Array(CLUSTER_TAG_PALETTE.length).keys()].map((i) => `ctx-${i}`);
    expect(new Set(clusterColorIndexes(many).values()).size).toBe(CLUSTER_TAG_PALETTE.length);
  });

  it('draws the tag in the theme shade on a faint wash', () => {
    expect(clusterTagColors(0, 'light')).toEqual({ fg: CLUSTER_TAG_PALETTE[0]!.light, bg: `${CLUSTER_TAG_PALETTE[0]!.light}14` });
    expect(clusterTagColors(CLUSTER_TAG_PALETTE.length, 'dark').fg).toBe(CLUSTER_TAG_PALETTE[0]!.dark);
    render(<ClusterTag ctx="kind-kubus-a" colorIndex={1} />);
    expect(screen.getByTitle('kind-kubus-a')).toHaveTextContent('kubus-a');
  });

  it('renders the Cluster column as a tag while keeping the full name as its value', () => {
    const [cluster] = buildColumns(['cluster'], { multiCluster: true, clusterColors: new Map([['kind-dev', 2]]) });
    const row = pod('web-1');
    expect((cluster!.valueGetter as (...args: unknown[]) => unknown)(undefined, row, cluster, {})).toBe('kind-dev');
    renderCell(cluster!, row);
    expect(screen.getByTitle('kind-dev')).toHaveTextContent('dev');
  });
});

describe('name column', () => {
  it('keeps the distinguishing end of a long name', () => {
    expect(middleEllipsisTail('broken-deploy-6c54b9bfdf-2gvhg')).toBe(6);
    expect(middleEllipsisTail('backendtlspolicies.gateway.networking.k8s.io')).toBe(6);
    expect(middleEllipsisTail('kube-controller-manager-kind')).toBe(5);
    expect(middleEllipsisTail('web-1')).toBe(0);
    render(<MiddleEllipsis text="broken-deploy-6c54b9bfdf-2gvhg" />);
    const root = screen.getByTitle('broken-deploy-6c54b9bfdf-2gvhg');
    expect(root.children).toHaveLength(2);
    expect(root.lastElementChild).toHaveTextContent(/^-2gvhg$/);
  });

  it('renders short names as one span with the full name as title', () => {
    render(<MiddleEllipsis text="web-1" />);
    expect(screen.getByTitle('web-1').children).toHaveLength(0);
  });

  it('sizes to the longest name, between 180px and a share of the table', () => {
    const font = '400 13px Inter';
    expect(nameColumnWidth([pod('a'), pod('b')], font, 1200)).toBe(180);
    const long = pod('x'.repeat(60));
    const wide = nameColumnWidth([pod('a'), long], font, 0);
    expect(wide).toBeGreaterThan(400);
    expect(wide % 8).toBe(0);
    expect(nameColumnWidth([pod('a'), long], font, 800)).toBe(360);
    // The cap never goes below the minimum.
    expect(nameColumnWidth([long], font, 200)).toBe(180);
  });
});

describe('warning markers on status cells', () => {
  const warning: ObjectSignal = { warnings: [{ reason: 'BackOff', message: 'Back-off restarting failed container', count: 3 }], restarts: [] } as ObjectSignal;
  const restarts: ObjectSignal = { warnings: [], restarts: [{ container: 'app', restarts: 2 }] } as ObjectSignal;

  it('picks the status-like column that carries the marker', () => {
    expect(signalHostField(buildColumns(['name', 'namespace', 'ready', 'podStatus'], { multiCluster: false }))).toBe('podStatus');
    expect(signalHostField(buildColumns(['name', 'workloadReady'], { multiCluster: false }))).toBe('workloadReady');
    expect(signalHostField(buildColumns(['name', 'svcType'], { multiCluster: false }))).toBeUndefined();
    expect(signalHostField(buildCrdColumns([{ name: 'Phase', type: 'string', jsonPath: '.status.phase' }]))).toBe('crd_0_Phase');
  });

  it('adds the marker after a healthy-looking status', () => {
    const [status] = buildColumns(['podStatus'], { multiCluster: false });
    const lookup = vi.fn(() => restarts);
    renderCell(withSignalMarker(status!, lookup, 'Pod'), pod('web-1'));
    expect(screen.getByTestId('cell')).toHaveTextContent('Running');
    expect(screen.getByLabelText('Recent restarts')).toBeInTheDocument();
    expect(lookup).toHaveBeenCalledWith('kind-dev', 'Pod', 'team-a', 'web-1', 'uid-web-1');
  });

  it('puts the reasons on a problem status instead of a second glyph', () => {
    const [status] = buildColumns(['podStatus'], { multiCluster: false });
    const crashing = pod('web-2', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }] });
    renderCell(withSignalMarker(status!, () => warning, 'Pod'), crashing);
    expect(screen.getByTestId('cell')).toHaveTextContent('CrashLoopBackOff');
    expect(screen.queryByLabelText('Recent warning events')).not.toBeInTheDocument();
  });

  it('leaves the cell alone without a signal', () => {
    const [status] = buildColumns(['podStatus'], { multiCluster: false });
    renderCell(withSignalMarker(status!, () => undefined, 'Pod'), pod('web-3'));
    expect(screen.queryByLabelText(/Recent/)).not.toBeInTheDocument();
  });
});

describe('metrics availability', () => {
  it('explains missing CPU and memory in the column headers and cells', () => {
    const columns = buildColumns(['cpu', 'memory'], { multiCluster: false, metrics: () => undefined, metricsUnavailable: ['kind-dev'] });
    render(<div>{columns.map((c) => <span key={c.field}>{c.renderHeader?.({} as never)}</span>)}</div>);
    expect(screen.getByLabelText('CPU unavailable in kind-dev')).toBeInTheDocument();
    expect(screen.getByLabelText('Memory unavailable in kind-dev')).toBeInTheDocument();
  });

  it('keeps plain headers while every cluster reports metrics', () => {
    const [cpu] = buildColumns(['cpu'], { multiCluster: false, metrics: () => undefined });
    expect(cpu!.renderHeader).toBeUndefined();
  });
});

describe('PageHeader', () => {
  it('shows the count pill, subtitle and right-aligned actions', () => {
    render(<PageHeader title="Pods" count={1234} subtitle={<span>core/v1/Pod</span>} actions={<button>Create</button>} />);
    expect(screen.getByRole('heading', { name: 'Pods' })).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('core/v1/Pod')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('keeps children-only callers working', () => {
    render(<PageHeader title="Events"><span>448 events</span></PageHeader>);
    expect(screen.getByText('448 events')).toBeInTheDocument();
  });
});

describe('SmartFilterInput label tokens', () => {
  const rows = [pod('web-1', undefined, { app: 'web', tier: 'frontend' }), pod('api-1', undefined, { app: 'api' })];

  function Harness({ initial, onTerms }: { initial: string[]; onTerms: (terms: string[]) => void }) {
    const [text, setText] = useState('');
    const [terms, setTerms] = useState(initial);
    return (
      <SmartFilterInput
        value={text}
        onChange={setText}
        kind="Pod"
        rows={rows}
        labelTerms={terms}
        onLabelTermsChange={(next) => {
          setTerms(next);
          onTerms(next);
        }}
      />
    );
  }

  it('shows the selector as removable tokens', () => {
    const onTerms = vi.fn();
    render(<Harness initial={['app=web', 'tier=frontend']} onTerms={onTerms} />);
    expect(screen.getByText('app=web')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove label filter app=web'));
    expect(onTerms).toHaveBeenLastCalledWith(['tier=frontend']);
  });

  it('removes the last token with Backspace in an empty field', () => {
    const onTerms = vi.fn();
    render(<Harness initial={['app=web', 'tier=frontend']} onTerms={onTerms} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onTerms).toHaveBeenLastCalledWith(['app=web']);
  });

  it('adds a picked label suggestion as a token and clears the text', () => {
    const onTerms = vi.fn();
    render(<Harness initial={[]} onTerms={onTerms} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'web' } });
    const option = within(screen.getByRole('listbox')).getByText('app=web');
    fireEvent.click(option);
    expect(onTerms).toHaveBeenLastCalledWith(['app=web']);
    expect(input).toHaveValue('');
  });

  it('turns label:… plus Enter into a token', () => {
    const onTerms = vi.fn();
    render(<Harness initial={[]} onTerms={onTerms} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'label:env!=prod' } });
    // Move off the offered suggestion so Enter submits the typed text.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTerms).toHaveBeenLastCalledWith(['env!=prod']);
  });

  it('keeps the plain search box for callers without labels', () => {
    render(<SmartFilterInput value="" onChange={() => {}} kind="Event" rows={[]} />);
    expect(screen.getByPlaceholderText(/Search…/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove label filter/)).not.toBeInTheDocument();
  });
});
