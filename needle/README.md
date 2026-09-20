# Needle WASM concept trial

A local cluster question assistant and pod filter for Kubus. Click **Ask your
cluster** (the sparkle in the top bar), choose a cluster, and try:

- “What is the status of the ceos pods?”
- “Give me the logs of the ceos pod”
- “What is my oldest pod?” / “What is my newest pod?”
- “What config-maps do I have?” / “How many secrets?”
- “What is using 10.96.0.10?” / “Any 443 port open?”
- “Which images are available?”
- “How much free CPU and memory on my cluster?”
- “When did the last pod die?”
- “What is the latest deployment?”
- “Summarize the last 10 events”
- “Why is pod api-crash failing in namespace production?”
- “In which namespace is my ceos pod?”
- “What is unhealthy?” or “Show current memory usage in namespace production”

Needle selects a typed read workflow. Kubus resolves actual pod identities,
reads cluster evidence and computes the answer. Pod search accepts partial
names, labels and images; ambiguous logs or diagnosis offer a choice. Node, status and namespace
conditions combine with the text filter. After selecting
one pod, “Show its logs” or “Why is it failing?” refreshes that pod's evidence. Cluster/namespace
selection changes clear this reference.

Answers identify scope, fetch time, evidence and missing permissions. Latest
Deployment means newest creation time, not latest rollout. Event summaries
include Normal and Warning records. Failed terminations combine current pod
status with a bounded in-memory journal that retains observations after deletion
while Kubus stays connected. Diagnosis shows status, UID-matched events and
bounded logs; it does not invent application root causes. See the
[harness contract, limits and local training recipe](finetune/exploration.md).

Port answers describe declarations, not tested reachability. Image answers
separate pod references from node caches. Capacity answers distinguish measured
usage from configured requests, and preserve missing data as unavailable.
ConfigMap/Secret inventories return metadata only.

A named namespace overrides the UI selection. Pod location searches cover all
namespaces by default; other questions use the selected namespaces unless the
question explicitly says “all namespaces”. New workflows cap lists at 10,000
objects total and 40 list requests. Old inventory reports retain their
10,000-object per namespace/resource cap. Neither silently truncates totals.

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
pnpm setup:needle --model .cache/needle-training/exploration/kubus-4bit.cact --question-contract harness-v3
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
and `status` fields. The question assistant uses five named workflows alongside the original
`inspect_cluster` report tool, explicitly shortlisted to at most five per turn.
Both have fixed validators. No model-generated operation can execute a cluster mutation.

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
answers, all five evidence workflows, pod follow-ups, refusals, missing
assets/metrics, untrusted log text, and cancellation.
Question tests run when `cluster-model.json` is installed. It records screenshots
under `tests/e2e/.results/needle/`. The small prompt suite is a
regression check, not a general model-quality benchmark. Native desktop
packaging and live-cluster behavior require separate verification.

References: [Needle](https://cactuscompute.com/needle),
[browser deployment](https://cactuscompute.com/blog/needle-supported-devices),
[tool design](https://cactuscompute.com/blog/designing-tools-for-needle),
[weights and engines](https://huggingface.co/Cactus-Compute/needle3).
