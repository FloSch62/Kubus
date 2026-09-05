---
icon: lucide/code
---

# Building from source

The full dev setup for hacking on Kubus itself. If you just want to *run* Kubus from
source, the [install guide](../install/from-source.md) is shorter.

## Requirements

- **Node.js ≥ 24.20**
- **[pnpm](https://pnpm.io/installation) 11**

## Project layout

Kubus is a pnpm workspace:

| Package | What it is |
| --- | --- |
| `client/` | The React 19 + MUI 9 single-page app (Vite). |
| `server/` | The Fastify 5 server: Kubernetes client, watches, exec, port-forward, Helm, metrics. |
| `shared/` | Types and metadata shared between client and server. |
| `desktop/` | The Electrobun desktop runtime, RPC bridge, and packaging. |
| `hack/` | Dev scripts, including the [test-cluster](test-clusters.md) bootstrap. |

## Hot-reload dev servers

```bash
pnpm install
pnpm dev            # tsx-watch server on :3001 + Vite client on :5173
```

Open **`http://localhost:5173`**. The Vite dev server proxies `/api` and `/ws` to the
backend on `:3001`, so client and server both hot-reload.

## Production build

```bash
pnpm build          # builds every package
pnpm start          # runs the compiled server and opens your browser
```

## Desktop shell

```bash
make deb           # Linux: builds a .deb in desktop/artifacts/ (dpkg-deb + zstd required)
pnpm desktop       # builds everything, then launches Electrobun
pnpm dist           # packages installers for the current platform → desktop/artifacts/
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm lint:perf     # optional performance audit; reports suggestions without failing
```

## See also

<div class="grid cards" markdown>

-   :material-test-tube: **[Test clusters](test-clusters.md)** for sample workloads to develop against
-   :material-sitemap: **[Architecture](../reference/architecture.md)** for how the pieces fit together
-   :material-tag: **[Releasing](releasing.md)** for the release workflow that builds the installers

</div>

The desktop build pins Electrobun 2.0.1. Its npm command downloads the matching Hutch,
Bun and the native SDK into the managed toolchain cache on first build. Go is required for
the Helm WASI engine and native URL relay. `pnpm --filter @kubus/desktop run pack`
builds a development bundle; `pnpm test:desktop` drives its system WebKitGTK view on Linux using `webkit2gtk-driver`.
On headless Linux use `xvfb-run --auto-servernum pnpm test:desktop`.
Desktop packaging runs on the target OS. macOS builds require arm64; Intel and
universal macOS artifacts are not produced.
