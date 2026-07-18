import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { HelmOperationFailure } from '@kubus/shared';
import type { ApiError } from '../api/http.js';

function operationDetails(error: Error): HelmOperationFailure | undefined {
  const value = (error as ApiError).body?.details as Partial<HelmOperationFailure> | undefined;
  if (!value || !['install', 'upgrade', 'rollback'].includes(value.operation ?? '') || typeof value.phase !== 'string') return undefined;
  return value as HelmOperationFailure;
}

export function HelmOperationErrorAlert({ error, onReview }: { error: Error; onReview?: () => void }) {
  const details = operationDetails(error);
  return (
    <Alert
      severity="error"
      action={
        onReview && details?.revision ? (
          <Button color="inherit" size="small" onClick={onReview}>
            Review history
          </Button>
        ) : undefined
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
          {details.failed.length ? (
            <Typography component="div" variant="caption" sx={{ display: 'block', mt: 1 }}>
              {details.failed
                .slice(0, 3)
                .map((item) => `${item.resource}: ${item.error}`)
                .join('; ')}
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
