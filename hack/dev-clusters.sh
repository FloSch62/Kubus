#!/usr/bin/env bash
# Spin up two kind clusters with metrics-server, a sample Helm release and
# intentionally broken workloads for exercising every Kubedeck feature.
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

kind get clusters | grep -q '^kubedeck-a$' || kind create cluster --name kubedeck-a
kind get clusters | grep -q '^kubedeck-b$' || kind create cluster --name kubedeck-b

CTX_A=kind-kubedeck-a

# metrics-server (kind needs insecure kubelet TLS)
kubectl --context "$CTX_A" apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl --context "$CTX_A" -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Sample Helm release (3 replicas for aggregated logs)
helm --kube-context "$CTX_A" upgrade --install podinfo oci://ghcr.io/stefanprodan/charts/podinfo \
  -n demo --create-namespace --set replicaCount=3

# Broken workloads for the overview dashboard
kubectl --context "$CTX_A" apply -f "$(dirname "$0")/sample-apps/"

echo
echo "Done. Contexts: kind-kubedeck-a (full demo), kind-kubedeck-b (empty)."
