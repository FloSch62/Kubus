import { Fragment, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ClearIcon from '@mui/icons-material/Clear';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import { SHORTCUT_SECTIONS, type ShortcutRowDef } from '../shortcuts.js';
import { Kbd } from './Kbd.js';

// The definitions live next to the handlers in shortcuts.ts so this dialog
// cannot drift from what the app actually binds.
const IS_DESKTOP = !!window.kubusDesktop;

const ALL_SECTIONS = SHORTCUT_SECTIONS.map((section) => ({
  ...section,
  shortcuts: section.shortcuts.filter((s) => (!s.desktopOnly || IS_DESKTOP) && (!s.webOnly || !IS_DESKTOP)),
})).filter((section) => section.shortcuts.length > 0);

function rowMatches(sectionTitle: string, row: ShortcutRowDef, query: string): boolean {
  return (
    sectionTitle.toLowerCase().includes(query) ||
    row.description.toLowerCase().includes(query) ||
    row.combos.some((combo) => combo.join(' ').toLowerCase().includes(query))
  );
}

/** Right-aligned keycaps: alternatives joined by "or", chord keys by "+", sequence keys by "then". */
function ComboKeys({ row }: { row: ShortcutRowDef }) {
  const joiner = row.sequence ? 'then' : '+';
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: 0.5 }}>
      {row.combos.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Typography variant="caption" color="text.disabled">
              or
            </Typography>
          )}
          <Stack direction="row" spacing={0.4} sx={{ alignItems: 'center' }}>
            {combo.map((key, j) => (
              <Fragment key={j}>
                {j > 0 && (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
                    {joiner}
                  </Typography>
                )}
                <Kbd>{key}</Kbd>
              </Fragment>
            ))}
          </Stack>
        </Fragment>
      ))}
    </Stack>
  );
}

function ShortcutRow({ row }: { row: ShortcutRowDef }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', py: 0.45 }}>
      <Typography variant="body2" sx={{ minWidth: 0 }}>
        {row.description}
      </Typography>
      <ComboKeys row={row} />
    </Stack>
  );
}

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    if (!q) return ALL_SECTIONS;
    return ALL_SECTIONS.map((section) => ({
      ...section,
      shortcuts: section.shortcuts.filter((row) => rowMatches(section.title, row, q)),
    })).filter((section) => section.shortcuts.length > 0);
  }, [q]);

  // Deterministic two-column packing (greedy by row count) — CSS multi-column
  // balancing breaks sections unpredictably inside a scroll container.
  const columns = useMemo(() => {
    const cols: [typeof sections, typeof sections] = [[], []];
    const heights = [0, 0];
    for (const section of sections) {
      const at = heights[0]! <= heights[1]! ? 0 : 1;
      cols[at].push(section);
      heights[at]! += section.shortcuts.length + 2;
    }
    return cols;
  }, [sections]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: 'min(680px, 85vh)' } } }}>
      <Box sx={{ px: 3, pt: 2.5, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Typography variant="h6">Keyboard shortcuts</Typography>
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <TextField
          fullWidth
          placeholder="Search shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Same Esc rhythm as the app's filters: clear first, close second.
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
          slotProps={{
            htmlInput: { autoFocus: true },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton aria-label="Clear search" size="small" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery('')}>
                    <ClearIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
      </Box>
      <DialogContent dividers sx={{ px: 3, py: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 5, alignItems: 'start' }}>
        {columns.map((column, i) => (
          <Box key={i}>
            {column.map((section) => (
              <Box key={section.title} sx={{ mb: 2.5 }}>
                <Typography variant="overline" sx={{ display: 'block', mb: 0.5, color: 'text.secondary', letterSpacing: 1 }}>
                  {section.title}
                </Typography>
                {section.shortcuts.map((row) => (
                  <ShortcutRow key={row.description + row.combos.map((c) => c.join()).join()} row={row} />
                ))}
              </Box>
            ))}
          </Box>
        ))}
        {sections.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center', gridColumn: '1 / -1' }}>
            No shortcuts match “{query}”.
          </Typography>
        )}
      </DialogContent>
      <Box sx={{ px: 3, py: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Press <Kbd>?</Kbd> anywhere to open this dialog · press <Kbd>G</Kbd> and wait to see the go-to destinations
        </Typography>
      </Box>
    </Dialog>
  );
}
