import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { RelativeTimeCell } from '../AgeCell.js';
import { CustomResourceDetail } from './CustomResourceDetail.js';

const WARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface CertStatus {
  notAfter?: string;
  renewalTime?: string;
  conditions?: Array<{ type?: string; status?: string }>;
}

/**
 * cert-manager Certificate overview: the expiry/renewal headline the printer
 * columns don't surface, on top of the generic CR detail.
 */
export function CertificateDetail({ obj, ctx, crd, version }: { obj: KubeObject; ctx: string; crd: KubeObject; version: string }) {
  const status = (obj.status ?? {}) as CertStatus;
  const now = Date.now();
  const notAfter = status.notAfter ? Date.parse(status.notAfter) : Number.NaN;
  const renewal = status.renewalTime ? Date.parse(status.renewalTime) : Number.NaN;
  const expired = !Number.isNaN(notAfter) && notAfter <= now;
  const expiringSoon = !Number.isNaN(notAfter) && !expired && notAfter - now < WARN_WINDOW_MS;
  const renewalOverdue = !Number.isNaN(renewal) && renewal <= now && !expired;
  const severity = expired ? 'error' : expiringSoon || renewalOverdue ? 'warning' : 'success';

  return (
    <>
      {status.notAfter && (
        <Box sx={{ px: 2, pt: 2 }}>
          <Alert severity={severity} variant="outlined" sx={{ alignItems: 'center' }}>
            <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
              {expired ? 'Expired ' : 'Expires '}
              <RelativeTimeCell timestamp={status.notAfter} />
            </Typography>{' '}
            <Typography variant="body2" component="span" color="text.secondary">
              ({new Date(status.notAfter).toLocaleString()})
            </Typography>
            {status.renewalTime && !expired && (
              <Typography variant="body2" component="span" sx={{ display: 'block' }}>
                {renewalOverdue ? 'Renewal was due ' : 'Renews '}
                <RelativeTimeCell timestamp={status.renewalTime} />
                {renewalOverdue && ' — check the issuer, cert-manager has not renewed on schedule.'}
              </Typography>
            )}
          </Alert>
        </Box>
      )}
      <CustomResourceDetail obj={obj} ctx={ctx} crd={crd} version={version} />
    </>
  );
}
