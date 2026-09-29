import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

/**
 * The object moved on the server under an open Manifest editor (tree or
 * YAML). With edits staged it offers to replay them onto the latest version;
 * a clean YAML view just offers to load it.
 */
export function LiveChangeAlert({ editing, onAction }: { editing: boolean; onAction: () => void }) {
  return (
    <Alert
      severity={editing ? 'warning' : 'info'}
      sx={{ borderRadius: 0, flexShrink: 0 }}
      action={
        <Button color="inherit" size="small" onClick={onAction} sx={{ whiteSpace: 'nowrap' }}>
          {editing ? 'Rebase edits' : 'Reload'}
        </Button>
      }
    >
      {editing
        ? 'This object changed on the server while you were editing. Rebase replays your edits onto the latest version.'
        : 'This object changed on the server since the editor loaded it.'}
    </Alert>
  );
}
