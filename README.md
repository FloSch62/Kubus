# ⎈ Kubedeck

**A free, open-source Kubernetes GUI** 

Connect to all your clusters at once, browse and edit every resource (CRDs included), stream aggregated logs, open shells into containers, forward ports, watch metrics, and inspect Helm releases — all from one polished web UI that runs entirely on your machine.

![Overview dashboard — cluster health at a glance](docs/screenshot-overview.png)

![Pods list with live status](docs/screenshot-pods.png)

## Features

- **Multi-cluster, unified view** — connect to any number of kubeconfig contexts simultaneously; lists merge resources from all selected clusters with a cluster column.
- **Every resource kind** — builtin workloads, networking, config, storage, RBAC… plus all CRDs discovered dynamically.
- **Live updates** — informer-style watches over WebSocket keep every list in sync without refreshing (incl. resilient 410/reconnect handling).
- **Human-friendly details + YAML editor** — Monaco-powered YAML view/edit/create with conflict detection, plus per-kind overview tabs, events and metrics.
- **Quick actions** — delete, scale, rollout-restart, trigger CronJobs, cordon/uncordon and drain nodes (with live progress).
- **Aggregated log viewer** — stream logs from many pods at once, color-coded per pod, regex filter, follow, download, previous-container logs.
- **Container shell** — full xterm.js terminal over the Kubernetes exec API (bash with sh fallback, resize support).
- **Port forwarding** — one click from any Pod or Service (service ports resolve to targetPorts like kubectl), with a management panel.
- **Metrics & health overview** — CPU/memory from metrics-server with history charts, and a dashboard flagging failing pods, unavailable workloads, restarts and warning events.
- **Helm releases** — list, values (user + computed), manifests, history and uninstall — no helm binary required.
- **Resource diff** — side-by-side Monaco diff of any two resources across clusters/namespaces, with noise-field normalization.
- **Dark & light mode**, of course.

## Security model

Kubedeck is a *local* tool:

- The server binds to `127.0.0.1` only and talks directly to your cluster API servers using your existing kubeconfig — no data leaves your machine.
- Every request requires a random per-run bearer token (the browser receives it via the launch URL), protecting against DNS-rebinding/CSRF on localhost.
- Secret values are redacted by default everywhere (lists, details, watch streams); revealing them is an explicit per-resource action.

## Getting started

Requires **Node.js ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm build
pnpm start          # serves the UI and opens your browser
```

The server reads `~/.kube/config` (or `$KUBECONFIG`, or `--kubeconfig <path>`) and picks a port with `--port <n>` (default 3001).

### Development

```bash
pnpm dev            # tsx-watch server on :3001 + Vite client on :5173
```

Open `http://localhost:5173` — the Vite dev server proxies `/api` and `/ws` to the backend.

### Test clusters

`hack/dev-clusters.sh` spins up two [kind](https://kind.sigs.k8s.io/) clusters with metrics-server, a sample Helm release, and intentionally broken workloads to exercise the overview dashboard.

## Architecture

```
┌─────────────────────────────────────┐
│  Browser — React 19 + MUI 7 SPA     │
│  TanStack Query · Monaco · xterm.js │
└──────────────┬──────────────────────┘
               │ REST + WebSocket (token-authed, same-origin)
┌──────────────┴──────────────────────┐
│  Node.js — Fastify 5                │
│  @kubernetes/client-node 1.x        │
│  watch multiplexing · log fan-in    │
│  exec bridge · port-forward manager │
│  helm secret decoding · metrics     │
└──────────────┬──────────────────────┘
               │ Kubernetes API (your kubeconfig credentials)
        ┌──────┴──────┐
        │  Clusters   │
        └─────────────┘
```

- `shared/` — TypeScript types + the WebSocket protocol (zod-validated) both sides compile against.
- `server/` — cluster manager (one isolated `KubeConfig` per context), generic resource routes driven by API discovery, informer-style watchers, helm release reader (base64 → gzip → JSON), metrics poller with ring buffers.
- `client/` — app shell (cluster switcher, nav drawer, namespace filter, bottom dock for terminals/logs), generic resource list page powered by per-kind column presets, detail drawer, overview/helm/diff/forwards pages.

## Known limitations

- Helm uninstall deletes manifest resources and release records but does **not** run Helm hooks.
- Port forwards live as long as the server process.
- WebSocket port-forward requires a reasonably recent API server (kubectl's SPDY fallback is not implemented).

## License

[MIT](./LICENSE)
