import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { LOG_EXPORT_FORMATS, type LogExportFormat } from './log-tools.js';

interface LogExportMenuProps {
  /** "Copy" or "Download". */
  verb: string;
  icon: ReactNode;
  lineCount: number;
  /** Renders a one-line sample of a format from the first visible line. */
  preview: (format: LogExportFormat) => string | undefined;
  onExport: (format: LogExportFormat) => void;
}

/** A toolbar button whose menu offers every export format, each with a live sample. */
export function LogExportMenu({ verb, icon, lineCount, preview, onExport }: LogExportMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const noun = `${lineCount.toLocaleString()} visible ${lineCount === 1 ? 'line' : 'lines'}`;
  return (
    <>
      <Tooltip title={`${verb} visible logs`}>
        <IconButton
          size="small"
          aria-label={`${verb} visible logs`}
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          {icon}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: 'calc(100vw - 32px)' } } }}
      >
        <ListSubheader disableSticky sx={{ lineHeight: '32px' }}>
          {verb} {noun} as
        </ListSubheader>
        {LOG_EXPORT_FORMATS.map((format) => {
          const sample = anchor ? preview(format.value) : undefined;
          return (
            <MenuItem
              key={format.value}
              onClick={() => {
                setAnchor(null);
                onExport(format.value);
              }}
              sx={{ alignItems: 'flex-start', whiteSpace: 'normal' }}
            >
              <ListItemText
                primary={format.label}
                secondary={
                  <>
                    <Box component="span" sx={{ display: 'block' }}>
                      {format.hint}
                    </Box>
                    {sample ? (
                      <Box
                        component="span"
                        sx={{ display: 'block', mt: 0.25, fontFamily: '"JetBrains Mono", monospace', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {sample}
                      </Box>
                    ) : null}
                  </>
                }
              />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
