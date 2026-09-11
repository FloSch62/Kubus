# helm-engine

Helm's chart rendering pipeline — `loader` → `chartutil` → `engine` → `releaseutil` from
`helm.sh/helm/v4` — compiled to a WASI module so the Kubus server can install and upgrade
releases without a `helm` binary.

It is a pure function over files: the Node host preopens a scratch directory containing
`input.json` (chart archive or the chart object from a release record, values, release
options, cluster capabilities) and the module writes `output.json` (sorted manifest,
hooks, notes, CRDs, and the chart in release-record form). No network, no cluster access —
all cluster I/O stays in the TypeScript server.

The Helm 4 SDK uses the stable `chart/v2` and `release/v1` packages for existing
charts and Helm 3 release records. Experimental chart v3 and Helm CLI plugins are
not enabled. Kubus continues to handle resource application and release storage.

## Build

```bash
node helm-engine/build.mjs   # or: make helm-engine
```

Requires a Go toolchain (build-time only; the artifact is platform-independent). Output
lands at `server/assets/helm-engine.wasm.gz` (~13MB gzipped) — git-ignored, packaged into
releases, and loaded lazily by the server. Without it, all read-only Helm features keep
working; install/upgrade report the engine as unavailable.

After `pnpm build` and `pnpm build:helm-engine`, run `pnpm test:helm-engine` to test
the compiled WASM through the server's Node host. The suite covers archive
inspection, values and schema validation, subcharts, capabilities, hooks, notes,
CRDs, and values-only upgrades from Helm 3 chart JSON. It needs no cluster or Helm
CLI and runs on every CI build platform.

Keep `k8s.io/kube-openapi` at `v0.0.0-20260821135717-be32def86098` while using
`k8s.io/apimachinery` 0.37. The newer OpenAPI revision returns
`structured-merge-diff/v7` schema types, which do not compile with apimachinery's
v6 schema types. Upgrade these dependencies together once they are compatible.
