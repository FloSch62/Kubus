#!/usr/bin/env bash
# Spin up two kind clusters with metrics-server, a sample Helm release and
# intentionally broken workloads for exercising every Kubus feature.
set -euo pipefail

for tool in kind kubectl helm; do
  command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
done

# Low inotify limits make kube-proxy/metrics-server crashloop with
# "too many open files" (https://kind.sigs.k8s.io/docs/user/known-issues/).
if [ "$(sysctl -n fs.inotify.max_user_instances)" -lt 512 ]; then
  echo "WARNING: fs.inotify.max_user_instances < 512 — kind pods may crashloop."
  echo "  Fix: sudo sysctl fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288"
fi

kind get clusters | grep -q '^kubus-a$' || kind create cluster --name kubus-a
kind get clusters | grep -q '^kubus-b$' || kind create cluster --name kubus-b

CTX_A=kind-kubus-a

# metrics-server (kind needs insecure kubelet TLS)
kubectl --context "$CTX_A" apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl --context "$CTX_A" -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Sample Helm release (3 replicas for aggregated logs)
helm --kube-context "$CTX_A" upgrade --install podinfo oci://ghcr.io/stefanprodan/charts/podinfo \
  -n demo --create-namespace --set replicaCount=3

# Demo workloads and CRDs.
SAMPLE_DIR="$(dirname "$0")/sample-apps"
kubectl --context "$CTX_A" apply -f "$SAMPLE_DIR/broken.yaml"
kubectl --context "$CTX_A" apply -f "$SAMPLE_DIR/widgets-crd.yaml"
kubectl --context "$CTX_A" wait --for=condition=Established crd/widgets.demo.kubus.io --timeout=60s
kubectl --context "$CTX_A" apply -f "$SAMPLE_DIR/widgets.yaml"

echo
echo "Done. Contexts: kind-kubus-a (full demo), kind-kubus-b (empty)."
