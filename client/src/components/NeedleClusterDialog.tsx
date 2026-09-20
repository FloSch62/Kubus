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
import { answerClusterQuestion, type ClusterAnswer, type PodChoice } from '../needle/cluster-answer.js';
import type { ClusterQuestion, ClusterWorkerResponse } from '../needle/cluster-query.js';

const EXAMPLES = ['What is the status of the ceos pods?', 'Give me the logs of the ceos pod', 'What is my oldest pod?', 'How many secrets?', 'What is using 10.96.0.10?', 'Any 443 port open?', 'Which images are available?', 'How much free CPU and memory on my cluster?', 'Summarize the last 10 events'];
const TOPIC_LABELS: Record<string, string> = { query_pods: 'Filtered pods', pod_logs: 'Pod logs', list_configmaps: 'ConfigMaps', list_secrets: 'Secrets', lookup_ip: 'IP references', lookup_port: 'Configured ports', list_images: 'Images', node_capacity: 'Node capacity', find_pods: 'Find pods', latest_deployments: 'Latest deployments', summarize_events: 'Summarize events', recent_terminations: 'Recent failed terminations', diagnose_pod: 'Pod diagnosis' };

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
  const [focus, setFocus] = useState<PodChoice | null>(null);
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
    setFocus(null);
  }, [context, namespaceKey, dispose]);

  const ask = (selected?: PodChoice, action: 'diagnose_pod' | 'pod_logs' = 'diagnose_pod', container?: string) => {
    if (busy || !context || !prompt.trim() || prompt.length > 300) return;
    const logFollowup = /^(?:show (?:its|the|this pod's|that pod's) logs|(?:show|get|give me) logs for (?:it|this pod|that pod)|give me its logs)[?.!]?$/i.test(prompt.trim());
    const followup = logFollowup || /^(?:why is (?:it|this pod|that pod) failing\??|diagnose (?:it|this pod|that pod))$/i.test(prompt.trim());
    if (followup && !focus) { setError('Find or diagnose a pod first, then ask about it.'); return; }
    const target = selected ?? (followup ? focus : null);
    const targetAction = logFollowup ? 'pod_logs' : action;
    const previous = answer?.question.topic === 'pod_logs' && answer.question.previous;
    const selectedContainer = container ?? (answer?.question.topic === 'pod_logs' ? answer.question.container : undefined);
    const requestPrompt = target ? `${targetAction === 'pod_logs' ? 'Show logs for' : 'Diagnose'} pod ${target.name} in namespace ${target.namespace}` : prompt.trim();
    setAnswer(null);
    setError('');
    if (!target) setFocus(null);
    const scope = { context, namespaces: JSON.parse(namespaceKey) as string[] };
    const controller = new AbortController();
    controllerRef.current = controller;
    const fail = (message: string) => {
      if (controllerRef.current !== controller) return;
      dispose();
      setPhase('idle');
      setError(message);
    };
    const answerQuestion = (question: ClusterQuestion) => {
      setPhase('reading');
      void answerClusterQuestion(target ? { ...question, uid: target.uid } : question, scope, controller.signal).then((result) => {
        if (controllerRef.current !== controller || controller.signal.aborted) return;
        clearTimeout(timeoutRef.current);
        controllerRef.current = null;
        setAnswer(result);
        setFocus(result.focus ?? null);
        setPhase('idle');
      }).catch((cause: unknown) => fail(cause instanceof Error ? cause.message : 'Cluster data could not be read.'));
    };
    try {
      timeoutRef.current = setTimeout(() => fail('The question took too long. Try a smaller namespace scope or check the cluster connection.'), 60_000);
      if (target) {
        if (selected) setPrompt(requestPrompt.length <= 300 ? requestPrompt : `${targetAction === 'pod_logs' ? 'Show logs for' : 'Diagnose'} ${selected.name}`);
        answerQuestion({ topic: targetAction, name: target.name, namespace: target.namespace, uid: target.uid, ...(targetAction === 'pod_logs' ? { container: selectedContainer, previous: previous || undefined } : {}) });
        return;
      }
      setPhase(workerRef.current ? 'thinking' : 'loading');
      const worker = workerRef.current ?? new Worker(new URL('../needle/cluster.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<ClusterWorkerResponse>) => {
        if (controllerRef.current !== controller || workerRef.current !== worker) return;
        const message = event.data;
        if (message.type === 'status') { setPhase(message.status); return; }
        if (message.type === 'error') { fail(message.error); return; }
        answerQuestion(message.question);
      };
      worker.onerror = () => fail('Needle could not start. Check the local model assets with pnpm setup:needle.');
      worker.postMessage({ prompt: requestPrompt });
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
          Filter pods, read logs, find IPs and ports, inspect resources or check cluster capacity. After choosing a pod, ask “Show its logs” or “Why is it failing?”.
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
          helperText="Read-only questions. Match names, labels or images, filter by node or status, and sort by age or usage. Logs and diagnosis ask you to choose if several pods match."
        />
        {focus && <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>Selected pod: {focus.namespace}/{focus.name}. Follow-up questions refresh this pod’s data.</Typography>}
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
            Interpreted as: {TOPIC_LABELS[answer.question.topic] ?? answer.question.topic}{answer.question.name ? ` · ${answer.question.name}` : ''}. Cluster: {answer.scope.context}. Namespaces: {answer.scope.namespaces.join(', ') || 'All'}. Fetched at {new Date(answer.fetchedAt).toLocaleTimeString()}.
          </Alert>
          {answer.sections.map((section, index) => <Box key={`${section.title}-${index}`} sx={{ mb: 3 }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6">{section.title}</Typography>
              {section.href && <Button size="small" onClick={() => openPage(section.href!)}>Open in Kubus</Button>}
            </Stack>
            <Typography variant="body2" sx={{ my: 1 }}>{section.summary}</Typography>
            {!!section.rows.length && <TableContainer sx={{ maxHeight: 360 }}><Table size="small" stickyHeader aria-label={section.title}>
              <TableHead><TableRow>{section.columns.map((column) => <TableCell key={column}>{column}</TableCell>)}{section.rowLinks && <TableCell>Resource</TableCell>}</TableRow></TableHead>
              <TableBody>{section.rows.map((row, rowIndex) => <TableRow key={rowIndex}>{row.map((cell, column) => <TableCell key={column} sx={{ overflowWrap: 'anywhere', minWidth: 80 }}>{cell}</TableCell>)}{section.rowLinks && <TableCell><Stack direction="row" spacing={.5}><Button size="small" onClick={() => openPage(section.rowLinks![rowIndex]!)}>Open</Button>{section.rowPods?.[rowIndex] && <><Button size="small" aria-label={`Diagnose ${section.rowPods[rowIndex]!.namespace}/${section.rowPods[rowIndex]!.name}`} disabled={busy} onClick={() => ask(section.rowPods![rowIndex]!)}>Diagnose</Button><Button size="small" aria-label={`Logs ${section.rowPods[rowIndex]!.namespace}/${section.rowPods[rowIndex]!.name}`} disabled={busy} onClick={() => ask(section.rowPods![rowIndex]!, 'pod_logs')}>Logs</Button></>}</Stack></TableCell>}</TableRow>)}</TableBody>
            </Table></TableContainer>}
            {section.text !== undefined && <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto', fontSize: 12, p: 1, bgcolor: 'action.hover' }}>{section.text}</Box>}
          </Box>)}
          {!!answer.candidates?.length && !answer.sections.some((section) => section.rowPods?.length) && <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }}>
            {answer.candidates.map((pod) => <Stack key={pod.uid} direction="row" spacing={.5}><Button size="small" variant="outlined" disabled={busy} onClick={() => ask(pod)}>Diagnose {pod.namespace}/{pod.name}</Button><Button size="small" variant="outlined" disabled={busy} onClick={() => ask(pod, 'pod_logs')}>Logs {pod.namespace}/{pod.name}</Button></Stack>)}
          </Stack>}
          {!!answer.containers?.length && <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }}>{answer.containers.map(({ pod, name }) => <Button key={name} variant="outlined" size="small" onClick={() => ask(pod, 'pod_logs', name)}>Logs for container {name}</Button>)}</Stack>}
          {answer.notices.map((notice) => <Typography key={notice} variant="caption" color="text.secondary" sx={{ display: 'block', mb: .5 }}>{notice}</Typography>)}
        </Box>}
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
          Needle interprets your question locally. Kubus reads the cluster and calculates the answer; cluster data is not sent to an AI service.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {busy ? <Button onClick={() => { dispose(); setPhase('idle'); }}>Cancel request</Button> :
          <Button variant="contained" disabled={!context || !prompt.trim() || prompt.length > 300} onClick={() => ask()}>Ask cluster</Button>}
      </DialogActions>
    </Dialog>
  );
}
