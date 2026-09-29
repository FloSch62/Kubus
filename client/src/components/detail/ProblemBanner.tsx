import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { AgeCell } from '../AgeCell.js';

export interface ProblemLink {
  label: string;
  onClick: () => void;
}

export interface ProblemItem {
  /** Bold headline, e.g. "worker: CrashLoopBackOff" or "FailedScheduling". */
  title: string;
  message?: string;
  /** Occurrence count (events), rendered as ×N. */
  count?: number;
  /** When it last happened (events). */
  at?: string;
  /** Jump to the object behind the problem (the exhausted quota, the blocking budget). */
  links?: ProblemLink[];
  /**
   * The component's own wording (kubelet or scheduler message) when `message`
   * is a plain-language rewrite of it; kept a click away instead of repeated.
   */
  raw?: string;
  /** Label of the `raw` disclosure; defaults to "Kubelet message". */
  rawLabel?: string;
}

/**
 * The original message behind a plain-language summary, folded away: the
 * summary answers "what is wrong", this keeps the exact text for searching
 * and bug reports.
 */
export function RawMessage({ text, label = 'Kubelet message' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 0.5 }}>
      <ButtonBase
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        sx={{ gap: 0.25, borderRadius: 0.75, pr: 0.5, fontSize: 12, fontWeight: 550, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
      >
        <KeyboardArrowRightIcon sx={{ fontSize: 16, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
        {label}
      </ButtonBase>
      <Collapse in={open} timeout={150} unmountOnExit>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, pl: 2.25, pt: 0.25 }}>
          {text}
        </Typography>
      </Collapse>
    </Box>
  );
}

export function ProblemItems({ items }: { items: ProblemItem[] }) {
  return (
    <Stack spacing={0.75}>
      {items.map((item, i) => (
        <Box key={`${item.title}:${i}`}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {item.title}
            {item.count !== undefined && item.count > 1 ? ` ×${item.count}` : ''}
            {item.at && (
              <>
                {' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  <AgeCell timestamp={item.at} variant="caption" /> ago
                </Typography>
              </>
            )}
          </Typography>
          {item.message && (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {item.message}
            </Typography>
          )}
          {item.raw && item.raw !== item.message && <RawMessage text={item.raw} label={item.rawLabel} />}
          {item.links && item.links.length > 0 && (
            <Stack direction="row" sx={{ gap: 1.5, mt: 0.5, flexWrap: 'wrap' }}>
              {item.links.map((link) => (
                <Link key={link.label} component="button" variant="body2" underline="hover" onClick={link.onClick} sx={{ fontWeight: 600, verticalAlign: 'baseline' }}>
                  {link.label}
                </Link>
              ))}
            </Stack>
          )}
        </Box>
      ))}
    </Stack>
  );
}

/**
 * The `kubectl describe` answer to "why isn't this healthy": failing
 * conditions, container states and recent warnings at the top of an
 * overview, in full, instead of truncated table cells and a separate tab.
 */
export function ProblemBanner({ severity, title, items }: { severity: 'warning' | 'error'; title: string; items: ProblemItem[] }) {
  if (!items.length) return null;
  return (
    <Alert severity={severity} sx={{ '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}>
      <AlertTitle>{title}</AlertTitle>
      <ProblemItems items={items} />
    </Alert>
  );
}
