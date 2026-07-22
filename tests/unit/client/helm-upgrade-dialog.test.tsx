import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelmReleaseDetail } from '@kubus/shared';
import HelmUpgradeDialog from '../../../client/src/components/HelmUpgradeDialog';

const helm = vi.hoisted(() => ({
  hits: [] as Array<Record<string, unknown>>,
  findLoading: false,
  detail: undefined as Record<string, unknown> | undefined,
  detailLoading: false,
  detailError: undefined as Error | undefined,
  detailSources: [] as unknown[],
  upgradeMode: 'success' as 'success' | 'error',
  upgradePending: false,
  upgradeMutate: vi.fn(),
  dryMode: 'success' as 'success' | 'error',
  dryPending: false,
  dryPreview: undefined as Record<string, unknown> | undefined,
  dryMutate: vi.fn(),
  upgradeCalls: [] as Record<string, unknown>[],
  dryCalls: [] as Record<string, unknown>[],
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useHelmChartFind: () => ({ data: helm.hits, isLoading: helm.findLoading }),
  useHelmChartSourceDetail: (source: unknown) => {
    helm.detailSources.push(source);
    return {
      data: source ? helm.detail : undefined,
      isLoading: !!source && helm.detailLoading,
      error: source ? helm.detailError : undefined,
    };
  },
  useHelmUpgrade: () => ({ isPending: helm.upgradePending, mutate: helm.upgradeMutate }),
  useHelmUpgradeDryRun: () => ({ isPending: helm.dryPending, mutate: helm.dryMutate }),
}));
vi.mock('../../../client/src/state/prefs.js', () => ({
  useUiPrefsStore: (selector: (state: { monoFontSize: number }) => unknown) => selector({ monoFontSize: 13 }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, title, confirmLabel, danger, busy, onConfirm, onClose }: { open: boolean; title: string; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) =>
    open ? (
      <dialog open aria-label={title} data-danger={String(!!danger)}>
        <button disabled={busy} onClick={onConfirm}>Confirm {confirmLabel}</button>
        <button onClick={onClose}>Cancel confirmation</button>
      </dialog>
    ) : null,
}));
vi.mock('../../../client/src/components/DiffViewer.js', () => ({
  DiffViewer: ({ left, right }: { left: string; right: string }) => (
    <div data-testid="diff-viewer">
      <pre>{left}</pre>
      <pre>{right}</pre>
    </div>
  ),
}));
vi.mock('../../../client/src/components/HelmAddRepoDialog.js', () => ({
  HelmAddRepoDialog: ({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) => (
    <dialog open aria-label="Add repo mock">
      <button onClick={onAdded}>Added repository mock</button>
      <button onClick={onClose}>Close repository mock</button>
    </dialog>
  ),
}));
vi.mock('../../../client/src/components/ChartMarkdown.js', () => ({ ChartMarkdown: ({ markdown, sourceUrl }: { markdown: string; sourceUrl?: string }) => <div>README mock {markdown} {sourceUrl}</div> }));
vi.mock('../../../client/src/components/ChartSourceLink.js', () => ({
  preferredChartSource: (sources?: string[], home?: string) => sources?.[0] ?? home,
  ChartSourceLink: ({ url }: { url?: string }) => url ? <a href={url}>Chart source</a> : null,
}));
vi.mock('../../../client/src/components/HelmOperationErrorAlert.js', () => ({
  HelmOperationErrorAlert: ({ error, onReview }: { error: Error; onReview: () => void }) => (
    <div role="alert">
      Operation error {error.message}
      <button onClick={onReview}>Review release</button>
    </div>
  ),
}));

function release(overrides: Partial<HelmReleaseDetail> = {}): HelmReleaseDetail {
  return {
    name: 'web',
    namespace: 'team-a',
    revision: 3,
    status: 'deployed',
    chart: 'nginx',
    chartVersion: '1.0.0',
    appVersion: '1.0',
    values: { replicas: 1, image: { tag: 'old' } },
    computedValues: { replicas: 1, image: { tag: 'old' }, service: { port: 80 } },
    defaultValues: { replicas: 1, image: { tag: 'default' } },
    chartHome: 'https://example.com/home',
    chartSources: ['https://example.com/source'],
    manifest: 'kind: Deployment\nmetadata:\n  name: web\n',
    chartDependencies: 0,
    hookCount: 0,
    chartCrds: [],
    ...overrides,
  };
}

function targetDetail(version = '2.0.0', values: Record<string, unknown> = { replicas: 2, image: { repository: 'nginx' } }): Record<string, unknown> {
  return {
    name: 'nginx',
    version,
    appVersion: '2.0',
    values,
    valuesYaml: 'replicas: 2\n',
    readme: '# Upgrade guide',
    home: 'https://example.com/new-home',
    sources: ['https://example.com/new-source'],
  };
}

function preview(hasErrors = false, identicalManifest = false): Record<string, unknown> {
  return {
    chart: 'nginx',
    chartVersion: '2.0.0',
    manifest: identicalManifest ? 'kind: Deployment\nmetadata:\n  name: web\n' : 'kind: Deployment\nmetadata:\n  name: web-v2\n',
    computedValues: { replicas: 2 },
    hooks: [{ name: 'pre-upgrade' }],
    warnings: ['hook warning'],
    validation: hasErrors
      ? [{ status: 'error', resource: 'Deployment/web', message: 'bad selector' }]
      : [{ status: 'valid', resource: 'Deployment/web' }],
  };
}

beforeEach(() => {
  helm.hits = [
    {
      repo: 'stable',
      versions: [
        { version: '2.0.0', appVersion: '2.0' },
        { version: '1.0.0', appVersion: '1.0' },
        { version: '9.0.0', deprecated: true },
      ],
    },
    {
      repo: 'hub',
      repoUrl: 'https://hub.example.com/charts',
      fromHub: true,
      versions: [
        { version: '1.5.0' },
        { version: '1.0.0' },
        { version: '0.5.0', appVersion: '0.5' },
      ],
    },
  ];
  helm.findLoading = false;
  helm.detail = targetDetail();
  helm.detailLoading = false;
  helm.detailError = undefined;
  helm.detailSources = [];
  helm.upgradeMode = 'success';
  helm.upgradePending = false;
  helm.upgradeCalls = [];
  helm.upgradeMutate.mockReset();
  helm.upgradeMutate.mockImplementation((vars: Record<string, unknown>, options: { onSuccess: () => void; onError: (error: Error) => void }) => {
    helm.upgradeCalls.push(vars);
    if (helm.upgradeMode === 'error') options.onError(new Error('upgrade denied'));
    else options.onSuccess();
  });
  helm.dryMode = 'success';
  helm.dryPending = false;
  helm.dryPreview = preview();
  helm.dryCalls = [];
  helm.dryMutate.mockReset();
  helm.dryMutate.mockImplementation((vars: Record<string, unknown>, options: { onSuccess: (result: unknown) => void; onError: (error: Error) => void }) => {
    helm.dryCalls.push(vars);
    if (helm.dryMode === 'error') options.onError(new Error('preview denied'));
    else options.onSuccess(helm.dryPreview);
  });
  effects.toast.mockClear();
});

describe('HelmUpgradeDialog', () => {
  it('recommends an upgrade, compares defaults, previews every view, and completes it', async () => {
    const current = release({
      values: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`removed${index}`, index])),
    });
    helm.dryPreview = preview(false, true);
    const onClose = vi.fn();
    render(<HelmUpgradeDialog ctx="dev" ns="team-a" name="web" release={current} isProtected={false} onClose={onClose} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument());
    expect(screen.getByText('→ 2.0.0')).toBeInTheDocument();
    expect(screen.getByText(/10 current override path/)).toHaveTextContent('…');
    expect(screen.getByText('Chart source')).toHaveAttribute('href', 'https://example.com/new-source');

    fireEvent.click(screen.getByRole('tab', { name: 'Default values diff' }));
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'README' }));
    expect(screen.getByText(/README mock # Upgrade guide/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Your values' }));

    fireEvent.change(screen.getByLabelText('YAML editor'), { target: { value: 'bad: [' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getAllByRole('alert').some((alert) => /YAML|flow collection|unexpected end/i.test(alert.textContent ?? ''))).toBe(true);
    fireEvent.change(screen.getByLabelText('YAML editor'), { target: { value: 'replicas: 2\n' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skip hooks' }));

    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    const modal = await screen.findByRole('dialog', { name: /Preview: rev 3/ });
    expect(within(modal).getByText('hook warning')).toBeInTheDocument();
    expect(within(modal).getByText(/server-side dry-run passed for 1 resources/)).toBeInTheDocument();
    expect(within(modal).getByText(/rendered manifest is identical/)).toBeInTheDocument();
    for (const tab of ['Computed', 'Defaults', 'Your values', 'Manifest']) {
      fireEvent.click(within(modal).getByRole('tab', { name: tab }));
      expect(within(modal).getByTestId('diff-viewer')).toBeInTheDocument();
    }
    fireEvent.click(within(modal).getByRole('button', { name: 'Upgrade' }));
    expect(helm.upgradeCalls.at(-1)).toMatchObject({ ctx: 'dev', ns: 'team-a', name: 'web', skipHooks: true });
    expect(effects.toast).toHaveBeenCalledWith('info', expect.stringContaining('Upgrade started for team-a/web'));
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);

  it('handles preview and operation errors plus protected confirmation', async () => {
    helm.dryPreview = preview(true);
    const onClose = vi.fn();
    render(<HelmUpgradeDialog ctx="prod" ns="team-a" name="web" release={release()} isProtected onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument());

    helm.dryMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByText('preview denied')).toBeInTheDocument();
    helm.dryMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    const modal = await screen.findByRole('dialog', { name: /Preview: rev 3/ });
    expect(within(modal).getByText(/Kubernetes rejected 1 candidate resource/)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Upgrade' })).toBeDisabled();
    fireEvent.click(within(modal).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Preview: rev 3/ })).not.toBeInTheDocument());

    helm.upgradeMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(screen.getByRole('dialog', { name: 'Upgrade web' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Upgrade' }));
    expect(screen.getByText('Operation error upgrade denied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }));
    expect(onClose).toHaveBeenCalledOnce();

    helm.upgradeMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel confirmation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Upgrade' }));
    expect(effects.toast).toHaveBeenCalledWith('info', expect.stringContaining('Upgrade started'));
  });

  it('validates blocked values-only, incomplete, unresolved, URL, and OCI sources', async () => {
    helm.hits = [];
    const blockedRelease = release({ chartDependencies: 2 });
    const view = render(<HelmUpgradeDialog ctx="dev" ns="team-a" name="web" release={blockedRelease} isProtected={false} onClose={vi.fn()} />);
    expect(screen.getByText(/was not found in your repositories/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Added repository mock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByText(/declares 2 dependencies/)).toBeInTheDocument();

    const source = screen.getByLabelText('Custom source (oci:// or .tgz URL)');
    fireEvent.change(source, { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByText(/complete oci:\/\/ ref or http\(s\) chart URL/)).toBeInTheDocument();

    fireEvent.change(source, { target: { value: 'oci://registry.example.com/charts/nginx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByText('OCI chart sources need an explicit version.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '3.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByText(/Still resolving the custom chart source/)).toBeInTheDocument();

    helm.detail = targetDetail('3.0.0');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade' })).toBeEnabled(), { timeout: 2_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(helm.dryCalls.at(-1)?.chart).toEqual({ ociRef: 'oci://registry.example.com/charts/nginx', version: '3.0.0' });

    view.unmount();
    helm.hits = [];
    helm.detail = targetDetail('2.5.0');
    const direct = render(<HelmUpgradeDialog ctx="dev" ns="team-a" name="web" release={release()} isProtected={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Custom source (oci:// or .tgz URL)'), { target: { value: 'https://example.com/nginx.tgz' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade' })).toBeEnabled(), { timeout: 2_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(helm.dryCalls.at(-1)?.chart).toEqual({ url: 'https://example.com/nginx.tgz' });
    direct.unmount();
  }, 15_000);

  it('shows downgrade, identical defaults, loading metadata, empty values, and busy labels', async () => {
    helm.hits = [{ repo: 'old', versions: [{ version: '0.5.0' }, { version: '1.0.0' }] }];
    helm.detail = targetDetail('0.5.0', { replicas: 1, image: { tag: 'default' } });
    const downgrade = render(<HelmUpgradeDialog ctx="dev" ns="team-a" name="web" release={release()} isProtected={false} onClose={vi.fn()} />);
    fireEvent.mouseDown(screen.getByLabelText('Chart version'));
    fireEvent.click(await screen.findByRole('option', { name: /0.5.0.*downgrade/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Downgrade' })).toBeInTheDocument());
    expect(screen.getByText(/chart and application downgrade/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Default values diff' }));
    expect(screen.getByText(/default values are identical/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Downgrade' }));
    expect(screen.getByRole('dialog', { name: 'Downgrade web' })).toHaveAttribute('data-danger', 'true');
    downgrade.unmount();

    helm.hits = [{ repo: 'stable', versions: [{ version: '2.0.0' }, { version: '1.0.0' }] }];
    helm.detail = targetDetail();
    helm.detailLoading = true;
    helm.findLoading = true;
    helm.upgradePending = true;
    helm.dryPending = true;
    render(<HelmUpgradeDialog ctx="dev" ns="team-a" name="web" release={release({ values: {} })} isProtected={false} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled());
    fireEvent.click(screen.getByRole('tab', { name: 'Default values diff' }));
    expect(screen.getByText('Loading selected chart defaults…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rendering…' })).toBeDisabled();
    fireEvent.mouseDown(screen.getByLabelText('Chart version'));
    expect(await screen.findByRole('option', { name: /Searching repositories & Artifact Hub/ })).toBeInTheDocument();
  });
});
