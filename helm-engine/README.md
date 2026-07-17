# helm-engine

Helm's chart rendering pipeline — `loader` → `chartutil` → `engine` → `releaseutil` from
`helm.sh/helm/v3` — compiled to a WASI module so the Kubus server can install and upgrade
releases without a `helm` binary.

It is a pure function over files: the Node host preopens a scratch directory containing
`input.json` (chart archive or the chart object from a release record, values, release
options, cluster capabilities) and the module writes `output.json` (sorted manifest,
hooks, notes, CRDs, and the chart in release-record form). No network, no cluster access —
all cluster I/O stays in the TypeScript server.

## Build

```bash
node helm-engine/build.mjs   # or: make helm-engine
```

Requires a Go toolchain (build-time only; the artifact is platform-independent). Output
lands at `server/assets/helm-engine.wasm.gz` (~13MB gzipped) — git-ignored, packaged into
releases, and loaded lazily by the server. Without it, all read-only Helm features keep
working; install/upgrade report the engine as unavailable.
