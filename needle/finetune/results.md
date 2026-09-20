# Local cluster-question trial — 2026-09-20

These are historical results for the original report-only contract; see the
[harness v2 recipe](harness.md) for the current assistant.
The local LoRA run completed on an RTX 4080 SUPER inside WSL. Its exported
4-bit model was installed as `client/public/needle/needle-cluster.cact`. The
original 2-bit pod-filter model remains separate. No account, hosted training,
private cluster data or external text-generation service was used.

## What was measured

All three models used the actual pinned WASM engine, the same compact
`inspect_cluster` schema, a reset before each question and a 256-token generation
budget. Exact means the complete topic/name/namespace record matched, or an
unsupported question produced no record. Following Needle's extraction path,
this includes records in `suppressed_calls`; application acceptance additionally
requires clean validation and Kubus's argument checks. Confidence scores from
the tuned head are not used.

The development set contains 75 supported and 25 unsupported questions. It was
inspected between iterations and informed vocabulary changes. The challenge
set contains 26 supported and 14 unsupported questions, written after the final
training run started; no further model training followed its evaluation.
Both sets are small and synthetic. Their percentages are not production accuracy.

| Model | Development exact / 100 | Supported exact / 75 | Challenge exact / 40 | Supported exact / 26 |
| --- | ---: | ---: | ---: | ---: |
| Original 2-bit | 29 | 13 | 12 | 2 |
| Untuned 4-bit control | 37 | 19 | 14 | 3 |
| Local 4-bit LoRA | **78** | **60** | **26** | **15** |

The improvement is useful, but question interpretation remains fallible. For
example, “Which pods restart most?” is classified as a generic pod inventory.
The UI instead offers “Show pod restart counts”; the former wording is now
refused by a validation check rather than presented as the wrong report.
Unfamiliar names can also be dropped. Explicit `in namespace …`, `for pod …`
and common named-resource forms are checked for omission; this is not a complete
natural-language scope parser.

After inspecting model outputs, the final application validator was reapplied
to the saved responses. This changes acceptance, **not** model exact-match
scores. The following application checks therefore are not blind measurements:

| Model | Accepted wrong, development / 100 | Unsupported refused / 25 | Accepted wrong, challenge / 40 | Unsupported refused / 14 |
| --- | ---: | ---: | ---: | ---: |
| Original 2-bit | 10 | 20 | 5 | 11 |
| Untuned 4-bit control | 10 | 22 | 1 | 14 |
| Local 4-bit LoRA | 12 | 21 | 4 | 12 |

The trained model answers many more supported questions, and also accepts some
wrong interpretations. A vague health question can become an overview; an
unsupported prediction can become a node inventory. All executed requests are
fixed authenticated reads, and answers display the interpreted topic, cluster,
namespace and resource name. The model never receives cluster objects or writes
answer facts. Kubus calculates tables and totals from API responses. It cannot
provide unrestricted root-cause reasoning, historical analysis, follow-up chat,
shell execution or cluster changes.

## Training and artifacts

- 2,298 examples, including 310 refusals; seeded split of 2,069 training and
  229 validation examples. Maximum example length: 237 tokens; training length: 256.
  Archive maximum sequence length: 8,192; sliding KV cache: 256 entries.
- Full 20-layer checkpoint, rank-16 LoRA, alpha 32, batch 8, 10 epochs,
  learning rate 0.0001, seed 20260921. Final validation loss: 0.0026.
  Validation loss is a training diagnostic, not question accuracy.
- Upstream source: `fc5bae0f9b6138828fe7589f6b531fb9a26968de`.
  Model/tokenizer revision: `b274efcb211a9eef48c9a88da4b43bd569696a39`.
- GPU memory observed during training: about 8.6 GiB device total, including
  about 2 GiB already used by the desktop. This is not a minimum requirement.
- Tuned export: 63,474,900 bytes. Measured WASM linear memory: 183,042,048 bytes
  (174.6 MiB), versus 97.3 MiB for the original 2-bit model. Browser overhead
  and transient loading allocations are additional; total browser RSS was not
  measured for this model. Closing/cancelling the dialog releases its worker.
- Node/WASM warm inference on the development set: median 437 ms, p95 641 ms.
  These are diagnostic timings, not an isolated browser/Electron benchmark.

| Artifact | SHA-256 |
| --- | --- |
| Tuned `.cact` | `4956e5e32f19dd8c15561240ef3725b58f0588121b4ddd66a7f7e7506fb4e8e1` |
| LoRA adapter | `ff629e0089f197dd8a20877b3a788576cbf8e73f4297c16c6214170b9806674d` |
| Training JSONL | `1d17c0fa7548b51552f984070118e04464512044eb5831395846899193cf1519` |
| Development JSONL | `4431d710e708b2db8a07e038b72111a7582f95b1f3c1182976519028d8e4ef7a` |
| Challenge JSONL | `6ccd993fea9a7a53eba4ba7e295287d46b89e9900b6cec95b7aa62648da13a06` |
| WASM engine | `77c6a38cacb8efbeebfd5202082ba9a0850a7c3066db40d4d0e80509cd137d9b` |

Generated data, adapters, full model responses, training/export logs and the
Python environment are under `.cache/needle-training/`. Final artifacts and
reports are in its `cluster/` directory; `cluster-v1/` preserves the earlier
broader pilot. The local cache and installed weights are ignored by Git.
See [the recipe](README.md) to reproduce the run or install the exported model.

## Application validation

- Typecheck, lint, full workspace build and 114 focused unit tests passed.
- Seven Chromium tests passed with actual WASM and fixture Kubernetes APIs:
  scoped restart totals, memory samples, warning events, images, unsupported
  requests, unavailable metrics, cancellation, and the original pod-filter flows.
- Two representative browser tests also exercise Vite's development worker path.
- These checks do not validate a real cluster connection or native Electron
  packaging. Model classification was exercised separately from deterministic
  API pagination, namespace scoping, partial permissions and missing-data tests.

References: [pinned local trainer](https://github.com/cactus-compute/needle/blob/fc5bae0f9b6138828fe7589f6b531fb9a26968de/needle/model/finetune.py),
[pinned extraction API](https://github.com/cactus-compute/needle/blob/fc5bae0f9b6138828fe7589f6b531fb9a26968de/needle/__init__.py).
