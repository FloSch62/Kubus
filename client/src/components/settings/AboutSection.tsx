import { Fragment, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CoffeeOutlinedIcon from '@mui/icons-material/CoffeeOutlined';
import StarBorderOutlinedIcon from '@mui/icons-material/StarBorderOutlined';
import type { AppInfo } from '@kubus/shared';
import { getAppInfo } from '../../api/app.js';

import { DesktopUpdateControls } from '../DesktopUpdateControls.js';

const LINKS = {
  docs: 'https://kubus-app.dev/',
  source: 'https://github.com/FloSch62/Kubus',
  releases: 'https://github.com/FloSch62/Kubus/releases',
  author: 'https://flosch.me/',
  authorGithub: 'https://github.com/FloSch62',
  authorLinkedIn: 'https://www.linkedin.com/in/florian-schwarz-812a34145/',
  coffee: 'https://www.buymeacoffee.com/FloSch62',
} as const;

/**
 * The About page of Settings: what this build is, who makes it, how to support
 * the work, and whether a newer build exists. Every link opens in the system
 * browser (the desktop shell denies new windows and hands the URL to the OS).
 */
export function AboutSection() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>About</SectionTitle>
        <Stack spacing={1.25}>
          <Typography variant="body2">
            {[`Kubus ${appInfo?.version ?? ''}`.trim(), platformLabel(window.kubusDesktop?.platform), 'MIT license']
              .filter(Boolean)
              .join(' · ')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            A free, open-source Kubernetes GUI. Browse every cluster and resource, stream logs, open shells,
            forward ports, watch metrics and manage Helm from one local app.
          </Typography>
          <LinkRow
            links={[
              ['Documentation', LINKS.docs],
              ['Source', LINKS.source],
              ['Releases', LINKS.releases],
            ]}
          />
        </Stack>
      </Box>

      <Box>
        <SectionTitle>Made by</SectionTitle>
        <Stack spacing={1.25}>
          <Typography variant="body2" color="text.secondary">
            Kubus is built by me (FloSch), in the open and in my spare time. Bug reports, ideas and pull
            requests are always welcome.
          </Typography>
          <LinkRow
            links={[
              ['flosch.me', LINKS.author],
              ['GitHub', LINKS.authorGithub],
              ['LinkedIn', LINKS.authorLinkedIn],
            ]}
          />
        </Stack>
      </Box>

      <Box>
        <SectionTitle>Support</SectionTitle>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2" color="text.secondary">
            Kubus is free and stays free. If it saves you time, a coffee keeps the releases coming.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button
              variant="outlined"
              startIcon={<CoffeeOutlinedIcon />}
              href={LINKS.coffee}
              target="_blank"
              rel="noreferrer"
            >
              Buy me a coffee
            </Button>
            <Button startIcon={<StarBorderOutlinedIcon />} href={LINKS.source} target="_blank" rel="noreferrer">
              Star on GitHub
            </Button>
          </Stack>
        </Stack>
      </Box>

      {window.kubusDesktop && (
        <Box>
          <SectionTitle>Updates</SectionTitle>
          <DesktopUpdateControls />
        </Box>
      )}
    </Stack>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography variant="subtitle2" gutterBottom>
      {children}
    </Typography>
  );
}

/** A row of plain links, the way the rest of the dialog points elsewhere. */
function LinkRow({ links }: { links: ReadonlyArray<readonly [label: string, href: string]> }) {
  return (
    <Typography variant="body2" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      {links.map(([label, href], index) => (
        <Fragment key={href}>
          {index > 0 && (
            <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>
              ·
            </Box>
          )}
          <Link href={href} target="_blank" rel="noreferrer">
            {label}
          </Link>
        </Fragment>
      ))}
    </Typography>
  );
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
