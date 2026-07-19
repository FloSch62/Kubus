import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { useAddHelmRepo } from '../api/queries.js';

interface Props {
  onClose: () => void;
  onAdded: (name: string) => void;
  /** Prefill, e.g. the chart name whose repo the user is trying to add. */
  defaultName?: string;
}

/** Add a classic http(s) chart repository (validates against its index.yaml). */
export function HelmAddRepoDialog({ onClose, onAdded, defaultName }: Props) {
  const addRepo = useAddHelmRepo();
  const [name, setName] = useState(defaultName ?? '');
  const [url, setUrl] = useState('');
  const submit = () =>
    addRepo.mutate(
      { name: name.trim(), url: url.trim() },
      {
        onSuccess: (r) => {
          onAdded(r.name);
          onClose();
        },
      },
    );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add chart repository</DialogTitle>
      <DialogContent sx={{ pt: '8px !important', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {addRepo.error && <Alert severity="error">{addRepo.error.message}</Alert>}
        <TextField size="small" label="Name" placeholder="prometheus-community" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          size="small"
          label="URL"
          placeholder="https://prometheus-community.github.io/helm-charts"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && url.trim()) submit();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim() || !url.trim() || addRepo.isPending} onClick={submit}>
          {addRepo.isPending ? 'Validating…' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
