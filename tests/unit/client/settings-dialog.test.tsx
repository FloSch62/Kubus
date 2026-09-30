import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../../../client/src/components/settings/SettingsDialog';
import { installationFacts, releaseNotesUrl } from '../../../client/src/components/settings/AboutSection';
import { useShellPrefsStore } from '../../../client/src/state/shell-prefs';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const harness = vi.hoisted(() => ({
  copy: vi.fn(async (_text: string) => true),
  checkForUpdate: vi.fn(async () => ({ available: false, currentVersion: '0.10.1', latestVersion: '0.10.1' })),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useContexts: () => ({
    data: [{ name: 'kind-a', cluster: 'kind-a', user: 'kind-a', server: 'https://127.0.0.1:6443', kubernetesVersion: 'v1.36.1', health: 'connected' }],
  }),
  useKubeconfigSettings: () => ({
    data: { paths: ['/home/me/.kube/config'], source: 'default', override: null, primaryPath: '/home/me/.kube/config' },
    isLoading: false,
  }),
  useSetKubeconfig: () => ({ mutate: vi.fn(), isPending: false, isError: false, isSuccess: false }),
  useDeleteCluster: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useDebugImages: () => ({ data: [] }),
  useAddDebugImage: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRemoveDebugImage: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock('../../../client/src/api/app.js', () => ({
  getAppInfo: async () => ({ name: 'Kubus', version: '0.10.1', helmEngine: true }),
  checkForUpdate: harness.checkForUpdate,
}));
vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: harness.copy }));

beforeEach(() => {
  useShellPrefsStore.setState({ settingsTab: undefined });
  useUiPrefsStore.setState({ protectByDefault: false });
  harness.copy.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'kubusDesktop');
});

describe('SettingsDialog', () => {
  it('lists every section as a tab and remembers the one you pick', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(names).toEqual(['Kubeconfig', 'Clusters', 'Appearance', 'Data & refresh', 'Logs & terminal', 'Debug containers', 'Diagnostics', 'About']);
    fireEvent.click(screen.getByRole('tab', { name: 'Logs & terminal' }));
    expect(screen.getByRole('heading', { name: 'Logs & terminal' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tail lines (live view)' })).toBeInTheDocument();
    expect(useShellPrefsStore.getState().settingsTab).toBe('Logs & terminal');
  });

  it('closes from the header button', () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('ties each switch to its row label', () => {
    useShellPrefsStore.setState({ settingsTab: 'Clusters' });
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Protect clusters by default' }));
    expect(useUiPrefsStore.getState().protectByDefault).toBe(true);
    expect(screen.getByRole('button', { name: 'Unprotect kind-a' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the version, this release’s notes and copies diagnostics without secrets', async () => {
    useShellPrefsStore.setState({ settingsTab: 'About' });
    render(<SettingsDialog open onClose={() => undefined} />);
    expect(await screen.findByText('Version 0.10.1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', 'https://kubus-app.dev/release-notes/0.10/');
    expect(screen.getByRole('link', { name: 'Report an issue' })).toHaveAttribute('href', 'https://github.com/FloSch62/Kubus/issues/new');
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(harness.copy).toHaveBeenCalled());
    const text = harness.copy.mock.calls[0]![0];
    expect(text).toContain('Version: 0.10.1');
    expect(text).toContain('Helm engine: Available');
    expect(text).not.toMatch(/token/i);
  });

  it('reports the update check result in the row', async () => {
    useShellPrefsStore.setState({ settingsTab: 'About' });
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Kubus is up to date. Latest release: 0.10.1.')).toBeInTheDocument();
  });
});

describe('About facts', () => {
  it('links the release notes of the running minor version', () => {
    expect(releaseNotesUrl('0.10.1')).toBe('https://kubus-app.dev/release-notes/0.10/');
    expect(releaseNotesUrl(undefined)).toBe('https://kubus-app.dev/release-notes/');
  });

  it('names Electron and Chromium in the desktop app, and no server address', () => {
    Reflect.set(window, 'kubusDesktop', { platform: 'darwin' });
    const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Kubus/0.10.1 Chrome/140.0.7339.41 Electron/44.3.0 Safari/537.36';
    const facts = Object.fromEntries(installationFacts({ name: 'Kubus', version: '0.10.1', helmEngine: false }, ua));
    expect(facts).toMatchObject({ 'Runs as': 'Desktop app', Platform: 'macOS', Electron: '44.3.0', Chromium: '140.0.7339.41' });
    expect(facts['Helm engine']).toMatch(/^Not available/);
    expect(facts.Server).toBeUndefined();
  });

  it('names the browser in the web app', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
    const facts = Object.fromEntries(installationFacts({ name: 'Kubus', version: '0.10.1', helmEngine: true }, ua));
    expect(facts).toMatchObject({ 'Runs as': 'Web app in your browser', Browser: 'Chrome 148.0.0.0' });
    expect(facts.Electron).toBeUndefined();
  });
});
