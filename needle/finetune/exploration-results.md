# Exploration v3 local results — 2026-09-20

This iteration adds filtered pod queries, bounded pod logs, age rankings,
ConfigMap/Secret metadata inventories, IP/port references, image inventories and
node capacity reports. The model chooses a typed request; Kubus computes answers
from Kubernetes reads. Existing diagnosis, events, Deployment creation and
termination workflows remain part of the contract.

The adapter was trained locally on an RTX 4080 SUPER in WSL and exported as CQ4.
The original 2-bit pod-filter model stays separate. No hosted training account
or private cluster data is used. Training starts from the original checkpoint,
not the previous adapter.

## Question interpretation

| Model under the final v3 harness | Development exact | Supported development accepted correctly | Challenge exact | Supported challenge accepted correctly |
| --- | ---: | ---: | ---: | ---: |
| Previous v2 question weights | 64/120 | 48/92 | 22/50 | 17/36 |
| Exploration v3 question weights | **89/120** | **77/92** | **39/50** | **34/36** |

Both models have zero accepted wrong interpretations in these final sets. The
application refuses all 28 unsupported development and all 14 unsupported
challenge questions. This establishes behavior on these cases, not universal
correctness. The new model's remaining 15 supported development and two supported
challenge misses are refusals.

The new weights correctly interpret all ten original user questions. The
14-question smoke suite passes 13 cases, including combined namespace/node/name/
age filters, previous logs and restart ordering. `Where is 10.96.0.10?` still
refuses; `What is using 10.96.0.10?` works in the smoke, browser and live checks.

The comparison uses the same v3 schemas, candidate selection, validation and
single optional retry for both models. Each inference pass allows 256 output
tokens. Strict exactness requires the entire extracted call to match. Accepted
correct reads also count equivalent unfiltered pod-list/restart tools and pod
usage rankings with usage totals; those
equivalences are recorded separately. Fine-tuned confidence is not calibrated
and does not override validation.

The 120-question development set has 92 supported and 28 unsupported questions.
The 50-question challenge has 36 supported and 14 unsupported questions. Their
prompt strings are absent from training. The challenge was authored before
inspecting the new weights, but these small synthetic suites can inform harness
iteration and are not blind production benchmarks. The 14-question smoke set
includes the user's exact ten examples and four regressions; it overlaps training
families and is an acceptance check, not a held-out accuracy measurement.

Measured failures informed two final harness refinements. A rejected general
report can retry the unchanged question with one unambiguous task tool, which
fixes `Which pods restart most in namespace production?`. The guard also rejects
resource-type words used as pod names, including a retry that otherwise changed
`Find nodes in namespace edge-test` into a pod search. Held calls, grounding/
negation failures and ambiguous task choices never retry. The final comparison
reruns both models with these same checks; it uses seven retries on development
and two on challenge for the new weights. No additional training followed the
evaluations.

Known misses include the challenge phrases `Show failed pods on node rack-worker
in namespace rack-c` and `How many secrets in all namespaces?`, where the model
drops or changes a scope condition. Several development service/PVC queries lose
an explicit name, and some generic phrases such as “machines”, “pod inventory”
and “claims bound to” select the wrong report. The validator refuses these.
Filtered pod and image queries can still require rephrasing for unfamiliar
wordings or names. Use the example phrasings or open the resource directly;
this remains a local trial, not an unrestricted Kubernetes question engine.

## Execution and UI evidence

- All twelve real-WASM browser tests pass, including the user's ten questions,
  combined pod filters, previous-log container selection, UID checks, pod
  follow-ups, the five earlier workflows and the original 2-bit pod filter.
  They check local-only requests, GET-only cluster access, no full Secret reads,
  inert log text, cancellation, denied inventories and unavailable metrics.
  Both representative Vite development-worker checks also pass.
- Typecheck, lint and the workspace build pass. The final client build contains
  the same question-model hash as the evaluated archive and advertises
  `questionContract: harness-v3`.
- 622 server/shared tests and 229 focused client tests pass. These cover
  pagination, missing data, exact labels, combined scope, usage ranking,
  metadata projection, request accounting, image sources and network references,
  as well as the earlier journal and log safeguards.
- A read-only live run used the new WASM model and real Kubus route handlers
  against `kind-c9s-pr343`. All ten original questions completed: two cEOS pods,
  25 current pods for age ranking, 70 ConfigMaps, 14 Secrets, the Service reference
  for `10.96.0.10`, five port-443 references, 14 workload image references and
  usage samples for all three nodes. Selecting a matching pod returned an
  8,848-byte bounded log excerpt. These are observations from this run, not
  permanent facts about the cluster. No cluster resources were changed.
- The capacity screenshot was inspected. Native Electron packaging was not
  tested in this iteration.

Ports are declarations, not reachability tests; image caches are not registry
catalogs; capacity estimates are not scheduling guarantees. Metadata inventories
exclude Secret values and ConfigMap contents. See [the contract](exploration.md)
for these distinctions, read limits and supported filter combinations.

## Training and provenance

The recipe contains 5,128 synthetic examples, including 352 refusals, split into
4,616 training and 512 validation examples. Training uses 10 epochs, batch 4,
learning rate 0.0001, rank-16 LoRA, alpha 32, seed 20260921 and sequence length
640. The longest rendered example is 632 tokens. Validation loss is a training
diagnostic, not an accuracy claim. Training took about 43 minutes; final validation
loss was 0.0007. Export merges the adapter in float32 before CQ4 quantization.

The environment uses Python 3.12.10, JAX/JAXlib 0.11.2, Optax 0.2.8,
safetensors 0.8.0 and sentencepiece 0.2.2. The upstream checkout is
`fc5bae0f9b6138828fe7589f6b531fb9a26968de`; model/runtime assets are pinned to
Hugging Face revision `b274efcb211a9eef48c9a88da4b43bd569696a39`.

| Artifact | SHA-256 |
| --- | --- |
| Adapter | `0c14962f8dbf4f7adf933f3a8b8fe78f3d54f640b5bb26dd24b5db3c82f71be0` |
| Installed question weights | `2713d37ba75fcd1938e4254e63d7f0f0598985b7c89ef1455d664da5052396f2` |
| Original checkpoint | `c234c70dccc7a9115e7c41ac2e41d3655fea3b85c245dd898b46179fb90c6c0c` |
| Original 2-bit archive | `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38` |
| Exporter | `839161986b2739284eedf8c20d03aa01198df0fc6881c7e11e9cf1f529446a51` |
| Training JSONL | `1d483230091353af1462e980544607671c087ad2c0fc4b9d20dfbd49a69db966` |
| Development JSONL | `2d4360c53e99dfb1eca9165bd54588d3129ecb2c817f1369ebc5372135a1d591` |
| Challenge JSONL | `f3eb46e78954b59814ed1677c7169b557020f7216d88c434f47cacadff390955` |
| WASM engine | `77c6a38cacb8efbeebfd5202082ba9a0850a7c3066db40d4d0e80509cd137d9b` |
| Final combined validators | `789255c465337ab37ca098c1e2fb925495382b3a47e973f8fbc9f8d77edb1a43` |

The exported model is 63,474,900 bytes. WASM linear memory measured 183,042,048
bytes (about 174.6 MiB); this is not total browser/process RAM. Final development
inference had a diagnostic median of 496 ms and p95 of 1,151 ms, including retries.
Evaluation and browser checks shared the host, so these are not isolated latency
benchmarks. Fine-tuned confidence and the engine's reported peak-RAM field are
not used to establish correctness or memory consumption.

Follow [the v3 recipe](exploration.md) to reproduce. Detailed per-attempt model
responses, live-check output, training logs, generated datasets, adapters and
model binaries stay local under the git-ignored `.cache/needle-training/exploration/`.
Model assets are installed into the ignored `client/public/needle/` directory.
They are not committed or published.
