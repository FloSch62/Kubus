# Kubus question harness v2

Needle chooses a small, typed read workflow. Kubus resolves resource identities,
reads Kubernetes evidence and renders factual summaries. Neither cluster objects
nor log messages enter the model. There is no arbitrary shell, generated API path,
or cluster mutation. The original 2-bit pod-filter model remains separate.

## Try these questions

- `In which namespace is my ceos pod?` searches names, labels and container images
  across namespaces in the chosen cluster. Exact names take precedence over
  partial matches. A named namespace narrows the search. Click a matching pod's
  **Diagnose** button, or its resource link.
- `What is the latest deployment?` sorts Deployment **creation timestamps**.
  This is different from the latest rollout of an existing Deployment. The
  latter question is refused because retained ReplicaSet timestamps cannot
  reliably reconstruct rollback timing.
- `Summarize the last 10 events` selects the newest ten dated event records,
  including Normal and Warning. It reports reasons and lifetime series counts.
  Ten records are not necessarily ten individual occurrences. Requested counts
  range from 1 to 20; an omitted count defaults to 10.
- `When did the last pod die?` means the most recent **recorded nonzero container
  termination**, including init containers. Successful completion and pod deletion
  are different observations. An omitted count defaults to one.
- `Why is pod api-crash failing in namespace production?` resolves one pod,
  refreshes its UID, reads conditions and termination states, selects events by
  UID, and reads logs for up to two failing containers. Previous logs are used
  when a failed earlier instance is recorded. Each log read is bounded to 80
  lines / 16 KiB / 8 seconds. Missing permission or unavailable logs stay visible.
- After locating or diagnosing one pod, `Why is it failing?` refreshes that
  specific UID. Replacement or deletion requires another lookup. Cluster and
  namespace selection changes clear this session reference.

Overview, health, inventories, warning events, restart counts, CPU, memory and
images remain available through the existing report tool. An explicit namespace
overrides the UI selection; `all namespaces` overrides it as well. Relative time
ranges, multiple namespaces in one sentence, arbitrary application log reasoning,
and requests to modify the cluster are outside this version's contract.

## Evidence and coverage

The new workflows page through at most 10,000 objects in total and 40 list
requests. They fail on incomplete pagination instead of claiming a complete
ranking. Pod lookup uses bounded live pod lists so images and complete label
evidence are available even when the general search index is partial.

Each active cluster's existing pod watcher feeds an in-memory journal of dated
failed container terminations. It deduplicates by pod UID, container and finish
time; deleted/relisted objects never acquire an invented death timestamp. The
journal retains up to 10,000 records for 24 hours after observation. Records
survive pod deletion but are lost on cluster disconnect or server restart.
Answers identify the journal start, watcher state, interruptions and evictions.
Current pod status is still read and merged with retained observations. Access
to retained records requires a fresh successful Kubernetes pod-list permission
check in the requested scope.

The journal cannot reconstruct unobserved failures or provide 24/7 history when
Kubus is closed. That requires an always-running collector or an existing
observability backend. Logs are displayed as untrusted text, never executed or
treated as instructions. A CrashLoopBackOff is reported as a retry state; it is
not presented as a root cause. Explanations name the supporting observation and
do not invent application-specific causes.

## Train, evaluate and install locally

First follow the pinned environment/checkpoint setup in [README.md](README.md).
The new recipe uses those same inputs, tokenizer, exporter and full 20-layer
model. It trains from the original checkpoint, not by stacking adapters.
See [measured results and remaining limitations](harness-results.md).

```sh
node needle/finetune/prepare-cluster.mjs
node needle/finetune/prepare-harness.mjs
node needle/finetune/prepare-harness-challenge.mjs

NEEDLE_TELEMETRY=0 XLA_PYTHON_CLIENT_PREALLOCATE=false \
  .cache/needle-training/venv/bin/needle finetune \
  .cache/needle-training/harness/train.jsonl \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --epochs 10 --batch-size 4 --lr 0.0001 \
  --lora-rank 16 --lora-alpha 32 --max-len 512 \
  --val-split 0.1 --seed 20260920 \
  --out .cache/needle-training/harness/kubus-lora.safetensors

JAX_PLATFORMS=cpu NEEDLE_TELEMETRY=0 \
  .cache/needle-training/venv/bin/python needle/finetune/export.py \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --base-archive .cache/needle-training/base-2bit.cact \
  --adapter .cache/needle-training/harness/kubus-lora.safetensors \
  --output .cache/needle-training/harness/kubus-4bit.cact

node needle/finetune/evaluate.mjs --harness \
  --weights .cache/needle-training/harness/kubus-4bit.cact \
  --data .cache/needle-training/harness/test.jsonl \
  --output .cache/needle-training/harness/tuned.json
node needle/finetune/evaluate.mjs --harness \
  --weights .cache/needle-training/harness/kubus-4bit.cact \
  --data .cache/needle-training/harness/challenge.jsonl \
  --output .cache/needle-training/harness/challenge-tuned.json

pnpm setup:needle --model .cache/needle-training/harness/kubus-4bit.cact --question-contract harness-v2
pnpm test:needle
pnpm dev
```

The dataset contains 3,918 synthetic examples (352 refusals); the seeded split
uses 3,527 training and 391 validation examples. The longest rendered example is
422 tokens, within the 512-token training sequence. The 117-question development
set is separate from training but may inform iteration. The 40-question challenge
was authored while the first new training run was running, before inspecting its
results. It includes new names, namespaces, counts and unsupported requests.
Do not claim its accuracy as a representative production benchmark.

The tools are explicitly shortlisted in TypeScript to at most five per question.
The model chooses among that shortlist and extracts stated arguments; the
application validates the call, count, namespace and name before reading.
If it returns no call and there is exactly one task candidate besides the
general report tool, the harness retries once with only that candidate. The
question is unchanged and all validation still applies. Held calls, explicit
grounding/negation failures and ambiguous candidate sets are never retried.
The shipped archive lacks a trained embedding retrieval head, so this does not
depend on implicit model-side tool retrieval. Fine-tuned confidence scores are
not calibrated and are ignored. A single held call is usable only with the
engine's explicit clean grounding and negation flags.

Runtime generation is limited to 256 tokens per pass, with at most two passes.
The archive has an 8,192 maximum
sequence length and a 256-entry sliding KV cache: **256 is not the input context
limit**. `questionContract: harness-v2` in installed metadata prevents an old
report-only model being loaded against the new tool contract. Model weights,
adapters, generated datasets and detailed evaluation outputs remain git-ignored;
source, recipes, fixtures and result summaries belong in this repository.

## Why this design

The implementation applies narrow task tools and grounded arguments from the
[Needle tool guide](https://www.cactuscompute.com/blog/designing-tools-for-needle),
with retrieval and context details checked against the more specific
[porting contract](https://www.cactuscompute.com/blog/porting-needle). It keeps
session identity, evidence and permissions outside model context, and evaluates
intermediate reads and final answers rather than only matching generated calls.
This follows the evaluation approach described in
[Google's harness engineering article](https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/).
The implementation uses ordinary TypeScript and existing Kubus readers; it
does not add an agent framework or a hosted service.
