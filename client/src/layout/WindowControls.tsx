import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import RemoveIcon from '@mui/icons-material/Remove';

/** macOS uses native traffic lights; other desktops use themed controls. */
export function WindowControls() {
  const desktop = window.kubusDesktop;
  if (!desktop || desktop.platform === 'darwin') return null;
  return (
    <Box className="kubus-window-controls" sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, '--electrobun-app-region': 'no-drag' }}>
      <IconButton size="small" aria-label="Minimize window" onClick={() => desktop.minimizeWindow()}><RemoveIcon fontSize="small" /></IconButton>
      <IconButton size="small" aria-label="Maximize or restore window" onClick={() => desktop.toggleMaximize()}><CropSquareIcon sx={{ fontSize: 16 }} /></IconButton>
      <IconButton size="small" aria-label="Close window" onClick={() => desktop.closeWindow()} sx={{ '&:hover': { bgcolor: 'error.main', color: 'white' } }}><CloseIcon fontSize="small" /></IconButton>
    </Box>
  );
}
