import { POD_FILTER_TOOLS, readPodFilterSuggestion, type NeedleWorkerResponse } from './pod-filter.js';

interface NeedleModule {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (pointer: number) => void;
  _needle_load: (pointer: number, size: bigint) => number;
  _needle_reset: () => void;
  UTF8ToString: (pointer: number) => string;
  ccall: (name: string, result: string, types: string[], args: (string | number | null)[]) => number;
}

let engine: NeedleModule | undefined;
let busy = false;
const send = (message: NeedleWorkerResponse) => self.postMessage(message);
const assetUrl = (name: string) => new URL(`${import.meta.env.BASE_URL}needle/${name}`, self.location.origin).href;

async function loadAsset(name: string): Promise<Uint8Array> {
  const response = await fetch(assetUrl(name));
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Needle assets are missing. Run pnpm setup:needle in the Kubus checkout, then restart dev or rebuild the app.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadEngine(): Promise<NeedleModule> {
  send({ type: 'status', status: 'loading' });
  // Fetch the binary first so an unprepared checkout produces an actionable
  // error instead of a confusing dynamic-import or WebAssembly compile error.
  const wasmBinary = await loadAsset('needle.wasm');
  const moduleUrl = assetUrl('needle.mjs');
  const { default: createNeedle } = await import(/* @vite-ignore */ moduleUrl) as {
    default: (options: { wasmBinary: Uint8Array }) => Promise<NeedleModule>;
  };
  const model = await createNeedle({ wasmBinary });
  const weights = await loadAsset('needle3.cact');
  const pointer = model._malloc(weights.length);
  if (!pointer) throw new Error('Not enough memory to load Needle.');
  model.HEAPU8.set(weights, pointer);
  // needle_load reads weights in place; keep this allocation alive until the
  // worker is terminated. Closing the dialog releases the entire WASM heap.
  if (model._needle_load(pointer, BigInt(weights.length)) < 0) throw new Error('Needle could not load its model. Run pnpm setup:needle again.');
  if (model.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, JSON.stringify(POD_FILTER_TOOLS), null]) < 0) {
    throw new Error('Needle could not initialize the pod filter.');
  }
  return model;
}

self.onmessage = async (event: MessageEvent<{ prompt: string }>) => {
  if (busy) return;
  busy = true;
  try {
    const prompt = event.data.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 300) throw new Error('Enter a request of 1–300 characters.');
    engine ??= await loadEngine();
    send({ type: 'status', status: 'thinking' });
    engine._needle_reset(); // Every request is independent of earlier prompts.
    const capacity = 16_384;
    const output = engine._malloc(capacity);
    if (!output) throw new Error('Not enough memory to create a filter.');
    const start = performance.now();
    try {
      const count = engine.ccall('needle_complete', 'number', ['string', 'number', 'number', 'number'], [prompt, 256, output, capacity]);
      if (count < 0) throw new Error('Needle could not finish this request. Try a shorter description.');
      const result = readPodFilterSuggestion(JSON.parse(engine.UTF8ToString(output)), prompt);
      send({ type: 'result', result, elapsedMs: Math.round(performance.now() - start) });
    } finally {
      engine._free(output);
    }
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : 'Needle could not generate a filter.' });
  } finally {
    busy = false;
  }
};
