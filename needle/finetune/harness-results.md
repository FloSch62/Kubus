# Harness v2 local results — 2026-09-20

Historical v2 results. The current application uses [exploration v3](exploration.md).

The new adapter was trained locally on the RTX 4080 SUPER in WSL, exported to
4-bit and installed as `needle-cluster.cact` with the `harness-v2` contract.
The original 2-bit pod-filter model is unchanged. No Cactus account, hosted
training service or private cluster data was used for training.

## Question interpretation

Both models below use the **same final harness**, pinned WASM engine, tool
shortlists, validators and bounded retry. “Previous” is the original Kubus
report adapter, not an untuned base model. Each model gets at most two inference
passes, each with a 256-token generation budget. Fine-tuned confidence scores
are ignored. Exact means the complete extracted call matches the expected
tool and all arguments; this includes clean held-call extraction.

| Model | Development exact | Supported development | Challenge exact | Supported challenge |
| --- | ---: | ---: | ---: | ---: |
| Previous Kubus 4-bit | 75/117 | 55/86 | 26/40 | 23/30 |
| Harness v2 4-bit | **97/117** | **72/86** | **35/40** | **30/30** |

Application validation is a separate measurement. It can refuse a wrong model
interpretation; therefore raw call accuracy and correct application behavior
are different quantities.

| Model | Development wrong calls accepted | Unsupported development refused | Challenge wrong calls accepted | Unsupported challenge refused |
| --- | ---: | ---: | ---: | ---: |
| Previous Kubus 4-bit | 16 | 30/31 | 1 | 10/10 |
| Harness v2 4-bit | **4** | **31/31** | **0** | **10/10** |

The development set includes the earlier regression corpus and informed harness
iteration. The separate challenge set was authored before inspecting the new
weights. No further model training followed its evaluation, but the harness was
subsequently refined and rechecked. These are small synthetic suites, not blind
production accuracy measurements.

One development failure directly improved the harness: `Summarize the last 10
events` initially returned no call. Retrying the unchanged question with only
the one candidate task tool produced the correct count. The final harness uses
this bounded retry for empty classifications with one task candidate. It used
7 retries in the development suite and 4 in the challenge suite. It does not
retry held calls or explicit grounding/negation failures. Some unsupported
requests produce a call on retry; the final validator still refuses them.

Known limitations remain in the legacy enum-based report tool. For example:

- `Which pods restart most in namespace production?` still becomes a generic
  pod list at inference; the application refuses it. `Show pod restart counts
  in namespace production` works in the browser regression.
- Some service/PVC questions drop an explicit name and are refused.
- Four development prompts still yield accepted wrong interpretations,
  including a node/workload count becoming a node report, “machines” becoming
  deployments, storage claims becoming health, and a PVC inventory acquiring
  the spurious resource name `pvc`. The interpreted topic and scope remain
  visible; this trial must not be described as perfect or universally reliable.

## Execution and UI evidence

- All eight real-WASM browser regressions pass, including the five requested
  workflows, candidate selection, a pod follow-up, local-only requests, GET-only
  cluster access, inert log text, cancellation, unavailable metrics and the
  original pod filter.
- Both representative Vite development-worker checks pass. Build, typecheck and
  lint pass, along with 618 server/shared and 145 focused client unit tests.
- Server/shared tests cover journal retention, deletion, deduplication, expiry,
  current permission checks, bounded logs and UID replacement. Client fixtures
  cover cross-namespace collisions, image-only matches, event series, successful
  Jobs, recovered pods, missing permissions and incomplete pagination.
- A read-only live run used the actual new WASM model and Kubus route handlers
  against `kind-c9s-pr343`. All five questions completed. Pod lookup found two
  cEOS matches, deployment and event rankings used live objects, termination
  history merged current observations, and diagnosis distinguished a running
  pod's historical failures from an active failure. A direct bounded log read
  returned HTTP 200 with 2,989 bytes. No cluster resources were changed.
- Browser screenshots were inspected. Native Electron packaging was not tested
  in this iteration.

The journal is in memory and covers observations while Kubus is connected,
up to 10,000 records / 24 hours after observation. Disconnecting the cluster or
restarting the server clears it. Event retention and container last-state
limitations remain visible in answers. This is not a 24/7 historical collector.

## Artifacts and reproduction

Training used 3,918 synthetic examples, with 3,527 training / 391 validation,
10 epochs, batch 4, learning rate 0.0001, rank-16 LoRA, alpha 32 and seed
20260920. The longest example was 422 tokens; training sequence length was 512.
Training took about 27 minutes here. Final validation loss was 0.0005, a training
diagnostic rather than an accuracy claim. Export merges in float32 before CQ4.

| Artifact | SHA-256 |
| --- | --- |
| Adapter | `de09d5d60a3024c7b8918ac66818acd17d8af47c98a22cf8a1dbe68515126671` |
| Installed question weights | `35f3b03488a526be375942817e8e6bec9a9e0d015ff8f80e83f93fc6ea4d0b07` |
| Training JSONL | `f22bc89a49d0653c0f691f9850ed9a3884cfb19442100dfa9774e95cf57bb28d` |
| Development JSONL | `7ceec25d2862ced4b658457729c4a6d657a694d987cf72e4829e1eb19450002e` |
| Challenge JSONL | `5209239fdf10b8a0d67e4e6b932c7995304e1bc78e4b2d37e9355f5154891934` |

The exported model is 63,474,900 bytes. WASM linear memory was 183,042,048 bytes
(about 174.6 MiB); this is not total browser/process RAM. Final development
inference had a diagnostic median of 441 ms and p95 of 1,128 ms including retries.
These runs shared the host with other verification work, so they are not an
isolated latency benchmark.

Follow [the harness recipe](harness.md) to reproduce. Detailed JSON traces,
per-attempt model responses, live-check output and logs are local under the
git-ignored `.cache/needle-training/harness/`. First-pass reports are retained
there separately. Model binaries and adapters are not committed or published.
