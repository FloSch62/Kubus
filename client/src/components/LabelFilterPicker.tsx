import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, type Theme } from '@mui/material/styles';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import KeyboardReturnIcon from '@mui/icons-material/KeyboardReturn';
import SearchIcon from '@mui/icons-material/Search';
import type { ClusterRow } from '../api/queries.js';
import { countLabelPairs, typedLabelTerms } from '../label-selector.js';

/** Entries (keys plus values) listed before the picker asks for a narrower search. */
const MAX_ENTRIES = 100;

/** Values shown under a key before a "more" row, so the next keys stay in reach. */
const VALUES_PER_KEY = 5;

const MONO = { fontFamily: 'monospace', fontSize: 12.5 } as const;

/** The native checkbox stays for keyboard and screen readers; the icon draws it. */
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, m: 0, p: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none' } as const;

interface Props {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  rows: ClusterRow[];
  terms: readonly string[];
  onTermsChange: (terms: string[]) => void;
}

interface Entry {
  term: string;
  key: string;
  /** Undefined for the key's own "has this label" row. */
  value?: string;
  count: number;
  /** Set on the row that reveals a key's remaining values: how many. */
  more?: number;
}

/**
 * Browse the labels of the listed rows and tick any number of them into the
 * list's label selector (it stays open while you pick), or type a raw
 * selector term. Keys come most common first, each with its values below.
 */
export function LabelFilterPicker({ anchorEl, onClose, rows, terms, onTermsChange }: Props) {
  const open = !!anchorEl;
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState('');
  const [rawError, setRawError] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const findRef = useRef<HTMLInputElement>(null);

  // Ticking a label narrows the rows and recounts them; keep the order the
  // picker opened with so entries don't jump under the pointer.
  const orderRef = useRef<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    if (!open) orderRef.current = undefined;
  }, [open]);
  // Only scan the rows while the picker is open.
  const keys = useMemo(() => {
    if (!open) return [];
    const counted = countLabelPairs(rows.map((r) => r.obj.metadata.labels));
    const order = (orderRef.current ??= new Map());
    const rank = (term: string) => {
      if (!order.has(term)) order.set(term, order.size);
      return order.get(term)!;
    };
    for (const k of counted) {
      rank(k.key);
      for (const v of k.values) rank(`${k.key}=${v.value}`);
    }
    return counted
      .map((k) => ({ ...k, values: [...k.values].sort((a, b) => rank(`${k.key}=${a.value}`) - rank(`${k.key}=${b.value}`)) }))
      .sort((a, b) => rank(a.key) - rank(b.key));
  }, [open, rows]);
  const { entries, truncated } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Entry[] = [];
    let more = false;
    for (const k of keys) {
      const keyMatch = !q || k.key.toLowerCase().includes(q);
      const values = keyMatch ? k.values : k.values.filter((v) => `${k.key}=${v.value}`.toLowerCase().includes(q));
      if (!keyMatch && values.length === 0) continue;
      if (out.length >= MAX_ENTRIES) {
        more = true;
        break;
      }
      out.push({ term: k.key, key: k.key, count: k.count });
      // Ticked values always show; a search shows every match.
      const cut = q || expanded.has(k.key) ? values.length : VALUES_PER_KEY;
      const shown = values.filter((v, i) => i < cut || terms.includes(`${k.key}=${v.value}`));
      for (const v of shown) {
        if (out.length >= MAX_ENTRIES) {
          more = true;
          break;
        }
        out.push({ term: `${k.key}=${v.value}`, key: k.key, value: v.value, count: v.count });
      }
      if (shown.length < values.length && out.length < MAX_ENTRIES) {
        out.push({ term: `more:${k.key}`, key: k.key, count: 0, more: values.length - shown.length });
      }
    }
    return { entries: out, truncated: more };
  }, [keys, query, expanded, terms]);

  const toggle = (term: string) => onTermsChange(terms.includes(term) ? terms.filter((t) => t !== term) : [...terms, term]);

  const applyRaw = () => {
    const typed = typedLabelTerms(raw, { bareKeys: true });
    if (!typed) {
      setRawError(!!raw.trim());
      return;
    }
    onTermsChange([...terms, ...typed.filter((t) => !terms.includes(t))]);
    setRaw('');
    setRawError(false);
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        transition: { onEntered: () => findRef.current?.focus() },
        paper: {
          role: 'dialog',
          'aria-label': 'Filter by label',
          sx: {
            mt: 0.75,
            width: 400,
            maxWidth: 'calc(100vw - 24px)',
            border: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: (theme) => (theme.palette.mode === 'dark' ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)'),
          },
        },
      }}
    >
      <Box sx={{ p: 1.5, pb: 1.25 }}>
        <Typography variant="subtitle2">Filter by label</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Tick any number of labels. A row has to match all of them; the cluster does the filtering.
        </Typography>
        {terms.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, mt: 1.25 }}>
            {terms.map((term) => (
              <Chip
                key={term}
                size="small"
                label={term}
                color="primary"
                variant="outlined"
                onDelete={() => onTermsChange(terms.filter((t) => t !== term))}
                deleteIcon={<CancelIcon aria-label={`Remove label filter ${term}`} />}
                sx={{ height: 22, maxWidth: '100%', ...MONO, fontSize: 12 }}
              />
            ))}
            <Button size="small" onClick={() => onTermsChange([])} sx={{ ml: 'auto', minWidth: 0, px: 1, py: 0, fontSize: 12 }}>
              Clear all
            </Button>
          </Box>
        )}
        <TextField
          inputRef={findRef}
          fullWidth
          size="small"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a label key or value"
          sx={{ mt: 1.25 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Find a label' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>
      <Divider />
      <Box component="fieldset" aria-label="Labels in this list" sx={{ border: 0, m: 0, px: 0, minWidth: 0, maxHeight: 320, overflowY: 'auto', py: 0.5 }}>
        {entries.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            {keys.length === 0 ? 'No labels on the rows in this list.' : `No label matches "${query.trim()}".`}
          </Typography>
        ) : (
          entries.map((entry) =>
            entry.more ? (
              <MoreValues key={entry.term} entry={entry} onExpand={() => setExpanded((prev) => new Set(prev).add(entry.key))} />
            ) : (
              <LabelOption key={entry.term} entry={entry} checked={terms.includes(entry.term)} onToggle={toggle} />
            ),
          )
        )}
        {truncated && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, py: 0.75 }}>
            Showing the first {MAX_ENTRIES}. Type to narrow the list.
          </Typography>
        )}
      </Box>
      <Divider />
      <Box sx={{ p: 1.5, pt: 1.25 }}>
        <TextField
          fullWidth
          size="small"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setRawError(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            applyRaw();
          }}
          placeholder="Or type a selector, e.g. env!=prod"
          error={rawError}
          helperText={rawError ? 'Use key=value, key!=value, key, !key or key in (a,b); commas separate terms.' : undefined}
          slotProps={{
            htmlInput: { 'aria-label': 'Label selector', sx: { ...MONO, '&::placeholder': { fontFamily: (theme: Theme) => theme.typography.fontFamily, fontSize: 13 } } },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Add (Enter)">
                    <span>
                      <IconButton size="small" edge="end" aria-label="Add selector" disabled={!raw.trim()} onClick={applyRaw}>
                        <KeyboardReturnIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>
    </Popover>
  );
}

/**
 * One tickable label: a key ("has this label, any value") or one of its
 * values, indented under it with a guide rail.
 */
function LabelOption({ entry, checked, onToggle }: { entry: Entry; checked: boolean; onToggle: (term: string) => void }) {
  const isKey = entry.value === undefined;
  const Check = checked ? CheckBoxIcon : CheckBoxOutlineBlankIcon;
  return (
    <Box
      component="label"
      sx={(theme) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minHeight: 30,
        position: 'relative',
        pr: 2,
        pl: isKey ? 1.5 : 0,
        mt: isKey ? 0.5 : 0,
        cursor: 'pointer',
        '&:first-of-type': { mt: 0 },
        '&:hover': { bgcolor: 'action.hover' },
        '&:has(input:focus-visible)': { bgcolor: 'action.focus' },
        ...(checked && {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.07),
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.11) },
        }),
      })}
    >
      {!isKey && <ValueRail />}
      <Box
        component="input"
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(entry.term)}
        aria-label={isKey ? `${entry.key}, any value` : entry.term}
        sx={VISUALLY_HIDDEN}
      />
      <Check aria-hidden sx={{ fontSize: 18, flexShrink: 0, color: checked ? 'primary.main' : 'text.disabled' }} />
      <Typography
        component="span"
        noWrap
        title={entry.term}
        sx={{ ...MONO, flex: 1, minWidth: 0, fontWeight: isKey ? 600 : 400, color: checked ? 'primary.main' : 'text.primary' }}
      >
        {isKey ? entry.key : entry.value === '' ? <Box component="span" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>(empty)</Box> : entry.value}
      </Typography>
      {isKey && (
        <Typography component="span" variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          any value
        </Typography>
      )}
      <Typography component="span" variant="caption" color="text.secondary" sx={{ flexShrink: 0, minWidth: 24, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {entry.count}
      </Typography>
    </Box>
  );
}

/** Value rows hang off their key: a neutral guide rail under the key's checkbox. */
function ValueRail() {
  return <Box aria-hidden sx={{ alignSelf: 'stretch', width: 21, ml: 1.5, flexShrink: 0, borderRight: 1, borderColor: 'divider' }} />;
}

/** Reveals the rest of a key's values in place. */
function MoreValues({ entry, onExpand }: { entry: Entry; onExpand: () => void }) {
  return (
    <ButtonBase
      onClick={onExpand}
      sx={{
        display: 'flex',
        justifyContent: 'flex-start',
        alignItems: 'center',
        gap: 1,
        width: '100%',
        minHeight: 28,
        pr: 2,
        textAlign: 'left',
        color: 'primary.main',
        '&:hover': { bgcolor: 'action.hover', '& .more-label': { textDecoration: 'underline' } },
        '&.Mui-focusVisible': { bgcolor: 'action.focus' },
      }}
    >
      <ValueRail />
      <Typography component="span" className="more-label" variant="caption" sx={{ fontWeight: 600, pl: 3.25 }}>
        Show {entry.more} more {entry.more === 1 ? 'value' : 'values'} of {entry.key}
      </Typography>
    </ButtonBase>
  );
}
