import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import type { OverviewCertificates } from '@kubus/shared';
import { RelativeTimeCell } from '../AgeCell.js';
import { ProblemCard, kindListPath } from './cards.js';

const API_SERVER_WARN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Certificates that are expired or expire within 30 days (cert-manager
 * Certificates + standalone TLS Secrets), plus the API server serving cert
 * when it enters the window.
 */
export function CertExpiryCard({ ctx, certificates, hideNamespace }: { ctx: string; certificates: OverviewCertificates; hideNamespace?: boolean }) {
  const navigate = useNavigate();
  const apiServerSoon =
    !!certificates.apiServerNotAfter && Date.parse(certificates.apiServerNotAfter) - Date.now() < API_SERVER_WARN_MS;
  if (certificates.expiring.length === 0 && !apiServerSoon) return null;

  return (
    <ProblemCard title="Certificates expiring soon">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Certificate</TableCell>
            <TableCell>Kind</TableCell>
            <TableCell>Expires</TableCell>
            <TableCell>Date</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {apiServerSoon && certificates.apiServerNotAfter && (
            <TableRow>
              <TableCell>API server serving certificate</TableCell>
              <TableCell>—</TableCell>
              <TableCell>
                <ExpiryCell notAfter={certificates.apiServerNotAfter} />
              </TableCell>
              <TableCell>{new Date(certificates.apiServerNotAfter).toLocaleDateString()}</TableCell>
            </TableRow>
          )}
          {certificates.expiring.map((c) => (
            <TableRow
              key={`${c.plural}/${c.namespace}/${c.name}`}
              hover
              sx={{ cursor: 'pointer' }}
              onClick={() => navigate(kindListPath(c, { sel: { ctx, namespace: c.namespace || undefined, name: c.name } }))}
            >
              <TableCell>
                {c.namespace && !hideNamespace ? `${c.namespace}/` : ''}
                {c.name}
              </TableCell>
              <TableCell>{c.source === 'cert-manager' ? 'Certificate' : 'TLS Secret'}</TableCell>
              <TableCell>
                <ExpiryCell notAfter={c.notAfter} />
              </TableCell>
              <TableCell>{new Date(c.notAfter).toLocaleDateString()}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!apiServerSoon && certificates.apiServerNotAfter && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          API server certificate expires <RelativeTimeCell timestamp={certificates.apiServerNotAfter} variant="caption" />.
        </Typography>
      )}
    </ProblemCard>
  );
}

function ExpiryCell({ notAfter }: { notAfter: string }) {
  const expired = Date.parse(notAfter) <= Date.now();
  return (
    <Typography variant="body2" component="span" sx={{ fontWeight: 600, color: expired ? 'error.main' : 'warning.main' }}>
      {expired ? 'expired ' : ''}
      <RelativeTimeCell timestamp={notAfter} />
    </Typography>
  );
}
