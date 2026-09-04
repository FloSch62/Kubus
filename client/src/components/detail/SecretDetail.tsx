import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject, TlsCertInfo } from '@kubus/shared';
import { GenericDetail } from './GenericDetail.js';
import { DataKeyRows } from './ConfigMapDetail.js';
import { Fact, Facts } from './Facts.js';
import { Section } from './Section.js';
import { useSecretTls } from '../../api/queries.js';
import { statusTextColor } from '../../theme.js';
import { UsedBySection } from './UsedBySection.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const CN_RE = /(?:^|\n|,\s*)CN=([^\n,]+)/;
const NEWLINE_RE = /\n/g;

function CertExpiry({ cert }: { cert: TlsCertInfo }) {
  const expiresAt = Date.parse(cert.notAfter);
  const daysLeft = Math.floor((expiresAt - Date.now()) / DAY_MS);
  const color = daysLeft < 0 ? 'error' : daysLeft < 30 ? 'warning' : 'success';
  const text = daysLeft < 0 ? `Expired ${-daysLeft}d ago` : `Expires in ${daysLeft}d`;
  return (
    <Typography component="span" variant="caption" sx={{ fontWeight: 550, color: statusTextColor(color), whiteSpace: 'nowrap' }}>
      {text}
    </Typography>
  );
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
      <Box sx={{ px: 2, pt: 2 }}>
        <Facts>
          <Fact label="Type" mono>
            {typeof obj.type === 'string' ? obj.type : undefined}
          </Fact>
          <Fact label="Keys">{keys.length}</Fact>
          <Fact label="Immutable" hint="Immutable Secrets cannot be edited — only replaced.">
            {obj.immutable === true && (
              <Box component="span" sx={{ fontWeight: 550, color: statusTextColor('warning') }}>
                Yes
              </Box>
            )}
          </Fact>
        </Facts>
      </Box>
      <Stack spacing={2} sx={{ px: 2, pt: 2 }}>
        <UsedBySection target={{ ctx, group: '', version: 'v1', plural: 'secrets', kind: 'Secret', name: obj.metadata.name, namespace: obj.metadata.namespace }} emptyText="Nothing mounts, reads or pulls with this Secret." />
        {keys.length > 0 && (
          <Section title="Data keys" count={keys.length}>
            <DataKeyRows rows={keys.map((k) => ({ key: k }))} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Values are redacted — reveal, copy or edit them per key in the Data tab.
            </Typography>
          </Section>
        )}
        {isTls &&
          (tls.data?.certificates ?? []).map((cert, i) => (
            <Card key={`${cert.source ?? ''}:${cert.serialNumber || i}`} variant="outlined">
              <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                <Stack direction="row" sx={{ mb: 1, alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="subtitle2">{commonName(cert.subject)}</Typography>
                  <CertExpiry cert={cert} />
                  {(cert.isCA || cert.selfSigned || (cert.source && cert.source !== 'tls.crt')) && (
                    <Typography variant="caption" color="text.secondary">
                      {[cert.isCA ? 'CA' : undefined, cert.selfSigned ? 'self-signed' : undefined, cert.source !== 'tls.crt' ? cert.source : undefined]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  )}
                </Stack>
                <Facts>
                  <Fact label="Issuer">{commonName(cert.issuer)}</Fact>
                  <Fact label="Valid">{`${new Date(cert.notBefore).toLocaleDateString()} → ${new Date(cert.notAfter).toLocaleDateString()}`}</Fact>
                  <Fact label="Algorithm">{cert.publicKeyAlgorithm}</Fact>
                  <Fact label="Serial" mono>
                    {cert.serialNumber}
                  </Fact>
                  <Fact label="SANs" mono>
                    {cert.sans.length > 0 ? cert.sans.join(', ') : undefined}
                  </Fact>
                </Facts>
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
