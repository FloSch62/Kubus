import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useClustersStore } from '../state/clusters.js';
import { answerClusterQuestion, type ClusterAnswer } from '../needle/cluster-answer.js';
import type { ClusterWorkerResponse } from '../needle/cluster-query.js';

const EXAMPLES = ['What is unhealthy?', 'Show pod restart counts', 'Which pods use the most memory?', 'What warnings happened recently?', 'Which container images are running?'];

export function NeedleClusterDialog({ onClose }: { onClose: () => void }) {
  const contexts = useClustersStore((state) => state.selected);
  const namespacesByContext = useClustersStore((state) => state.namespacesByContext);
  const [choice, setChoice] = useState(contexts[0] ?? '');
  const context = contexts.includes(choice) ? choice : contexts[0] ?? '';
  const namespaceKey = JSON.stringify(namespacesByContext[context] ?? []);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'thinking' | 'reading'>('idle');
  const [answer, setAnswer] = useState<ClusterAnswer | null>(null);
  const [error, setError] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const busy = phase !== 'idle';
  const dispose = useCallback(() => {
    clearTimeout(timeoutRef.current);
    controllerRef.current?.abort();
    controllerRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);
  useEffect(() => dispose, [dispose]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    dispose();
    setAnswer(null);
    setError('');
    setPhase('idle');
  }, [context, namespaceKey, dispose]);

  const ask = () => {
    if (busy || !context || !prompt.trim() || prompt.length > 300) return;
    setAnswer(null);
    setError('');
    const scope = { context, namespaces: JSON.parse(namespaceKey) as string[] };
    const controller = new AbortController();
    controllerRef.current = controller;
    const fail = (message: string) => {
      if (controllerRef.current !== controller) return;
      dispose();
      setPhase('idle');
      setError(message);
    };
    try {
      setPhase(workerRef.current ? 'thinking' : 'loading');
      const worker = workerRef.current ?? new Worker(new URL('../needle/cluster.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<ClusterWorkerResponse>) => {
        if (controllerRef.current !== controller || workerRef.current !== worker) return;
        const message = event.data;
        if (message.type === 'status') { setPhase(message.status); return; }
        if (message.type === 'error') { fail(message.error); return; }
        setPhase('reading');
        void answerClusterQuestion(message.question, scope, controller.signal).then((result) => {
          if (controllerRef.current !== controller || controller.signal.aborted) return;
          clearTimeout(timeoutRef.current);
          controllerRef.current = null;
          setAnswer(result);
          setPhase('idle');
        }).catch((cause: unknown) => fail(cause instanceof Error ? cause.message : 'Cluster data could not be read.'));
      };
      worker.onerror = () => fail('Needle could not start. Check the local model assets with pnpm setup:needle.');
      timeoutRef.current = setTimeout(() => fail('The question took too long. Try a smaller namespace scope or check the cluster connection.'), 60_000);
      worker.postMessage({ prompt: prompt.trim() });
    } catch (cause) { fail(cause instanceof Error ? cause.message : 'The local model worker could not start.'); }
  };
  const updatePrompt = (value: string) => { setPrompt(value); setAnswer(null); setError(''); };
  const openPage = (href: string) => {
    if (!answer) return;
    useClustersStore.getState().setSelected([answer.scope.context]);
    useClustersStore.getState().setNamespaces(answer.scope.namespaces, [answer.scope.context]);
    void navigate(href);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg" aria-labelledby="needle-cluster-title">
      <DialogTitle id="needle-cluster-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <span>Ask your cluster</span><Chip label="Local AI · Trial" size="small" variant="outlined" color="primary" />
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Ask about health, resources, warnings, restarts, CPU, memory or images. Answers use current cluster observations. Each question is independent.
        </Typography>
        {!context && <Alert severity="info" sx={{ mb: 2 }}>Connect and select a cluster first.</Alert>}
        {!!context && <TextField select label="Cluster" size="small" value={context} disabled={busy} onChange={(event) => setChoice(event.target.value)} sx={{ minWidth: 240, mb: 1 }}>
          {contexts.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}
        </TextField>}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Namespace scope: {(JSON.parse(namespaceKey) as string[]).join(', ') || 'All namespaces'}. A namespace named in your question overrides this scope.
        </Typography>
        <TextField inputRef={inputRef} fullWidth multiline minRows={2} maxRows={4} label="Question about your cluster"
          value={prompt} disabled={busy} onChange={(event) => updatePrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(); } }}
          slotProps={{ htmlInput: { maxLength: 300 } }}
          helperText="Read-only reports. For a specific resource, include its exact name and namespace."
        />
        <Stack direction="row" useFlexGap spacing={0.75} sx={{ flexWrap: 'wrap', my: 2 }}>
          {EXAMPLES.map((example) => <Chip key={example} label={example} size="small" variant="outlined" disabled={busy} onClick={() => updatePrompt(example)} />)}
        </Stack>
        {busy && <Box component="output" aria-live="polite" sx={{ mb: 2, display: 'block' }}>
          <Typography variant="body2" sx={{ mb: 1 }}>{phase === 'loading' ? 'Loading the local model…' : phase === 'thinking' ? 'Interpreting your question…' : 'Reading cluster data…'}</Typography>
          <LinearProgress />
        </Box>}
        {error && <Alert severity="info" sx={{ mb: 2 }}>{error}</Alert>}
        {answer && <Box aria-live="polite" data-testid="cluster-answer">
          <Alert severity="info" sx={{ mb: 2 }}>
            Interpreted as: {answer.question.topic}{answer.question.name ? ` · ${answer.question.name}` : ''}. Cluster: {answer.scope.context}. Namespaces: {answer.scope.namespaces.join(', ') || 'All'}. Fetched at {new Date(answer.fetchedAt).toLocaleTimeString()}.
          </Alert>
          {answer.sections.map((section, index) => <Box key={`${section.title}-${index}`} sx={{ mb: 3 }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6">{section.title}</Typography>
              {section.href && <Button size="small" onClick={() => openPage(section.href!)}>Open in Kubus</Button>}
            </Stack>
            <Typography variant="body2" sx={{ my: 1 }}>{section.summary}</Typography>
            {!!section.rows.length && <TableContainer sx={{ maxHeight: 360 }}><Table size="small" stickyHeader aria-label={section.title}>
              <TableHead><TableRow>{section.columns.map((column) => <TableCell key={column}>{column}</TableCell>)}</TableRow></TableHead>
              <TableBody>{section.rows.map((row, rowIndex) => <TableRow key={rowIndex}>{row.map((cell, column) => <TableCell key={column} sx={{ overflowWrap: 'anywhere', minWidth: 80 }}>{cell}</TableCell>)}</TableRow>)}</TableBody>
            </Table></TableContainer>}
          </Box>)}
          {answer.notices.map((notice) => <Typography key={notice} variant="caption" color="text.secondary" sx={{ display: 'block', mb: .5 }}>{notice}</Typography>)}
        </Box>}
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
          Needle interprets your question locally. Kubus reads the cluster and calculates the answer; cluster data is not sent to an AI service.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {busy ? <Button onClick={() => { dispose(); setPhase('idle'); }}>Cancel request</Button> :
          <Button variant="contained" disabled={!context || !prompt.trim() || prompt.length > 300} onClick={ask}>Ask cluster</Button>}
      </DialogActions>
    </Dialog>
  );
}
