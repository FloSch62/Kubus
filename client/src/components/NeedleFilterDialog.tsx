import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ClusterRow } from '../api/queries.js';
import { matchesSmartFilter, parseSmartFilter } from '../smart-filter.js';
import type { NeedleWorkerResponse, PodFilterSuggestion } from '../needle/pod-filter.js';

const EXAMPLES = ['Show crashing pods in production', 'Show pending pods', 'Show pods in namespace kube-system'];

interface Props {
  rows: ClusterRow[];
  currentFilter: string;
  onApply: (filter: string) => void;
  onClose: () => void;
}

export function NeedleFilterDialog({ rows, currentFilter, onApply, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'thinking'>('idle');
  const [result, setResult] = useState<(PodFilterSuggestion & { elapsedMs: number }) | null>(null);
  const [error, setError] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = phase !== 'idle';

  const dispose = useCallback(() => {
    clearTimeout(timeoutRef.current);
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);
  useEffect(() => dispose, [dispose]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const previewCount = useMemo(() => {
    if (!result) return 0;
    const clauses = parseSmartFilter(result.filter.slice(1));
    return rows.filter((row) => matchesSmartFilter(row, clauses, { kind: 'Pod', nowMs: Date.now() })).length;
  }, [result, rows]);

  const updatePrompt = (value: string) => {
    setPrompt(value);
    setResult(null);
    setError('');
  };

  const generate = () => {
    if (!prompt.trim() || prompt.length > 300 || busy) return;
    setResult(null);
    setError('');
    setPhase(workerRef.current ? 'thinking' : 'loading');
    const fail = (message: string) => {
      dispose();
      setPhase('idle');
      setError(message);
    };
    try {
      const worker = workerRef.current ?? new Worker(new URL('../needle/needle.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<NeedleWorkerResponse>) => {
        if (workerRef.current !== worker) return;
        const message = event.data;
        if (message.type === 'status') {
          setPhase(message.status);
          return;
        }
        clearTimeout(timeoutRef.current);
        if (message.type === 'error') {
          fail(message.error);
        } else {
          setPhase('idle');
          setResult({ ...message.result, elapsedMs: message.elapsedMs });
        }
      };
      worker.onerror = () => {
        if (workerRef.current === worker) fail('Needle could not start. Check that trial assets are installed with pnpm setup:needle and that WebAssembly is available.');
      };
      timeoutRef.current = setTimeout(() => fail('Needle took too long. Try again with a shorter request.'), 60_000);
      worker.postMessage({ prompt: prompt.trim() });
    } catch {
      fail('This browser could not start the local model worker.');
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="needle-filter-title">
      <DialogTitle id="needle-filter-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <span>Describe a pod filter</span>
          <Chip label="Local AI · Trial" size="small" variant="outlined" color="primary" />
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Find pods by namespace and health status in plain English. Needle runs on this device; your request stays local.
        </Typography>
        <TextField
          inputRef={inputRef} fullWidth multiline minRows={2} maxRows={4}
          label="Which pods would you like to see?"
          placeholder="Show crashing pods in production"
          value={prompt} disabled={busy}
          onChange={(event) => updatePrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              generate();
            }
          }}
          slotProps={{ htmlInput: { maxLength: 300 } }}
          helperText="Supports namespace and status. Use the regular smart filter for names, restarts and other conditions."
        />
        <Stack direction="row" useFlexGap spacing={0.75} sx={{ flexWrap: 'wrap', mt: 1.5, mb: 2 }}>
          {EXAMPLES.map((example) => <Chip key={example} label={example} size="small" variant="outlined" disabled={busy} onClick={() => updatePrompt(example)} />)}
        </Stack>
        {busy && (
          <Box component="output" aria-live="polite" sx={{ display: 'block', mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {phase === 'loading' ? 'Loading the local model…' : 'Creating your filter…'}
            </Typography>
            <LinearProgress />
          </Box>
        )}
        {error && <Alert severity="info" sx={{ mb: 2 }}>{error}</Alert>}
        {result && (
          <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'action.hover' }} aria-live="polite">
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle2">Filter preview</Typography>
              <Typography variant="caption" color="text.secondary">{(result.elapsedMs / 1000).toFixed(1)} s</Typography>
            </Stack>
            <Typography component="code" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{result.filter}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>{result.description}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {previewCount} of {rows.length} loaded pods match, within your current cluster and namespace selection.
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Check the preview: this experimental model can miss conditions.
              {result.confidence !== null && result.confidence < 0.7 ? ' The model is less confident about this result.' : ''}
              {currentFilter ? ' Applying replaces your current table search.' : ''}
            </Typography>
          </Box>
        )}
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
          Powered by Needle 3. Only your request is given to the model.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {busy ? (
          <Button onClick={() => { dispose(); setPhase('idle'); }}>Cancel request</Button>
        ) : (
          <Button onClick={generate} disabled={!prompt.trim() || prompt.length > 300}>Generate filter</Button>
        )}
        <Button variant="contained" disabled={!result || busy} onClick={() => { if (result) onApply(result.filter); }}>Apply filter</Button>
      </DialogActions>
    </Dialog>
  );
}
