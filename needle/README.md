# Needle WASM concept trial

A local cluster question assistant and pod filter for Kubus. Click **Ask your
cluster** (the sparkle in the top bar) to ask about health, resource inventories,
warnings, restart counts, CPU/memory usage or container images. Pick the cluster
in the dialog; a namespace in the question overrides the current namespace
selection. For example:

- “What is unhealthy?”
- “Show pod restart counts in namespace production”
- “Show current memory usage in namespace production”
- “Show warning events for pod api in namespace production”
- “What Kubernetes versions do my nodes run?”
- “Show persistent volume claims”

Needle selects a structured read request. Kubus fetches the selected cluster's
data and computes the answer, including counts, status tables, warnings and
links to its resource views. The answer identifies its interpreted topic,
scope and fetch time. Missing data and permission failures are visible; tables
show up to 20 rows and counts follow pagination, with a 10,000-object limit per
namespace/resource list. Each question is independent. This is a fixed catalog
of current observations, not general chat, historical analysis or unrestricted
root-cause diagnosis. Cluster questions require the separately trained model;
use the [local fine-tuning workflow](finetune/README.md) for the broader trial.

For the pod filter, open **Pods**, click the sparkle beside the
search input, and describe the pods you want. For example, **“Show crashing pods
in production”** produces `/ns:production status:crash`. The dialog shows the
filter and matching pod count; **Apply filter** replaces the table search.
The usual cluster and namespace selections still apply. Namespace matching
uses Kubus's existing substring semantics, which the preview labels explicitly.

## Try it

```sh
pnpm setup:needle
pnpm dev
```

For the desktop app, run `pnpm electron` after setup. Vite copies the assets
into `client/dist`, which the desktop app serves locally. No Python, native
Needle library, API key, GPU, or additional npm dependency is required.
`pnpm setup:needle` installs/restores the official 2-bit base. To install the
locally trained 4-bit question model alongside it, run:

```sh
pnpm setup:needle --model .cache/needle-training/cluster/kubus-4bit.cact
```

Pod filters keep using the original 2-bit model. Repeating the default setup
command preserves the question model. Each dialog loads only its own model.

The large generated assets are ignored by Git. Fresh checkouts need the setup
command; without them, the dialog explains setup and regular filtering works.
There is no automatic model download at app startup or from the dialog.

## Why this use case

Needle is intended for structured extraction/tool calls, rather than chat or
Kubernetes troubleshooting explanations. Converting a request into a small,
reviewable filter fits its strengths and Kubus already implements the filter
semantics. The filter exposes one `filter_pods` schema with optional `namespace`
and `status` fields. The question assistant separately uses `inspect_cluster`
with a topic, optional namespace and optional resource name. Both have fixed
validators. No model-generated operation can execute a cluster mutation.

Broader schemas were tested first. The base model confused pod names with
namespaces and “more than” with “at least” for restart counts, even at high
reported confidence. Those features are deliberately outside this trial.
The short request “Show unhealthy pods” also invented namespace `pods` at
0.9974 confidence. Namespace values now require explicit context in the request
(“in production”, “namespace production”, or “production namespace”); this case
is refused instead of silently corrected. “Show unhealthy pods in namespace
production” passed. This is a material base-model limitation, not a production
accuracy claim.
Negation, OR expressions, other languages and arbitrary troubleshooting
requests are not supported. The model can still omit a condition; the preview
is the final check, and ordinary smart-filter editing remains available.

## Runtime and assets

- Needle 3, full 20-layer model, upstream revision
  `b274efcb211a9eef48c9a88da4b43bd569696a39`.
- Base weights: 35,335,380 bytes; WASM: 688,521 bytes; JS glue: 62,502 bytes.
  Roughly 36 MB on disk, with higher runtime memory use.
- A full local 4-bit export is 63,474,900 bytes, about 99.6 MB on disk with the
  base assets. `model.json` and `cluster-model.json` identify the respective
  artifacts by size and SHA-256 and mark their confidence calibration.
- `setup.mjs` downloads pinned assets and verifies SHA-256. The only change to
  upstream JS is an appended ES module export. Apache-2.0 license and attribution
  are in `client/public/needle/` and included in built apps.
- A lazy module worker loads same-origin assets when Generate is clicked.
  Only the typed request and fixed schema enter the model. Resource objects,
  kubeconfig, secrets and logs are never supplied. The matching row count is
  computed separately by Kubus.
- Every request resets model conversation state. Cancellation, dialog close
  and a 60-second timeout terminate the worker, releasing its WASM memory.
- Responses must be a single allowed call with validated arguments. Ungrounded
  calls and detected negations are refused. Pod filtering also refuses held
  calls and requires scores of at least 0.4; scores below 0.7 are called out.
  The question classifier follows Needle's structured extraction behavior:
  it can read a held call only with explicit clean grounding/negation results.
  Fine-tuning does not calibrate the confidence head, so question-model scores
  are ignored. Pod filters always require Apply; cluster questions automatically
  execute only fixed read operations.
- This pinned WASM binary has no networking imports. Browser tests also check
  that inference makes no requests outside the app origin. No native runtime
  or its telemetry is used.

## Validate

```sh
pnpm typecheck
pnpm lint
pnpm --filter @kubus/tests exec vitest run --project client tests/unit/client/needle-cluster.test.ts tests/unit/client/needle-pod-filter.test.ts tests/unit/client/smart-filter.test.ts tests/unit/client/resource-table.test.tsx
pnpm test:needle
# Also check Vite's development worker path:
KUBUS_NEEDLE_DEV=1 pnpm test:needle --grep 'real tuned WASM|generates, previews'
```

`test:needle` builds the client and drives the actual Kubus Pods screen in
Chromium with real WASM inference. Kubernetes responses are fixtures, so no
cluster is required or changed. It covers filter preview/apply, scoped cluster
answers, independent prompts, refusals, missing assets/metrics, and cancellation.
Question tests run when `cluster-model.json` is installed. It records screenshots
under `tests/e2e/.results/needle/`. The small prompt suite is a
regression check, not a general model-quality benchmark. Native desktop
packaging and live-cluster behavior require separate verification.

References: [Needle](https://cactuscompute.com/needle),
[browser deployment](https://cactuscompute.com/blog/needle-supported-devices),
[tool design](https://cactuscompute.com/blog/designing-tools-for-needle),
[weights and engines](https://huggingface.co/Cactus-Compute/needle3).
