import { POD_FILTER_TOOLS, readPodFilterSuggestion, type NeedleWorkerResponse } from './pod-filter.js';
import { completeNeedle, loadNeedle } from './runtime.js';

let runtime: Awaited<ReturnType<typeof loadNeedle>> | undefined;
let busy = false;
const send = (message: NeedleWorkerResponse) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<{ prompt: string }>) => {
  if (busy) return;
  busy = true;
  try {
    const prompt = event.data.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 300) throw new Error('Enter a request of 1–300 characters.');
    if (!runtime) {
      send({ type: 'status', status: 'loading' });
      runtime = await loadNeedle(POD_FILTER_TOOLS);
    }
    send({ type: 'status', status: 'thinking' });
    const start = performance.now();
    const response = completeNeedle(runtime.engine, prompt);
    const result = readPodFilterSuggestion(response, prompt, runtime.confidenceCalibrated);
    send({ type: 'result', result, elapsedMs: Math.round(performance.now() - start) });
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : 'Needle could not generate a filter.' });
  } finally { busy = false; }
};
