import type { ClusterWorkerResponse } from './cluster-query.js';
import { readHarnessQuestion, retryToolsForQuestion, toolsForQuestion } from './cluster-query.js';
import { completeNeedle, loadNeedle } from './runtime.js';

let runtime: Awaited<ReturnType<typeof loadNeedle>> | undefined;
let busy = false;
let schema = '';
const send = (message: ClusterWorkerResponse) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<{ prompt: string }>) => {
  if (busy) return;
  busy = true;
  try {
    const prompt = event.data.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 300) throw new Error('Enter a question of 1–300 characters.');
    if (!runtime) {
      send({ type: 'status', status: 'loading' });
      runtime = await loadNeedle(toolsForQuestion(prompt), 'needle-cluster', 'harness-v2');
      schema = JSON.stringify(toolsForQuestion(prompt));
    }
    send({ type: 'status', status: 'thinking' });
    const nextSchema = JSON.stringify(toolsForQuestion(prompt));
    if (schema !== nextSchema) {
      if (runtime.engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, nextSchema, null]) < 0) throw new Error('Needle could not select the question tools.');
      schema = nextSchema;
    }
    let response = completeNeedle(runtime.engine, prompt);
    const retry = retryToolsForQuestion(response, prompt);
    if (retry.length) {
      schema = JSON.stringify(retry);
      if (runtime.engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, schema, null]) < 0) throw new Error('Needle could not narrow the question tools.');
      response = completeNeedle(runtime.engine, prompt);
    }
    send({ type: 'question', question: readHarnessQuestion(response, prompt) });
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : 'Needle could not interpret the question.' });
  } finally { busy = false; }
};
