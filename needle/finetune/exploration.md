# Ask your cluster: exploration contract v3

Needle translates a short question into a typed read request. Kubus resolves the
resources, reads Kubernetes and builds the answer. The model never sees cluster
objects, Secret values or logs, and cannot generate commands or API URLs.

## Questions to try

| Question | What the answer uses |
| --- | --- |
| `What is the status of the ceos pods?` | Only pods matching `ceos` in their name, labels or images |
| `Show pending ceos pods on node worker-1 in namespace lab` | The text match **and** phase **and** node **and** namespace |
| `Show pods matching app=web` | Exact label equality; `app=web-extra` does not match |
| `Give me the logs of the ceos pod` | Pod choice when ambiguous, then a UID-verified log excerpt |
| `Show previous logs for pod api-123 container proxy` | The explicitly selected previous container instance |
| `What is my oldest pod?` / `What is my newest pod?` | Existing Pod creation timestamps, including every list page |
| `Show the oldest 5 pods` | The first five ranked pods; 1–20 results are supported |
| `Which pods restart most?` | Current restart counts, highest first |
| `Show memory usage for pod ceos` | Metrics joined to matching pod names; missing samples are disclosed |
| `What config-maps do I have?` | A metadata inventory, with a total and names |
| `How many secrets?` | A metadata-only count across the selected scope |
| `What is using 10.96.0.10?` | Matching Service, Pod, EndpointSlice, ingress and Node references |
| `Any 443 port open?` | Declared Service/container/host/backend ports and ingress TLS configuration |
| `What uses UDP port 53?` | Only declarations with that transport protocol |
| `Show services on port 443` | Only Service references; an explicit resource kind narrows the lookup |
| `Which images are available?` | Separate workload references and node cache inventories |
| `Which images are cached on node worker-1?` | That node's reported image cache |
| `Show images for pod ceos` | Images from matching pods, rather than image names containing `ceos` |
| `How much free CPU and memory on my cluster?` | Node capacity, allocatable resources, usage and configured requests |
| `How much free memory on node worker-1?` | The same calculations for that exact node |

The existing diagnosis, pod location, Deployment creation, event summary and
termination history workflows remain available. After selecting one pod,
`Show its logs` and `Why is it failing?` refresh that pod's UID. Pod rows have
**Open**, **Diagnose** and **Logs** actions. A multi-container pod asks for a
container unless it has one regular container or a valid default-container
annotation. Container selection preserves an explicit request for previous logs.

An explicit namespace overrides the current Kubus namespace selection.
`all namespaces` clears it. Location questions cover all namespaces by default;
ordinary pod status and log searches use the visible scope. Nodes are always
cluster-wide. Image answers distinguish namespace-scoped workloads from the
cluster-wide node cache.

## What each answer establishes

- **Filters:** a pod text search checks names, labels and regular/init container
  images. Label `key=value` syntax checks exact key and value. Node, status,
  namespace and ordering conditions combine with AND. Model output that drops
  an explicit condition is rejected. Supported states are Running, Pending,
  Failed, Succeeded, Unknown, unhealthy, not-ready and CrashLoopBackOff.
  Running/Pending/etc. refer to the Kubernetes phase; a Running-phase pod can
  still contain an unready or crashing container, shown in the status columns.
- **Age:** this ranks current Pod objects, not container uptime or deleted pods.
  Undated objects are excluded and counted. An age question defaults to one row;
  other pod queries default to twenty. Restart and usage rankings are descending.
  Usage answers include the total of all sampled matching pods, before the row
  limit. Metrics are matched by namespace/name and can lag a pod replacement.
- **Logs:** current logs are the default. Each request checks the pod UID before
  and after reading, caps output at 80 lines / 16 KiB / 8 seconds, and never
  follows a stream. Logs are rendered as plain text. Open the pod for the full
  log viewer or streaming. The model does not infer an application root cause
  from log text.
- **ConfigMaps and Secrets:** a dedicated endpoint requests
  `PartialObjectMetadataList` and returns only name, namespace, UID, labels and
  creation time. It strips annotations, including last-applied manifests. It
  does not fall back to full objects if metadata negotiation fails. Counts use
  all pages, not the displayed twenty rows. Kubernetes permissions still apply.
- **IPs:** references can overlap: a pod's `hostIP` refers to its node, and an
  EndpointSlice describes a backend. Matches do not imply exclusive ownership.
  IPv4 and equivalent compressed/expanded IPv6 addresses are supported.
- **Ports:** a declaration does not prove reachability or a listening process.
  This is not a network scan. NetworkPolicy, firewall and ingress controller
  listener configuration still matter. Named target ports are reported through
  container or EndpointSlice declarations when available. Ingress TLS is labeled
  as a usual HTTPS-port inference, not a measured listener.
- **Images:** workload specifications may reference images that failed to pull.
  Node image lists may be capped/stale and contain multiple aliases for one image.
  Neither inventory is a registry catalog or a promise that a new pull will work.
- **Capacity:** `capacity − sampled usage` estimates unused reported node capacity.
  Memory usage is working set, not the operating system's free-memory counter.
  `allocatable − configured pod requests` estimates unreserved capacity. These
  are different numbers. Request accounting includes sequential init phases,
  restartable sidecars, pod-level requests and overhead; completed pods are
  excluded. Missing metrics/requests stay unavailable, including cluster totals
  if any node is missing data. Totals sum Node reports, including cordoned or
  unready nodes identified in the table. This is not a scheduling simulation:
  taints, placement, in-place resize and other constraints still apply.

New exploration answers have a shared budget of 10,000 objects and forty reads.
Pagination loops and limits fail instead of producing incomplete rankings or
counts. Network/image/capacity reports can retain useful independent evidence
when another source is denied, and explicitly identify the missing coverage.

Numeric threshold predicates, OR/exclusion filters, multiple text matches in one
pod query, time windows, log streaming, multiple IPs/ports in one question and
cluster mutations remain outside this contract. Ask for one workflow at a time.
These boundaries prevent silently returning a broader or differently filtered
answer. Additional schemas and labeled examples can extend them later.

## Local training and evaluation

Use the pinned environment/checkpoint instructions in [README.md](README.md).
The question model is locally exported as CQ4 because the available local
exporter supports that path. The original 2-bit pod-filter model stays separate.
Training starts from the original checkpoint, not a stack of previous adapters.

```sh
node needle/finetune/prepare-cluster.mjs
node needle/finetune/prepare-exploration.mjs
node needle/finetune/prepare-exploration-challenge.mjs

NEEDLE_TELEMETRY=0 XLA_PYTHON_CLIENT_PREALLOCATE=false \
  .cache/needle-training/venv/bin/needle finetune \
  .cache/needle-training/exploration/train.jsonl \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --epochs 10 --batch-size 4 --lr 0.0001 \
  --lora-rank 16 --lora-alpha 32 --max-len 640 \
  --val-split 0.1 --seed 20260921 \
  --out .cache/needle-training/exploration/kubus-lora.safetensors

JAX_PLATFORMS=cpu NEEDLE_TELEMETRY=0 \
  .cache/needle-training/venv/bin/python needle/finetune/export.py \
  --checkpoint .cache/needle-training/needle3.safetensors \
  --base-archive .cache/needle-training/base-2bit.cact \
  --adapter .cache/needle-training/exploration/kubus-lora.safetensors \
  --output .cache/needle-training/exploration/kubus-4bit.cact

node needle/finetune/evaluate.mjs --harness \
  --weights .cache/needle-training/exploration/kubus-4bit.cact \
  --data .cache/needle-training/exploration/test.jsonl \
  --output .cache/needle-training/exploration/tuned.json
node needle/finetune/evaluate.mjs --harness \
  --weights .cache/needle-training/exploration/kubus-4bit.cact \
  --data .cache/needle-training/exploration/challenge.jsonl \
  --output .cache/needle-training/exploration/challenge-tuned.json

pnpm setup:needle --model .cache/needle-training/exploration/kubus-4bit.cact --question-contract harness-v3
pnpm test:needle
pnpm dev
```

The recipe has 5,128 synthetic examples, including 352 refusals. It migrates
previously unsupported namespace Secret inventories and pod label/node queries
to their now-supported tools. There are 4,616 training and 512 validation examples.
The longest rendered example is 632 tokens, within the 640-token training cap.
Validation loss is a training diagnostic, not an accuracy claim.

The 120-question development set and 50-question challenge use prompt strings
absent from training. The challenge has 36 supported and 14 unsupported questions
and was authored before examining the new weights. Harness changes may be
informed by these sets; neither is a blind or representative production benchmark.
The browser suite separately exercises the user's original ten questions.
See [results and limitations](exploration-results.md).

The evaluator uses the runtime's actual schemas, reset behavior, 256-token output
budget and optional single retry. An empty classification or a rejected general
report can retry with one unambiguous task tool. The prompt is unchanged, held
calls and grounding/negation failures do not retry, and all normal validation
still applies. It reports strict call exactness separately
from accepted correct reads, equivalent generic pod-list/restart/usage tools, rejected
requests and accepted wrong interpretations. Both validator source files are
hashed. Detailed responses, model weights, adapters and generated datasets remain
ignored by Git. `questionContract: harness-v3` prevents loading earlier weights
against the expanded schema contract. The old v2 recipe uses a frozen contract
and `evaluate.mjs --harness-v2` for reproducibility.

## Sources

Capacity distinctions follow Kubernetes' documentation on
[node allocatable resources](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/),
[the metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
and [pod resource requests](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).
Metadata list negotiation follows the
[official metadata client](https://github.com/kubernetes/client-go/blob/master/metadata/metadata.go)
and was checked against the connected cluster. See the
[v2 harness design](harness.md) for the original Needle tool/harness sources.
