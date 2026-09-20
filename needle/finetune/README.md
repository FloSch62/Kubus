# Local Kubus fine-tuning

**Current question assistant:** use the [exploration v3 recipe](exploration.md), which
adds filtered pods, logs, resource inventories, IP/port references, images and
node capacity alongside the v2 evidence workflows.
This page retains the environment setup and original report-only experiment.

This trial teaches Needle to interpret cluster questions. It
does not teach a model facts about a particular cluster. Kubus retrieves the
selected cluster's current data using its existing authenticated read APIs and
builds the answer deterministically. No cluster objects, credentials, logs or
secrets are used as training data or sent to an AI service.

The question catalog covers overview, health, pods, nodes, deployments,
services, PVCs, namespaces, warning events, restart counts, CPU usage, memory
usage and container images. Exact resource names and namespaces are optional.
Every question is independent. This is not a general chat or root-cause model;
requests outside the catalog should be refused. The UI shows the interpreted
topic and scope because small models can misunderstand a question.
See [measured results and limitations](results.md) for the completed local run.

## Environment

Training uses Python 3.12, JAX/CUDA 12 and the local NVIDIA GPU. It was run in
WSL on an RTX 4080 SUPER with 16 GB VRAM; Windows forwarding was unnecessary.
Inference continues to use the pinned WASM engine on CPU, without Python/GPU.
The open-source local exporter produces **4-bit** weights. No Cactus account,
subscription, API key or paid data-generation service is needed.

Dependencies are pinned in `requirements.txt`, including upstream source
revision `fc5bae0f9b6138828fe7589f6b531fb9a26968de`. The checkpoint and tokenizer
come from Hugging Face revision `b274efcb211a9eef48c9a88da4b43bd569696a39`;
`prepare-inputs.py` verifies their hashes. Large artifacts and the environment
live under the git-ignored `.cache/needle-training/` directory.

From the repository root:

```sh
uv venv --python 3.12 .cache/needle-training/venv
uv pip install --python .cache/needle-training/venv/bin/python -r needle/finetune/requirements.txt
.cache/needle-training/venv/bin/python needle/finetune/prepare-inputs.py
pnpm setup:needle
cp client/public/needle/needle3.cact .cache/needle-training/base-2bit.cact
node needle/finetune/prepare.mjs
node needle/finetune/prepare-cluster.mjs
node needle/finetune/prepare-challenge.mjs
```

## Data and training

The question dataset contains 2,298 synthetic examples, including 310 refusals.
The seeded 10% validation split leaves 2,069 training examples and 229 validation
examples. Another 100 cluster questions are kept outside training: 75 supported
questions and 25 unsupported requests. Their prompts and namespace values are
held out, but this set was inspected between training iterations and informed
wording improvements. These are development regression measurements, not blind
production accuracy. No real user questions or private cluster data are included.
`prepare-challenge.mjs` adds 40 independently worded checks (26 supported,
14 unsupported), authored after this final training run started and evaluated
without another training iteration. This is still a small synthetic sample.

Examples use the exact runtime schemas. Refusal examples have empty answers.
The generators reject duplicate train/test prompts and validate expected
arguments against the application boundary. Training sequences reach 237
tokens, within its 256-token training sequence. The archive supports an 8,192
maximum sequence length with a 256-entry sliding KV cache. Runtime inference
also keeps the existing 256 generated-token budget.

```sh
NEEDLE_TELEMETRY=0 XLA_PYTHON_CLIENT_PREALLOCATE=false \
  .cache/needle-training/venv/bin/needle finetune \
  .cache/needle-training/cluster/train.jsonl \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --epochs 10 --batch-size 8 --lr 0.0001 \
  --lora-rank 16 --lora-alpha 32 --max-len 256 \
  --val-split 0.1 --seed 20260921 \
  --out .cache/needle-training/cluster/kubus-lora.safetensors
```

This trains a rank-16 LoRA adapter across all 20 layers with a frozen base.
No early-exit/smaller model is substituted. An earlier mixed question/filter
adapter regressed working filter requests, so the question model is separate.
Pod filtering continues to use the official 2-bit model. `prepare.mjs` and its
filter cases preserve the original narrow pilot for comparison; they are not
inputs to this question-model training run.

## Export, compare, install

`export.py` merges the adapter in float32, matching training, and writes a 4-bit `.cact` with the pinned
archive's tokenizer. Omitting `--adapter` produces the untuned 4-bit control;
the upstream plain `needle build` would instead copy the published 2-bit file.

```sh
JAX_PLATFORMS=cpu NEEDLE_TELEMETRY=0 \
  .cache/needle-training/venv/bin/python needle/finetune/export.py \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --base-archive .cache/needle-training/base-2bit.cact \
  --adapter .cache/needle-training/cluster/kubus-lora.safetensors \
  --output .cache/needle-training/cluster/kubus-4bit.cact

node needle/finetune/evaluate.mjs --cluster \
  --weights .cache/needle-training/cluster/kubus-4bit.cact \
  --data .cache/needle-training/cluster/test.jsonl \
  --output .cache/needle-training/cluster/tuned.json
node needle/finetune/evaluate.mjs --cluster \
  --weights .cache/needle-training/cluster/kubus-4bit.cact \
  --data .cache/needle-training/cluster/challenge.jsonl \
  --output .cache/needle-training/cluster/challenge-tuned.json
pnpm setup:needle --model .cache/needle-training/cluster/kubus-4bit.cact
pnpm test:needle
pnpm dev
```

Repeat evaluation with `base-2bit.cact` and the untuned 4-bit export to isolate
the effect of training from quantization. Evaluation runs the actual WASM
binary under Node with the same tools, reset and token budget as the app.
It reports exact argument matches, refusal results, accepted wrong answers,
latency and WASM linear memory. Browser tests separately exercise the UI with
real WASM and fixture Kubernetes responses. Neither is a live-cluster or
native Electron benchmark.

`pnpm setup:needle --model ...` installs `needle-cluster.cact` and its checksum
in `cluster-model.json`, alongside the unchanged official `needle3.cact` pod
model. Both are loaded only on demand, in separate workers. Fine-tuning does
not train the confidence head, so the question classifier ignores its scores.
Like upstream's documented `extract()` behavior, it can read a single held
call as structured data, but only when the engine explicitly reports no
grounding or negation issue. Schema validation and explicit namespace/name
grounding still apply. No model call can execute a cluster mutation. Answers
show missing permissions/data and identify their interpreted topic and scope.

Running `pnpm setup:needle` again verifies the base assets and preserves the
separately installed question model. To disable question inference locally,
remove `client/public/needle/cluster-model.json` and rebuild if using a built app.
Neither the trained model nor its adapter is committed or published by these
commands. Keep the cache directory if you want to preserve the local run.
