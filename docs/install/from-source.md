---
icon: lucide/terminal
---

# Run from source

Prefer to run Kubus as a local web server, or on a platform without a packaged build?
Clone the repo and start it with `pnpm`. This is also the path to take if you want to
[contribute](../community/contributing.md).

## Requirements

- **Node.js ≥ 22**
- **[pnpm](https://pnpm.io/installation)**

## Build & start

```bash
git clone https://github.com/FloSch62/Kubus.git
cd Kubus

pnpm install
pnpm build
pnpm start          # serves the UI and opens your browser
```

`pnpm start` builds nothing new — it runs the compiled server (`node server/dist/index.js`),
binds to `127.0.0.1`, picks a port (default **3001**) and opens your browser at a URL that
already carries the per-run access token.

!!! tip "Point Kubus at a specific kubeconfig or port"

    ```bash
    pnpm start -- --kubeconfig /path/to/config --port 8080
    ```

    See [command-line flags](../reference/cli.md) for the full list (`--kubeconfig`,
    `--port`, `--no-open`, and the `KUBECONFIG` / `PORT` environment variables).

## Run the desktop shell locally

To launch the Electron desktop app from a source checkout:

```bash
pnpm electron       # builds everything, then launches Electron
```

To package installers for your current platform into `electron/release/`:

```bash
pnpm dist
```

## Develop with hot reload

If you're hacking on Kubus itself, the dev servers give you instant reloads:

```bash
pnpm dev            # tsx-watch server on :3001 + Vite client on :5173
```

Open **`http://localhost:5173`** — the Vite dev server proxies `/api` and `/ws` to the
backend on `:3001`.

[More on the dev workflow :octicons-arrow-right-24:](../community/development.md)

## Next steps

<div class="grid cards" markdown>

-   :material-rocket-launch: **Quickstart**

    ---

    Connect your first cluster and take the tour.

    [:octicons-arrow-right-24: Quickstart](../quickstart.md)

-   :material-test-tube: **Spin up test clusters**

    ---

    Two throwaway kind clusters with sample workloads to explore every feature.

    [:octicons-arrow-right-24: Test clusters](../community/test-clusters.md)

</div>
