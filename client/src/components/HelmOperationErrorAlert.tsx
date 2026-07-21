import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { HelmOperationFailure } from '@kubus/shared';
import type { ApiError } from '../api/http.js';
import { copyToClipboard } from '../clipboard.js';

function operationDetails(error: Error): HelmOperationFailure | undefined {
  const value = (error as ApiError).body?.details as Partial<HelmOperationFailure> | undefined;
  if (!value || !['install', 'upgrade', 'rollback'].includes(value.operation ?? '') || typeof value.phase !== 'string') return undefined;
  return value as HelmOperationFailure;
}

const FAILED_ITEMS_VISIBLE = 3;

export function HelmOperationErrorAlert({ error, onReview }: { error: Error; onReview?: () => void }) {
  const details = operationDetails(error);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const failed = details?.failed ?? [];
  const copyText = [
    error.message,
    ...(details ? [`phase: ${details.phase}`] : []),
    ...failed.map((item) => `${item.resource}: ${item.error}`),
  ].join('\n');
  return (
    <Alert
      severity="error"
      action={
        <>
          <Button
            color="inherit"
            size="small"
            onClick={() =>
              void copyToClipboard(copyText).then((ok) => {
                if (ok) setCopied(true);
              })
            }
          >
            {copied ? 'Copied' : 'Copy details'}
          </Button>
          {onReview && details?.revision ? (
            <Button color="inherit" size="small" onClick={onReview}>
              Review history
            </Button>
          ) : undefined}
        </>
      }
    >
      <AlertTitle>{details?.revision ? `${details.operation} revision ${details.revision} failed` : 'Helm operation failed'}</AlertTitle>
      <Typography variant="body2">{error.message}</Typography>
      {details ? (
        <>
          <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
            <Chip size="small" label={`phase: ${details.phase}`} />
            {details.applied.length ? <Chip size="small" label={`${details.applied.length} resources changed`} /> : null}
            {details.recoveryRevision ? <Chip size="small" color="info" label={`last good: rev ${details.recoveryRevision}`} /> : null}
          </Stack>
          {failed.length ? (
            <Typography component="div" variant="caption" sx={{ display: 'block', mt: 1 }}>
              {(showAll ? failed : failed.slice(0, FAILED_ITEMS_VISIBLE)).map((item) => `${item.resource}: ${item.error}`).join('; ')}
              {failed.length > FAILED_ITEMS_VISIBLE && (
                <>
                  {' '}
                  <Link component="button" variant="caption" color="inherit" sx={{ fontWeight: 600 }} onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'show less' : `show all ${failed.length}`}
                  </Link>
                </>
              )}
            </Typography>
          ) : null}
          <Typography component="ul" variant="caption" sx={{ mt: 1, mb: 0, pl: 2.25 }}>
            {details.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </Typography>
        </>
      ) : null}
    </Alert>
  );
}
