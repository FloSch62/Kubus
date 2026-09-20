import { CLUSTER_TOOLS, readClusterQuestion, type ClusterWorkerResponse } from './cluster-query.js';
import { completeNeedle, loadNeedle } from './runtime.js';

let runtime: Awaited<ReturnType<typeof loadNeedle>> | undefined;
let busy = false;
const send = (message: ClusterWorkerResponse) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<{ prompt: string }>) => {
  if (busy) return;
  busy = true;
  try {
    const prompt = event.data.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 300) throw new Error('Enter a question of 1–300 characters.');
    if (!runtime) {
      send({ type: 'status', status: 'loading' });
      runtime = await loadNeedle(CLUSTER_TOOLS, 'needle-cluster');
    }
    send({ type: 'status', status: 'thinking' });
    send({ type: 'question', question: readClusterQuestion(completeNeedle(runtime.engine, prompt), prompt) });
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : 'Needle could not interpret the question.' });
  } finally { busy = false; }
};
