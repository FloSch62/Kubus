import { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

interface Props {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Disable confirmation for a live precondition without presenting it as in-progress work. */
  disabled?: boolean;
  /** When set, the user must type this exact text before the confirm button enables (protected clusters). */
  confirmText?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, busy, disabled, confirmText, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setTyped('');
  }
  const blocked = !!confirmText && typed !== confirmText;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
        {confirmText && (
          <>
            <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>
              Type <b>{confirmText}</b> to confirm.
            </Typography>
            <TextField
              autoFocus
              fullWidth
              size="small"
              placeholder={confirmText}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !blocked && !busy && !disabled) onConfirm();
              }}
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color={danger ? 'error' : 'primary'} onClick={onConfirm} disabled={busy || blocked || disabled}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
