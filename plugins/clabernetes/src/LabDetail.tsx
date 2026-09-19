import { lazy, Suspense, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { NodeTable } from './NodeTable.js';
import { Conditions, ResourceButton } from './components.js';
import { key, source, string, type Located } from './model.js';
import { labGraph, type Lab } from './labs.js';
const Viewer = lazy(() => import('./Viewer.js').then((m) => ({ default: m.Viewer })));

export function LabDetail({
  lab,
  pods,
  loading,
  onNode,
  selected,
}: {
  lab: Lab;
  pods: Located[];
  loading: boolean;
  onNode: (n: Located) => void;
  selected?: string;
}) {
  const [showNodes, setShowNodes] = useState(true);
  const [definition, setDefinition] = useState(false);
  const [missing, setMissing] = useState('');
  const graph = labGraph(lab);
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" sx={{ px: 1.5, py: 0.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {graph.generated ? 'Topology assembled from Node and Link resources' : 'Containerlab topology'}
        </Typography>
        <Button onClick={() => setDefinition(true)}>Definition</Button>
        <Button onClick={() => setShowNodes((v) => !v)}>{showNodes ? 'Hide device tray' : 'Show device tray'}</Button>
      </Stack>
      {lab.topologies
        .filter((t) => t.status?.error)
        .map((t) => (
          <Alert key={key(t)} severity="error">
            {t.metadata.name}: {string(t.status?.error)}
          </Alert>
        ))}
      {missing && (
        <Alert severity="info" onClose={() => setMissing('')}>
          Node “{missing}” has no available Node resource yet.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 200, display: 'flex' }}>
        <Suspense fallback={<LinearProgress />}>
          <Viewer
            yaml={graph.yaml}
            onSelect={(name) => {
              const n = lab.nodes.find((n) => n.metadata.name === name);
              if (n) onNode(n);
              else if (name) setMissing(name);
            }}
          />
        </Suspense>
      </Box>
      {showNodes && (
        <Box sx={{ height: 220, flexShrink: 0, borderTop: 1, borderColor: 'divider' }}>
          <NodeTable nodes={lab.nodes} pods={pods} loading={loading} compact onSelect={onNode} selected={selected} />
        </Box>
      )}
      <Dialog open={definition} onClose={() => setDefinition(false)} maxWidth="md" fullWidth>
        <DialogTitle>{lab.name} · Definition</DialogTitle>
        <DialogContent>
          {graph.generated && (
            <>
              <Alert severity="info">Generated visualization of the namespace’s Nodes and Links. This is not a Topology manifest.</Alert>
              <Box component="pre">{graph.yaml}</Box>
            </>
          )}
          {lab.topologies.map((t) => (
            <Box key={key(t)}>
              <ResourceButton resource={t}>Inspect Topology · {t.metadata.name}</ResourceButton>
              <Box component="pre">{source(t)}</Box>
              <Conditions conditions={t.status?.conditions} />
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDefinition(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
