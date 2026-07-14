import { useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import type { KubeObject } from '@kubus/shared';
import { apiFetchRaw } from '../api/http.js';
import { podContainerNames } from '../kube-display.js';

interface Props {
  ctx: string;
  obj: KubeObject;
  onClose: () => void;
}

function filesUrl(op: 'download' | 'upload', ctx: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  return `/api/contexts/${encodeURIComponent(ctx)}/files/${op}?${q}`;
}

/** Download / upload files between the browser and a container (kubectl cp). */
export function FileCopyDialog({ ctx, obj, onClose }: Props) {
  const pod = obj.metadata.name;
  const namespace = obj.metadata.namespace ?? '';
  const containers = podContainerNames(obj);
  const [container, setContainer] = useState(containers[0] ?? '');
  const [remotePath, setRemotePath] = useState('/');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const download = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetchRaw(filesUrl('download', ctx, { namespace, pod, container, path: remotePath.trim() }));
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? remotePath.split('/').findLast((segment) => segment.length > 0) ?? 'download';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setNote({ severity: 'success', text: `Downloaded ${filename} (${blob.size.toLocaleString()} bytes). Directories arrive as .tar.` });
    } catch (err) {
      setNote({ severity: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setNote(null);
    try {
      const base = remotePath.trim();
      // Treat a trailing slash as "into this directory".
      const target = base.endsWith('/') ? `${base}${file.name}` : base;
      const res = await apiFetchRaw(filesUrl('upload', ctx, { namespace, pod, container, path: target }), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      const body = (await res.json()) as { bytes?: number };
      setNote({ severity: 'success', text: `Uploaded ${file.name} → ${target} (${(body.bytes ?? file.size).toLocaleString()} bytes)` });
    } catch (err) {
      setNote({ severity: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Files — {pod}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
        <Typography variant="body2" color="text.secondary">
          Copies files over the exec API (like <code>kubectl cp</code>) — the container must provide <code>cat</code>/<code>tee</code>
          (and <code>tar</code> for directories).
        </Typography>
        <FormControl size="small" fullWidth>
          <InputLabel id="files-container">Container</InputLabel>
          <Select labelId="files-container" label="Container" value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          autoFocus
          fullWidth
          label="Remote path"
          value={remotePath}
          onChange={(e) => setRemotePath(e.target.value)}
          helperText="Download: file or directory (directories arrive as .tar). Upload: target file, or a directory ending in /"
        />
        {busy && <LinearProgress />}
        {note && <Alert severity={note.severity}>{note.text}</Alert>}
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<UploadIcon />} variant="outlined" disabled={busy || !remotePath.trim() || !container} onClick={() => fileInputRef.current?.click()}>
            Upload…
          </Button>
          <Button startIcon={<DownloadIcon />} variant="contained" disabled={busy || !remotePath.trim() || !container} onClick={() => void download()}>
            Download
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
