import { memo, useState } from 'react';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import CheckIcon from '@mui/icons-material/Check';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import type { TsMode } from '../state/log-prefs.js';
import { Kbd } from './Kbd.js';

interface LogViewMenuProps {
  highlight: boolean;
  wrap: boolean;
  tsMode: TsMode;
  onHighlightChange: (highlight: boolean) => void;
  onWrapChange: (wrap: boolean) => void;
  onTsModeChange: (tsMode: TsMode) => void;
  onAddMarker: () => void;
  onClear: () => void;
}

const TS_OPTIONS: Array<{ value: TsMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'Local time' },
  { value: 'utc', label: 'UTC' },
];

const check = (on: boolean) => <ListItemIcon sx={{ minWidth: 28 }}>{on ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>;

/** The log toolbar's display settings and buffer actions, behind one labelled button. */
export const LogViewMenu = memo(function LogViewMenu({
  highlight,
  wrap,
  tsMode,
  onHighlightChange,
  onWrapChange,
  onTsModeChange,
  onAddMarker,
  onClear,
}: LogViewMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        endIcon={<ExpandMoreIcon />}
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-label="Log view options"
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        sx={{ whiteSpace: 'nowrap' }}
      >
        View
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={close} slotProps={{ paper: { sx: { minWidth: 240 } } }}>
        <MenuItem dense role="menuitemcheckbox" aria-checked={highlight} onClick={() => onHighlightChange(!highlight)}>
          {check(highlight)}
          <ListItemText primary="Syntax highlighting" secondary="ANSI colours, JSON and logfmt" />
        </MenuItem>
        <MenuItem dense role="menuitemcheckbox" aria-checked={wrap} onClick={() => onWrapChange(!wrap)}>
          {check(wrap)}
          <ListItemText primary="Wrap long lines" />
        </MenuItem>
        <ListSubheader disableSticky sx={{ lineHeight: 2.4 }}>
          Timestamps
        </ListSubheader>
        {TS_OPTIONS.map((option) => (
          <MenuItem key={option.value} dense role="menuitemradio" aria-checked={tsMode === option.value} onClick={() => onTsModeChange(option.value)}>
            {check(tsMode === option.value)}
            <ListItemText primary={option.label} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          dense
          onClick={() => {
            onAddMarker();
            close();
          }}
        >
          <ListItemIcon sx={{ minWidth: 28 }}>
            <FlagOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Add marker" />
          <Kbd>Space</Kbd>
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            onClear();
            close();
          }}
        >
          <ListItemIcon sx={{ minWidth: 28 }}>
            <DeleteSweepIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Clear buffer" />
        </MenuItem>
      </Menu>
    </>
  );
});
