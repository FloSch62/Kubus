import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import CoffeeOutlinedIcon from '@mui/icons-material/CoffeeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import NewReleasesOutlinedIcon from '@mui/icons-material/NewReleasesOutlined';
import StarBorderOutlinedIcon from '@mui/icons-material/StarBorderOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import type { AppInfo, UpdateCheckResult } from '@kubus/shared';
import { DesktopUpdateControls } from '../DesktopUpdateControls.js';
import { checkForUpdate, getAppInfo } from '../../api/app.js';
import { copyToClipboard } from '../../clipboard.js';
import { showToast } from '../../state/toast.js';
import { statusTextColor } from '../../theme.js';
import { SettingRow, SettingsGroup } from './SettingsLayout.js';

const LINKS = {
  docs: 'https://kubus-app.dev/',
  source: 'https://github.com/FloSch62/Kubus',
  issues: 'https://github.com/FloSch62/Kubus/issues/new',
  license: 'https://github.com/FloSch62/Kubus/blob/main/LICENSE',
  author: 'https://flosch.me/',
  authorGithub: 'https://github.com/FloSch62',
  authorLinkedIn: 'https://www.linkedin.com/in/florian-schwarz-812a34145/',
  coffee: 'https://www.buymeacoffee.com/FloSch62',
} as const;

/** The docs page with this version's release notes: `0.10.1` → `/release-notes/0.10/`. */
export function releaseNotesUrl(version?: string): string {
  const minor = /^(\d+\.\d+)/.exec(version ?? '')?.[1];
  return minor ? `${LINKS.docs}release-notes/${minor}/` : `${LINKS.docs}release-notes/`;
}

function platformLabel(platform?: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform ?? '';
  }
}

/** The OS the window runs on, from the desktop bridge or the browser. */
function hostPlatform(): string {
  const desktop = window.kubusDesktop?.platform;
  if (desktop) return platformLabel(desktop);
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (hinted) return hinted;
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return navigator.platform || 'Unknown';
}

/** The browser engine as the user agent names it: Electron and Chromium in the desktop app, the browser otherwise. */
function engineFacts(ua: string): Array<[string, string]> {
  const electron = /Electron\/([\d.]+)/.exec(ua)?.[1];
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1];
  if (electron) return [['Electron', electron], ...(chrome ? [['Chromium', chrome] as [string, string]] : [])];
  const edge = /Edg\/([\d.]+)/.exec(ua)?.[1];
  const firefox = /Firefox\/([\d.]+)/.exec(ua)?.[1];
  const safari = !chrome && /Version\/([\d.]+).*Safari/.exec(ua)?.[1];
  const browser = edge ? `Edge ${edge}` : chrome ? `Chrome ${chrome}` : firefox ? `Firefox ${firefox}` : safari ? `Safari ${safari}` : undefined;
  return browser ? [['Browser', browser]] : [];
}

/**
 * Facts about this installation that are known for certain. No secrets: the
 * API token never appears, and the server address is only the page's host.
 */
export function installationFacts(appInfo: AppInfo | null, ua = navigator.userAgent): Array<[string, string]> {
  const desktop = !!window.kubusDesktop;
  return [
    ['Version', appInfo?.version ?? 'unknown'],
    ['Runs as', desktop ? 'Desktop app' : 'Web app in your browser'],
    ['Platform', hostPlatform()],
    ...engineFacts(ua),
    ['Helm engine', appInfo ? (appInfo.helmEngine ? 'Available' : 'Not available (chart install and upgrade are off)') : 'unknown'],
    ...(desktop ? [] : [['Server', window.location.host] as [string, string]]),
  ];
}

/**
 * The About page of Settings: what this build is, where to read more, whether
 * a newer build exists, and who makes it. Every link opens in the system
 * browser (the desktop shell denies new windows and hands the URL to the OS).
 */
export function AboutSection() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const facts = installationFacts(appInfo);
  const copyDiagnostics = () => {
    const text = facts.map(([k, v]) => `${k}: ${v}`).join('\n');
    void copyToClipboard(text).then((ok) => (ok ? showToast('success', 'Diagnostics copied') : showToast('error', 'Could not copy to the clipboard')));
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <AboutHero version={appInfo?.version} loaded={loaded} />

      <SettingsGroup title="Updates">
        {window.kubusDesktop ? (
          <Box sx={{ p: 2 }}>
            <DesktopUpdateControls />
          </Box>
        ) : (
          <UpdateControls currentVersion={appInfo?.version} />
        )}
      </SettingsGroup>

      <SettingsGroup
        title="This installation"
        action={
          <Button size="small" startIcon={<ContentCopyOutlinedIcon />} onClick={copyDiagnostics}>
            Copy diagnostics
          </Button>
        }
      >
        <Box component="dl" sx={{ m: 0, px: 2, py: 1.25, display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', columnGap: 3, rowGap: 0.75 }}>
          {facts.map(([k, v]) => (
            <Box key={k} sx={{ display: 'contents' }}>
              <Typography component="dt" variant="body2" color="text.secondary">
                {k}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>
                {loaded || k !== 'Version' ? v : <Skeleton width={60} />}
              </Typography>
            </Box>
          ))}
        </Box>
      </SettingsGroup>

      <SettingsGroup title="Made by">
        <SettingRow
          label="FloSch"
          description="Kubus is built in the open, in my spare time. Bug reports, ideas and pull requests are always welcome."
        >
          <Typography variant="body2" sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
            <Link href={LINKS.author} target="_blank" rel="noreferrer">
              flosch.me
            </Link>
            <Link href={LINKS.authorGithub} target="_blank" rel="noreferrer">
              GitHub
            </Link>
            <Link href={LINKS.authorLinkedIn} target="_blank" rel="noreferrer">
              LinkedIn
            </Link>
          </Typography>
        </SettingRow>
        <SettingRow
          label="Support Kubus"
          description="Kubus is free and stays free. If it saves you time, a coffee keeps the releases coming."
          control={
            <>
              <Button variant="outlined" size="small" startIcon={<CoffeeOutlinedIcon />} href={LINKS.coffee} target="_blank" rel="noreferrer">
                Buy me a coffee
              </Button>
              <Button size="small" startIcon={<StarBorderOutlinedIcon />} href={LINKS.source} target="_blank" rel="noreferrer">
                Star on GitHub
              </Button>
            </>
          }
        />
      </SettingsGroup>

      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', mt: -0.5 }}>
        Released under the{' '}
        <Link href={LINKS.license} target="_blank" rel="noreferrer" color="inherit" underline="always">
          MIT license
        </Link>
        .
      </Typography>
    </Box>
  );
}

function AboutHero({ version, loaded }: { version?: string; loaded: boolean }) {
  return (
    <Box
      sx={(theme) => ({
        display: 'flex',
        gap: 2.5,
        alignItems: 'center',
        p: 2.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        // A soft wash of the logo's blue, fading out: the one decorative surface
        // on the page. Opaque stops: a translucent gradient repaints darker once
        // a sibling button animates (Chromium layer compositing).
        background: `linear-gradient(135deg, ${theme.palette.mode === 'dark' ? '#2b2f46' : '#eef2ff'} 0%, ${theme.palette.background.paper} 70%)`,
        flexWrap: { xs: 'wrap', sm: 'nowrap' },
      })}
    >
      <Box component="img" src="/kubus.svg" alt="" aria-hidden sx={{ width: 64, height: 72, objectFit: 'contain', flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography component="h2" sx={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
            Kubus
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {version ? `Version ${version}` : loaded ? '' : <Skeleton width={90} sx={{ display: 'inline-block' }} />}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 520 }}>
          A free, open-source Kubernetes GUI. Browse every cluster and resource, stream logs, open shells, forward ports, watch metrics and manage
          Helm from one local app.
        </Typography>
        <Stack direction="row" sx={{ mt: 1.75, flexWrap: 'wrap', gap: 1 }}>
          <Button variant="outlined" size="small" startIcon={<MenuBookOutlinedIcon />} href={LINKS.docs} target="_blank" rel="noreferrer">
            Documentation
          </Button>
          <Button variant="outlined" size="small" startIcon={<NewReleasesOutlinedIcon />} href={releaseNotesUrl(version)} target="_blank" rel="noreferrer">
            Release notes
          </Button>
          <Button variant="outlined" size="small" startIcon={<GitHubIcon />} href={LINKS.source} target="_blank" rel="noreferrer">
            GitHub
          </Button>
          <Button variant="outlined" size="small" startIcon={<BugReportOutlinedIcon />} href={LINKS.issues} target="_blank" rel="noreferrer">
            Report an issue
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}

/** Update check for the web app: the server asks GitHub for the latest release. */
function UpdateControls({ currentVersion }: { currentVersion?: string }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const checkForUpdates = () => {
    setChecking(true);
    setResult(null);
    void checkForUpdate({ force: true })
      .then(setResult)
      .catch(() => setResult({ available: false, currentVersion: currentVersion ?? '', reason: 'network' }))
      .finally(() => setChecking(false));
  };

  const updatesAvailable = result?.available === true;
  const status = checking ? (
    'Checking GitHub for the latest release…'
  ) : updatesAvailable ? (
    <StatusText tone="info">
      Kubus {result.latestVersion} is available. You are running {result.currentVersion}.
    </StatusText>
  ) : result?.available === false && result.latestVersion ? (
    <StatusText tone="success">Kubus is up to date. Latest release: {result.latestVersion}.</StatusText>
  ) : result ? (
    <StatusText tone="warning">{updateReasonLabel(result.reason)}</StatusText>
  ) : (
    'Kubus looks for a newer release on GitHub when you ask.'
  );

  return (
    <SettingRow
      label="Update check"
      description={status}
      control={
        <>
          {updatesAvailable && (
            <Button variant="contained" size="small" startIcon={<DownloadOutlinedIcon />} href={result.releaseUrl} target="_blank" rel="noreferrer">
              Download
            </Button>
          )}
          <Button
            variant={updatesAvailable ? 'outlined' : 'contained'}
            size="small"
            startIcon={checking ? <CircularProgress color="inherit" size={14} /> : <CachedOutlinedIcon />}
            disabled={checking}
            onClick={checkForUpdates}
          >
            Check for updates
          </Button>
        </>
      }
    />
  );
}

function StatusText({ tone, children }: { tone: 'success' | 'info' | 'warning'; children: React.ReactNode }) {
  const Icon = tone === 'success' ? CheckCircleOutlineIcon : tone === 'warning' ? WarningAmberOutlinedIcon : NewReleasesOutlinedIcon;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: statusTextColor(tone), fontWeight: 500 }}>
      <Icon sx={{ fontSize: 15 }} />
      <span>{children}</span>
    </Box>
  );
}

function updateReasonLabel(reason?: string): string {
  switch (reason) {
    case 'timeout':
      return 'The update check timed out.';
    case 'network':
      return 'The update check could not reach GitHub.';
    case 'no-release':
      return 'No published release was found.';
    case 'missing-version':
    case 'missing-release-url':
      return 'The latest release metadata is incomplete.';
    default:
      return reason?.startsWith('manifest-')
        ? `The update manifest returned ${reason.replace('manifest-', '')}.`
        : 'The update check could not be completed.';
  }
}
