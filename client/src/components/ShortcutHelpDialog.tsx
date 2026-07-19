import { Fragment } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { MOD_KEY_LABEL } from '../platform.js';

const MOD = MOD_KEY_LABEL;

interface Shortcut {
  /** Alternative key combos, each an array of keys pressed together. */
  combos: string[][];
  description: string;
}

const SECTIONS: Array<{ title: string; shortcuts: Shortcut[] }> = [
  {
    title: 'Global',
    shortcuts: [
      { combos: [[MOD, 'K']], description: 'Open the command palette' },
      { combos: [['?']], description: 'Keyboard shortcuts (this dialog)' },
      { combos: [[MOD, '1–9']], description: 'Open pinned favorite 1–9' },
      { combos: [[MOD, 'W']], description: 'Close the focused dock or page tab' },
      { combos: [['Esc']], description: 'Close dialog / details · exit maximized dock' },
    ],
  },
  {
    title: 'Command palette',
    shortcuts: [
      { combos: [['↑'], ['↓']], description: 'Move selection' },
      { combos: [['Tab'], ['→']], description: 'Show actions for the selected resource' },
      { combos: [['Enter']], description: 'Open the selected result' },
    ],
  },
  {
    title: 'Tabs & navigation',
    shortcuts: [
      { combos: [[MOD, 'Click'], ['Middle-click']], description: 'Open a link in a background tab' },
      { combos: [['Middle-click']], description: 'Close a tab (on the tab strip)' },
    ],
  },
  {
    title: 'Resource lists',
    shortcuts: [
      { combos: [['S'], ['/'], [':']], description: 'Focus the filter input' },
      { combos: [[MOD, 'F']], description: 'Focus the filter input' },
      { combos: [[MOD, 'C']], description: 'Copy the focused cell' },
      { combos: [['Enter']], description: 'Open details for the focused row' },
      { combos: [['Right-click'], ['Shift', 'F10']], description: 'Open the row actions menu' },
      { combos: [['Esc']], description: 'Close the details panel (from inside it)' },
    ],
  },
  {
    title: 'Logs',
    shortcuts: [
      { combos: [[MOD, 'F']], description: 'Focus find' },
      { combos: [['Enter'], ['Shift', 'Enter']], description: 'Next / previous match' },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <Box
      component="kbd"
      sx={{
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1,
        px: 0.75,
        py: 0.5,
        border: 1,
        borderColor: 'divider',
        borderBottomWidth: 2,
        borderRadius: 1,
        bgcolor: 'action.hover',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  );
}

function ShortcutRow({ combos, description }: Shortcut) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 0.5 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 150, flexWrap: 'wrap', rowGap: 0.5, flexShrink: 0 }}>
        {combos.map((combo, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <Typography variant="caption" color="text.secondary">
                or
              </Typography>
            )}
            <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center' }}>
              {combo.map((key, j) => (
                <Fragment key={j}>
                  {j > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      +
                    </Typography>
                  )}
                  <Kbd>{key}</Kbd>
                </Fragment>
              ))}
            </Stack>
          </Fragment>
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
    </Stack>
  );
}

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center' }}>
        Keyboard shortcuts
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose} aria-label="Close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Grid container spacing={3}>
          {SECTIONS.map((section) => (
            <Grid key={section.title} size={{ xs: 12, sm: 6 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                {section.title}
              </Typography>
              {section.shortcuts.map((s) => (
                <ShortcutRow key={s.description + s.combos.map((c) => c.join()).join()} {...s} />
              ))}
            </Grid>
          ))}
        </Grid>
      </DialogContent>
    </Dialog>
  );
}
