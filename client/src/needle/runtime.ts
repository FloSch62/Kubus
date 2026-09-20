export interface NeedleModule {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (pointer: number) => void;
  _needle_load: (pointer: number, size: bigint) => number;
  _needle_reset: () => void;
  UTF8ToString: (pointer: number) => string;
  ccall: (name: string, result: string, types: string[], args: (string | number | null)[]) => number;
}

const assetUrl = (name: string) => new URL(`${import.meta.env.BASE_URL}needle/${name}`, self.location.origin).href;
async function loadAsset(name: string): Promise<Uint8Array> {
  const response = await fetch(assetUrl(name));
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Needle assets are missing. Run pnpm setup:needle in the Kubus checkout, then restart dev or rebuild the app.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadNeedle(tools: unknown, modelName: 'needle3' | 'needle-cluster' = 'needle3', questionContract?: string) {
  const wasmBinary = await loadAsset('needle.wasm');
  const moduleUrl = assetUrl('needle.mjs');
  const { default: createNeedle } = await import(/* @vite-ignore */ moduleUrl) as {
    default: (options: { wasmBinary: Uint8Array }) => Promise<NeedleModule>;
  };
  const engine = await createNeedle({ wasmBinary });
  let metadataBytes: Uint8Array;
  try { metadataBytes = await loadAsset(modelName === 'needle3' ? 'model.json' : 'cluster-model.json'); }
  catch (error) {
    if (modelName === 'needle-cluster') throw new Error('The cluster question model is missing. Follow needle/finetune/README.md, then install it with pnpm setup:needle --model <path.cact>.');
    throw error;
  }
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as { bytes?: number; sha256?: string; confidenceCalibrated?: boolean; questionContract?: string };
  if (questionContract && metadata.questionContract !== questionContract) throw new Error('The question model uses an older tool contract. Follow needle/finetune/exploration.md to train and install the harness model.');
  const weights = await loadAsset(`${modelName}.cact`);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', weights as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (weights.length !== metadata.bytes || digest !== metadata.sha256 || typeof metadata.confidenceCalibrated !== 'boolean') {
    throw new Error('Needle model metadata does not match its weights. Run pnpm setup:needle again.');
  }
  const pointer = engine._malloc(weights.length);
  if (!pointer) throw new Error('Not enough memory to load Needle.');
  engine.HEAPU8.set(weights, pointer);
  // The engine references this allocation until the worker terminates.
  if (engine._needle_load(pointer, BigInt(weights.length)) < 0 ||
      engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, JSON.stringify(tools), null]) < 0) {
    throw new Error('Needle could not load this model. Check the model and engine versions.');
  }
  return { engine, confidenceCalibrated: metadata.confidenceCalibrated };
}

export function completeNeedle(engine: NeedleModule, prompt: string): unknown {
  engine._needle_reset();
  const capacity = 16_384;
  const output = engine._malloc(capacity);
  if (!output) throw new Error('Not enough memory to run Needle.');
  try {
    const count = engine.ccall('needle_complete', 'number', ['string', 'number', 'number', 'number'], [prompt, 256, output, capacity]);
    if (count < 0) throw new Error('Needle could not finish this request. Try a shorter question.');
    return JSON.parse(engine.UTF8ToString(output));
  } finally { engine._free(output); }
}
