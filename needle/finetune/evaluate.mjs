// Runs the same WASM binary, schema, 256-token budget and reset as the UI.
// Node timing is diagnostic; browser/Electron latency requires separate checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { POD_FILTER_TOOLS, readPodFilterSuggestion } from '../../client/src/needle/pod-filter.ts';
import { CLUSTER_TOOLS, readClusterQuestion } from '../../client/src/needle/cluster-query.ts';
import { readHarnessQuestion, retryToolsForQuestion, toolsForQuestion } from '../../client/src/needle/cluster-query.ts';

const { values } = parseArgs({ options: {
  weights: { type: 'string', default: 'client/public/needle/needle3.cact' },
  data: { type: 'string', default: '.cache/needle-training/data/test.jsonl' },
  output: { type: 'string', default: '.cache/needle-training/baseline.json' },
  cluster: { type: 'boolean', default: false },
  uncalibrated: { type: 'boolean', default: false },
  harness: { type: 'boolean', default: false },
} });
const weights = await readFile(values.weights);
const data = await readFile(values.data, 'utf8');
const examples = data.trim().split('\n').map((line) => JSON.parse(line));
const tools = values.cluster ? CLUSTER_TOOLS : POD_FILTER_TOOLS;
const glue = await readFile(new URL('../../client/public/needle/needle.mjs', import.meta.url), 'utf8');
const wasm = await readFile(new URL('../../client/public/needle/needle.wasm', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'kubus-needle-eval-'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  // Upstream glue uses require/__dirname under Node; its browser ESM wrapper
  // cannot be imported directly here. Keep the conversion outside app assets.
  const cjs = join(temporary, 'needle.cjs');
  assert(glue.endsWith('\nexport default createNeedle;\n'));
  await writeFile(cjs, glue.replace(/\nexport default createNeedle;\n$/, '\nmodule.exports = createNeedle;\n'));
  const createNeedle = createRequire(import.meta.url)(cjs);
  const engine = await createNeedle({ wasmBinary: wasm });
  const pointer = engine._malloc(weights.length);
  assert(pointer);
  engine.HEAPU8.set(weights, pointer);
  assert(engine._needle_load(pointer, BigInt(weights.length)) >= 0, 'Model failed to load');
  assert(engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, JSON.stringify(tools), null]) >= 0);
  const capacity = 16_384;
  const output = engine._malloc(capacity);
  const rows = [];
  let schema = JSON.stringify(tools);
  for (const [index, row] of examples.entries()) {
    const selected = values.harness ? toolsForQuestion(row.query) : tools;
    assert.deepEqual(row.tools, selected, 'Dataset schema differs from Kubus');
    if (JSON.stringify(selected) !== schema) {
      schema = JSON.stringify(selected);
      assert(engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, schema, null]) >= 0);
    }
    const start = performance.now();
    const complete = () => {
      engine._needle_reset();
      const code = engine.ccall('needle_complete', 'number', ['string', 'number', 'number', 'number'], [row.query, 256, output, capacity]);
      return code >= 0 ? JSON.parse(engine.UTF8ToString(output)) : { error: `needle_complete returned ${code}` };
    };
    let response = complete();
    const attempts = [response];
    const retry = values.harness ? retryToolsForQuestion(response, row.query) : [];
    if (retry.length) {
      schema = JSON.stringify(retry);
      assert(engine.ccall('needle_init', 'number', ['string', 'string', 'string'], [null, schema, null]) >= 0);
      response = complete();
      attempts.push(response);
    }
    const elapsedMs = Math.round(performance.now() - start);
    const rawExact = response.success === true && isDeepStrictEqual(response.function_calls, row.answers);
    const calls = (values.cluster || values.harness) && response.function_calls?.length === 0 ? response.suppressed_calls ?? [] : response.function_calls;
    const exact = response.success === true && isDeepStrictEqual(calls, row.answers);
    let accepted = false;
    let filter = null;
    let refusal = null;
    try {
      filter = values.harness ? readHarnessQuestion(response, row.query) : values.cluster ? readClusterQuestion(response, row.query) : readPodFilterSuggestion(response, row.query, !values.uncalibrated).filter;
      accepted = true;
    } catch (error) { refusal = error.message; }
    rows.push({ query: row.query, expected: row.answers, exact, rawExact, accepted, filter, refusal, elapsedMs, response, attempts });
    if ((index + 1) % 10 === 0) console.log(`${index + 1}/${examples.length}: ${rows.filter((item) => item.exact).length} exact`);
  }
  engine._free(output);
  const positives = rows.filter((row) => row.expected.length);
  const negatives = rows.filter((row) => !row.expected.length);
  const latencies = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const report = {
    model: resolve(values.weights), modelBytes: weights.length, modelSha256: sha256(weights),
    dataSha256: sha256(data), wasmSha256: sha256(wasm), tokenBudget: 256,
    validatorSha256: sha256(await readFile(new URL(values.harness || values.cluster ? '../../client/src/needle/cluster-query.ts' : '../../client/src/needle/pod-filter.ts', import.meta.url))),
    total: rows.length, exact: rows.filter((row) => row.exact).length,
    maxPasses: values.harness ? 2 : 1, retries: rows.filter((row) => row.attempts.length > 1).length,
    rawExact: rows.filter((row) => row.rawExact).length,
    positiveTotal: positives.length, positiveExact: positives.filter((row) => row.exact).length,
    negativeTotal: negatives.length, negativeExact: negatives.filter((row) => row.exact).length,
    acceptedCorrect: positives.filter((row) => row.exact && row.accepted).length,
    acceptedWrong: rows.filter((row) => !row.exact && row.accepted).length,
    negativeRefusedByApp: negatives.filter((row) => !row.accepted).length,
    wasmMemoryBytes: engine.HEAPU8.byteLength,
    medianMs: latencies[Math.floor(latencies.length / 2)], p95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
    rows,
  };
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
