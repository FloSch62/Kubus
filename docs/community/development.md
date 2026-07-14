---
icon: lucide/code
---

# Building from source

The full dev setup for hacking on Kubus itself. If you just want to *run* Kubus from
source, the [install guide](../install/from-source.md) is shorter.

## Requirements

- **Node.js ≥ 22**
- **[pnpm](https://pnpm.io/installation)**

## Project layout

Kubus is a pnpm workspace:

| Package | What it is |
| --- | --- |
| `client/` | The React 19 + MUI 7 single-page app (Vite). |
| `server/` | The Fastify 5 server — Kubernetes client, watches, exec, port-forward, Helm, metrics. |
| `shared/` | Types and metadata shared between client and server. |
| `electron/` | The Electron desktop shell. |
| `hack/` | Dev scripts, including the [test-cluster](test-clusters.md) bootstrap. |

## Hot-reload dev servers

```bash
pnpm install
pnpm dev            # tsx-watch server on :3001 + Vite client on :5173
```

Open **`http://localhost:5173`** — the Vite dev server proxies `/api` and `/ws` to the
backend on `:3001`, so client and server both hot-reload.

## Production build

```bash
pnpm build          # builds every package
pnpm start          # runs the compiled server and opens your browser
```

## Desktop shell

```bash
pnpm electron       # builds everything, then launches Electron
pnpm dist           # packages installers for the current platform → electron/release/
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm lint:perf     # optional performance audit; reports suggestions without failing
```

## See also

<div class="grid cards" markdown>

-   :material-test-tube: **[Test clusters](test-clusters.md)** — sample workloads to develop against
-   :material-sitemap: **[Architecture](../reference/architecture.md)** — how the pieces fit
-   :material-tag: **[Releasing](releasing.md)** — how installers are built

</div>
