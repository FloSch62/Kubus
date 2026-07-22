import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HelmInstallDialog from '../../../client/src/components/HelmInstallDialog';

const helm = vi.hoisted(() => ({
  repos: [] as Array<{ name: string; url: string }>,
  reposLoading: false,
  chartsByRepo: {} as Record<string, Array<Record<string, unknown>>>,
  chartsLoading: false,
  chartsError: undefined as Error | undefined,
  hubData: [] as Array<Record<string, unknown>> | undefined,
  hubFetching: false,
  hubError: undefined as Error | undefined,
  versions: [] as Array<{ version: string; appVersion?: string }>,
  hubVersions: undefined as { repoUrl?: string; versions?: Array<{ version: string; appVersion?: string }> } | undefined,
  hubVersionsLoading: false,
  repoDetail: undefined as Record<string, unknown> | undefined,
  urlDetail: undefined as Record<string, unknown> | undefined,
  ociDetail: undefined as Record<string, unknown> | undefined,
  directDetail: undefined as Record<string, unknown> | undefined,
  detailLoading: false,
  namespaces: ['default', 'team-a'] as string[],
  protectedContexts: new Set<string>(),
  removeMode: 'success' as 'success' | 'error',
  removePending: false,
  removeMutate: vi.fn(),
  installMode: 'success' as 'success' | 'error',
  installPending: false,
  installMutate: vi.fn(),
  dryMode: 'success' as 'success' | 'error',
  dryPending: false,
  dryPreview: undefined as Record<string, unknown> | undefined,
  dryMutate: vi.fn(),
  calls: {
    hubSearch: [] as string[],
    repoDetail: [] as unknown[][],
    urlDetail: [] as unknown[][],
    ociDetail: [] as unknown[][],
    directDetail: [] as unknown[],
    install: [] as Record<string, unknown>[],
    dry: [] as Record<string, unknown>[],
  },
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useHelmRepos: () => ({ data: helm.repos, isLoading: helm.reposLoading }),
  useHelmRepoCharts: (repo: string | undefined) => ({ data: repo ? helm.chartsByRepo[repo] : undefined, isLoading: helm.chartsLoading, error: helm.chartsError }),
  useHelmHubSearch: (query: string) => {
    helm.calls.hubSearch.push(query);
    return { data: helm.hubData, isFetching: helm.hubFetching, error: helm.hubError };
  },
  useRemoveHelmRepo: () => ({ isPending: helm.removePending, mutate: helm.removeMutate }),
  useHelmChartVersions: () => ({ data: helm.versions }),
  useHelmHubVersions: () => ({ data: helm.hubVersions, isLoading: helm.hubVersionsLoading }),
  useHelmChartDetail: (...args: unknown[]) => {
    helm.calls.repoDetail.push(args);
    return { data: helm.repoDetail, isLoading: helm.detailLoading };
  },
  useHelmChartDetailByUrl: (...args: unknown[]) => {
    helm.calls.urlDetail.push(args);
    return { data: helm.urlDetail, isLoading: helm.detailLoading };
  },
  useHelmOciDetail: (...args: unknown[]) => {
    helm.calls.ociDetail.push(args);
    return { data: helm.ociDetail, isLoading: helm.detailLoading };
  },
  useHelmChartSourceDetail: (source: unknown) => {
    helm.calls.directDetail.push(source);
    return { data: helm.directDetail, isLoading: helm.detailLoading };
  },
  useNamespaces: () => ({ data: helm.namespaces }),
  useHelmInstall: () => ({ isPending: helm.installPending, mutate: helm.installMutate }),
  useHelmInstallDryRun: () => ({ isPending: helm.dryPending, mutate: helm.dryMutate }),
}));

vi.mock('../../../client/src/state/clusters.js', () => ({
  useIsProtected: (ctx: string) => helm.protectedContexts.has(ctx),
}));
vi.mock('../../../client/src/state/prefs.js', () => ({
  useUiPrefsStore: (selector: (state: { monoFontSize: number }) => unknown) => selector({ monoFontSize: 13 }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, title, confirmLabel, busy, onConfirm, onClose }: { open: boolean; title: string; confirmLabel?: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) =>
    open ? (
      <dialog open aria-label={title}>
        <button disabled={busy} onClick={onConfirm}>Confirm {confirmLabel}</button>
        <button onClick={onClose}>Cancel confirmation</button>
      </dialog>
    ) : null,
}));
vi.mock('../../../client/src/components/HelmAddRepoDialog.js', () => ({
  HelmAddRepoDialog: ({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string) => void }) => (
    <dialog open aria-label="Add repository mock">
      <button onClick={() => onAdded('new-repo')}>Add repository mock</button>
      <button onClick={onClose}>Close repository mock</button>
    </dialog>
  ),
}));
vi.mock('../../../client/src/components/ChartMarkdown.js', () => ({ ChartMarkdown: ({ markdown, sourceUrl }: { markdown: string; sourceUrl?: string }) => <div>README mock {markdown} {sourceUrl}</div> }));
vi.mock('../../../client/src/components/ChartSourceLink.js', () => ({
  preferredChartSource: (sources?: string[], home?: string) => sources?.[0] ?? home,
  ChartSourceLink: ({ url }: { url?: string }) => url ? <a href={url}>Chart source</a> : null,
}));

function detail(version = '1.2.0'): Record<string, unknown> {
  return {
    name: 'nginx',
    version,
    appVersion: '1.25',
    icon: 'https://example.com/icon.png',
    home: 'https://example.com/home',
    sources: ['https://example.com/source'],
    values: { replicas: 1, image: { tag: 'old' } },
    valuesYaml: 'replicas: 1\nimage:\n  tag: old\n',
    readme: '# Nginx',
    dependencies: [{ name: 'common', version: '2.0.0' }],
  };
}

function preview(hasErrors = false): Record<string, unknown> {
  return {
    chart: 'nginx',
    chartVersion: '1.2.0',
    manifest: 'kind: Deployment\n',
    computedValues: { replicas: 2 },
    hooks: [{ name: 'pre-install' }],
    warnings: ['deprecated API'],
    validation: hasErrors
      ? [
          { status: 'error', resource: 'Deployment/nginx', message: 'invalid selector' },
          { status: 'error', resource: 'Service/nginx', message: 'invalid port' },
        ]
      : [
          { status: 'valid', resource: 'Deployment/nginx' },
          { status: 'warning', resource: 'Custom/nginx', message: 'not validated' },
        ],
  };
}

beforeEach(() => {
  helm.repos = [
    { name: 'stable', url: 'https://charts.example.com' },
    { name: 'private', url: 'https://private.example.com' },
  ];
  helm.reposLoading = false;
  helm.chartsByRepo = {
    stable: [
      { repo: 'stable', name: 'nginx', version: '1.2.0', appVersion: '1.25', description: 'Web server', keywords: ['proxy'], icon: 'icon' },
      { repo: 'stable', name: 'legacy', version: '0.1.0', description: 'Old chart', deprecated: true },
    ],
    private: [],
  };
  helm.chartsLoading = false;
  helm.chartsError = undefined;
  helm.hubData = [
    { repoName: 'bitnami', repoUrl: 'https://charts.bitnami.com', name: 'hub-nginx', version: '2.0.0', description: 'Official chart', official: true, icon: 'icon' },
    { repoName: 'community', repoUrl: 'https://community.example.com', name: 'hub-app', version: '1.0.0', description: 'Verified chart', official: false, verifiedPublisher: true },
    { repoName: 'other', repoUrl: 'https://other.example.com', name: 'plain-app', version: '0.5.0', official: false, verifiedPublisher: false },
  ];
  helm.hubFetching = false;
  helm.hubError = undefined;
  helm.versions = [{ version: '1.2.0', appVersion: '1.25' }, { version: '1.1.0' }];
  helm.hubVersions = { repoUrl: 'https://charts.bitnami.com', versions: [{ version: '2.0.0' }] };
  helm.hubVersionsLoading = false;
  helm.repoDetail = detail();
  helm.urlDetail = detail('2.0.0');
  helm.ociDetail = detail('3.0.0');
  helm.directDetail = detail('4.0.0');
  helm.detailLoading = false;
  helm.namespaces = ['default', 'team-a'];
  helm.protectedContexts.clear();
  helm.removeMode = 'success';
  helm.removePending = false;
  helm.removeMutate.mockReset();
  helm.removeMutate.mockImplementation((_name: string, options: { onSuccess: () => void; onError: (error: Error) => void }) => {
    if (helm.removeMode === 'error') options.onError(new Error('remove denied'));
    else options.onSuccess();
  });
  helm.installMode = 'success';
  helm.installPending = false;
  helm.installMutate.mockReset();
  helm.installMutate.mockImplementation((vars: Record<string, unknown>, options: { onSuccess: () => void; onError: (error: Error) => void }) => {
    helm.calls.install.push(vars);
    if (helm.installMode === 'error') options.onError(new Error('install denied'));
    else options.onSuccess();
  });
  helm.dryMode = 'success';
  helm.dryPending = false;
  helm.dryPreview = preview();
  helm.dryMutate.mockReset();
  helm.dryMutate.mockImplementation((vars: Record<string, unknown>, options: { onSuccess: (result: unknown) => void; onError: (error: Error) => void }) => {
    helm.calls.dry.push(vars);
    if (helm.dryMode === 'error') options.onError(new Error('render denied'));
    else options.onSuccess(helm.dryPreview);
  });
  helm.calls = { hubSearch: [], repoDetail: [], urlDetail: [], ociDetail: [], directDetail: [], install: [], dry: [] };
  effects.toast.mockClear();
});

function chooseStableChart() {
  fireEvent.click(screen.getByText('stable'));
  fireEvent.click(screen.getByText('nginx'));
}

describe('HelmInstallDialog', () => {
  it('browses Hub and repositories, filters charts, manages repos, and returns from configure', async () => {
    const onClose = vi.fn();
    render(<HelmInstallDialog contexts={['dev']} onClose={onClose} />);

    expect(screen.getByText('hub-nginx')).toBeInTheDocument();
    expect(screen.getByText('official')).toBeInTheDocument();
    expect(screen.getByText('verified')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Add repository'));
    fireEvent.click(screen.getByRole('button', { name: 'Close repository mock' }));

    fireEvent.click(screen.getByLabelText('Remove repository stable'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Remove' }));
    expect(helm.removeMutate).toHaveBeenCalledWith('stable', expect.any(Object));
    helm.removeMode = 'error';
    fireEvent.click(screen.getByLabelText('Remove repository private'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Remove' }));
    expect(effects.toast).toHaveBeenCalledWith('error', 'remove denied');

    fireEvent.click(screen.getByText('stable'));
    expect(screen.getByText('legacy')).toBeInTheDocument();
    expect(screen.getByText('deprecated')).toBeInTheDocument();
    const search = screen.getByPlaceholderText('Search charts');
    fireEvent.change(search, { target: { value: 'proxy' } });
    expect(screen.queryByText('legacy')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No charts match.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByText('nginx'));
    expect(await screen.findByText('Dependencies: common@2.0.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'README' }));
    expect(screen.getByText(/README mock # Nginx/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Back to catalog'));
    expect(screen.getByText('Install chart')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);

  it('validates, previews, and installs a repository chart on a protected target', async () => {
    helm.protectedContexts.add('prod');
    helm.dryPreview = preview(true);
    const onClose = vi.fn();
    render(<HelmInstallDialog contexts={['dev', 'prod']} onClose={onClose} />);
    chooseStableChart();
    await screen.findByDisplayValue(/replicas: 1/);

    fireEvent.change(screen.getByLabelText('Release name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
    expect(screen.getByText('Cluster, release name and namespace are required.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));

    fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'web' } });
    fireEvent.change(screen.getByLabelText('YAML editor'), { target: { value: 'broken: [' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/unexpected end|flow collection|YAML/i);
    fireEvent.change(screen.getByLabelText('YAML editor'), { target: { value: 'replicas: 2\n' } });
    fireEvent.change(screen.getByLabelText('…or new namespace'), { target: { value: 'team-new' } });
    fireEvent.mouseDown(screen.getByLabelText('Cluster'));
    fireEvent.click(await screen.findByRole('option', { name: 'prod' }));

    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
    const rendered = await screen.findByRole('dialog', { name: /Rendered manifest/ });
    expect(within(rendered).getByText('deprecated API')).toBeInTheDocument();
    expect(within(rendered).getByText(/Kubernetes rejected 2 rendered resource/)).toBeInTheDocument();
    expect(within(rendered).getByText('1 hooks')).toBeInTheDocument();
    expect(within(rendered).getByRole('button', { name: 'Install' })).toBeDisabled();
    fireEvent.click(within(rendered).getByRole('tab', { name: 'Computed values' }));
    expect((within(rendered).getByLabelText('Read-only YAML editor') as HTMLTextAreaElement).value).toContain('replicas: 2');
    fireEvent.click(within(rendered).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Rendered manifest/ })).not.toBeInTheDocument());

    helm.dryMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
    expect(screen.getByText('render denied')).toBeInTheDocument();
    helm.installMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expect(screen.getByText('install denied')).toBeInTheDocument();

    helm.installMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expect(helm.calls.install.at(-1)).toMatchObject({ ctx: 'prod', name: 'web', namespace: 'team-new', createNamespace: true });
    expect(effects.toast).toHaveBeenCalledWith('info', expect.stringContaining('Install started for team-new/web'));
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);

  it('builds Hub, direct URL, and OCI chart references', async () => {
    const cases = [
      {
        open: () => fireEvent.click(screen.getByText('hub-nginx')),
        prepare: () => undefined,
        expected: { repoUrl: 'https://charts.bitnami.com', chart: 'hub-nginx', version: '2.0.0' },
      },
      {
        open: () => {
          fireEvent.change(screen.getByPlaceholderText(/oci:\/\/registry/), { target: { value: 'https://example.com/chart.tgz' } });
          fireEvent.click(screen.getByRole('button', { name: 'Use ref' }));
        },
        prepare: () => fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'direct' } }),
        expected: { url: 'https://example.com/chart.tgz' },
      },
      {
        open: () => {
          fireEvent.change(screen.getByPlaceholderText(/oci:\/\/registry/), { target: { value: 'oci://registry.example.com/charts/app' } });
          fireEvent.click(screen.getByRole('button', { name: 'Use ref' }));
        },
        prepare: () => {
          fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'oci-app' } });
          fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
          expect(screen.getByText(/Enter the chart version/)).toBeInTheDocument();
          fireEvent.change(screen.getByLabelText('Version (OCI tag)'), { target: { value: '3.0.0' } });
        },
        expected: { ociRef: 'oci://registry.example.com/charts/app', version: '3.0.0' },
      },
    ];

    for (const item of cases) {
      helm.calls.dry = [];
      const view = render(<HelmInstallDialog contexts={['dev']} onClose={vi.fn()} />);
      item.open();
      item.prepare();
      await screen.findByLabelText('YAML editor');
      fireEvent.click(screen.getByRole('button', { name: 'Preview manifest' }));
      await waitFor(() => expect(helm.calls.dry.length).toBe(1));
      expect(helm.calls.dry[0]?.chart).toEqual(item.expected);
      view.unmount();
    }
  }, 15_000);

  it('shows catalog loading, Hub errors and empty searches, and configure busy states', async () => {
    helm.repos = [];
    helm.hubData = undefined;
    helm.hubFetching = true;
    const loading = render(<HelmInstallDialog contexts={[]} onClose={vi.fn()} />);
    expect(screen.getByText(/No repositories configured/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    loading.unmount();

    helm.hubFetching = false;
    helm.hubError = new Error('Hub unavailable');
    const empty = render(<HelmInstallDialog contexts={[]} onClose={vi.fn()} />);
    expect(screen.getByText('Hub unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Type to search every public chart/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search Artifact Hub/), { target: { value: 'none' } });
    await waitFor(() => expect(screen.getByText('No charts found for “none”.')).toBeInTheDocument(), { timeout: 2_000 });
    empty.unmount();

    helm.repos = [{ name: 'stable', url: 'https://charts.example.com' }];
    helm.hubData = [];
    helm.hubError = undefined;
    helm.detailLoading = true;
    helm.repoDetail = undefined;
    helm.installPending = true;
    helm.dryPending = true;
    const busy = render(<HelmInstallDialog contexts={['dev']} onClose={vi.fn()} />);
    chooseStableChart();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rendering…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    busy.unmount();
  });
});
