import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject, TlsCertInfo } from '@kubus/shared';
import { GenericDetail } from './GenericDetail.js';
import { Section } from './Section.js';
import { useSecretTls } from '../../api/queries.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const CN_RE = /(?:^|\n|,\s*)CN=([^\n,]+)/;
const NEWLINE_RE = /\n/g;

function expiryChip(cert: TlsCertInfo) {
  const expiresAt = Date.parse(cert.notAfter);
  const daysLeft = Math.floor((expiresAt - Date.now()) / DAY_MS);
  if (daysLeft < 0) return <Chip label={`Expired ${-daysLeft}d ago`} color="error" />;
  if (daysLeft < 30) return <Chip label={`Expires in ${daysLeft}d`} color="warning" />;
  return <Chip label={`Expires in ${daysLeft}d`} color="success" variant="outlined" />;
}

/** Extract the CN from an X.509 subject/issuer string ("CN=foo\nO=bar"). */
function commonName(dn: string): string {
  const m = CN_RE.exec(dn);
  return m?.[1] ?? dn.replace(NEWLINE_RE, ', ');
}

export function SecretDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const isTls = obj.type === 'kubernetes.io/tls';
  const tls = useSecretTls(isTls && obj.metadata.namespace ? { ctx, namespace: obj.metadata.namespace, name: obj.metadata.name } : undefined);
  const keys = Object.keys((obj.data as Record<string, unknown> | undefined) ?? {});

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ px: 2, pt: 2, flexWrap: 'wrap' }}>
        {typeof obj.type === 'string' && <Chip label={obj.type} variant="outlined" color="primary" />}
        <Chip label={`${keys.length} key${keys.length === 1 ? '' : 's'}`} variant="outlined" />
      </Stack>
      <Stack spacing={2} sx={{ px: 2, pt: 2 }}>
        {keys.length > 0 && (
          <Section title="Data keys" count={keys.length}>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {keys.map((k) => (
                <Chip key={k} label={k} variant="outlined" />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Values are redacted — reveal, copy or edit them per key in the Data tab.
            </Typography>
          </Section>
        )}
        {isTls &&
          (tls.data?.certificates ?? []).map((cert, i) => (
            <Card key={`${cert.source ?? ''}:${cert.serialNumber || i}`} variant="outlined">
              <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography variant="subtitle2">{commonName(cert.subject)}</Typography>
                  {expiryChip(cert)}
                  {cert.isCA && <Chip label="CA" variant="outlined" />}
                  {cert.selfSigned && <Chip label="self-signed" variant="outlined" />}
                  {cert.source && cert.source !== 'tls.crt' && <Chip label={cert.source} variant="outlined" color="secondary" />}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Issuer: {commonName(cert.issuer)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Valid: {new Date(cert.notBefore).toLocaleDateString()} → {new Date(cert.notAfter).toLocaleDateString()}
                </Typography>
                {cert.publicKeyAlgorithm && (
                  <Typography variant="body2" color="text.secondary">
                    Algorithm: {cert.publicKeyAlgorithm}
                  </Typography>
                )}
                <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                  Serial: {cert.serialNumber}
                </Typography>
                {cert.sans.length > 0 && (
                  <Stack direction="row" sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                    {cert.sans.map((san) => (
                      <Chip key={san} label={san} variant="outlined" sx={{ maxWidth: 360 }} title={san} />
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          ))}
        {isTls && tls.isError && (
          <Typography variant="body2" color="text.secondary">
            Could not parse TLS certificate: {tls.error instanceof Error ? tls.error.message : 'unknown error'}
          </Typography>
        )}
      </Stack>
      <GenericDetail obj={obj} ctx={ctx} />
    </Box>
  );
}
