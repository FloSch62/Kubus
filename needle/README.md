# Needle WASM concept trial

An offline pod filter for Kubus: open **Pods**, click the sparkle beside the
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
The large generated assets are ignored by Git. Fresh checkouts need the setup
command; without them, the dialog explains setup and regular filtering works.
There is no automatic model download at app startup or from the dialog.

## Why this use case

Needle is intended for structured extraction/tool calls, rather than chat or
Kubernetes troubleshooting explanations. Converting a request into a small,
reviewable filter fits its strengths and Kubus already implements the filter
semantics. The trial exposes one `filter_pods` schema with optional `namespace`
and `status` fields. It has no Kubernetes action tools.

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
- Weights: 35,335,380 bytes; WASM: 688,521 bytes; JS glue: 62,502 bytes.
  Roughly 36 MB on disk, with higher runtime memory use.
- `setup.mjs` downloads pinned assets and verifies SHA-256. The only change to
  upstream JS is an appended ES module export. Apache-2.0 license and attribution
  are in `client/public/needle/` and included in built apps.
- A lazy module worker loads same-origin assets when Generate is clicked.
  Only the typed request and fixed schema enter the model. Resource objects,
  kubeconfig, secrets and logs are never supplied. The matching row count is
  computed separately by Kubus.
- Every request resets model conversation state. Cancellation, dialog close
  and a 60-second timeout terminate the worker, releasing its WASM memory.
- Responses must be a single allowed call with validated arguments and a
  finite confidence of at least 0.4. Suppressed or ungrounded calls are refused.
  Confidence below 0.7 is called out in the preview; even high scores require
  the user to apply the filter. Scores are not an accuracy guarantee.
- This pinned WASM binary has no networking imports. Browser tests also check
  that inference makes no requests outside the app origin. No native runtime
  or its telemetry is used.

## Validate

```sh
pnpm typecheck
pnpm lint
pnpm --filter @kubus/tests exec vitest run --project client tests/unit/client/needle-pod-filter.test.ts tests/unit/client/smart-filter.test.ts tests/unit/client/resource-table.test.tsx
pnpm test:needle
# Also check Vite's development worker path:
KUBUS_NEEDLE_DEV=1 pnpm test:needle --grep 'generates, previews'
```

`test:needle` builds the client and drives the actual Kubus Pods screen in
Chromium with real WASM inference. Kubernetes responses are fixtures, so no
cluster is required or changed. It covers the preview/apply flow, independent
prompts, refusals, missing assets, and cancellation/retry. It records a preview
screenshot under `tests/e2e/.results/needle/`. The small prompt suite is a
regression check, not a general model-quality benchmark. Native desktop
packaging and live-cluster behavior require separate verification.

References: [Needle](https://cactuscompute.com/needle),
[browser deployment](https://cactuscompute.com/blog/needle-supported-devices),
[tool design](https://cactuscompute.com/blog/designing-tools-for-needle),
[weights and engines](https://huggingface.co/Cactus-Compute/needle3).
