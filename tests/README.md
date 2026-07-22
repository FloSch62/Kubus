# Kubus test suite

All automated tests live in this workspace package (`@kubus/tests`): Vitest
unit suites for shared, server, client, and Electron code; a browser Playwright
suite against a real kind cluster; and a desktop Playwright suite that launches
the actual Electron main, preload, and renderer processes. Coverage scans all
TypeScript production packages, including Electron, so untested files are
counted instead of disappearing from the report.

## Layout

```
tests/
  unit/
    shared/   # shared/src — jsonpath, resource metadata, ws protocol schemas
    server/   # server/src — kube logic, helm, watch/delta engine, ws handlers
    client/   # client/src — smart filter, display helpers, stores, hooks (jsdom)
    electron/ # electron/src — main-process IPC/lifecycle and preload bridge
  e2e/
    specs/        # Playwright specs
    fixtures/     # workloads applied to the cluster (namespace kubus-e2e)
    helpers/      # kubeconfig/cluster plumbing shared by setup + webServer
    global-setup.ts
    start-server.mjs  # webServer entry: seeds isolated state, boots server/dist
  electron/
    specs/        # real Electron process-boundary tests
    helpers/      # isolated user data/kubeconfig and desktop launcher
  setup/client.ts     # jsdom shims + jest-dom for the client project
  vitest.config.ts    # four projects: shared, server, Electron, client
  playwright.config.ts
  playwright.electron.config.ts
```

## Unit tests

```bash
pnpm test              # from the repo root (or `pnpm test` inside tests/)
pnpm test:watch
pnpm test:coverage     # writes tests/coverage/
```

Coverage is rooted at the repository rather than this package. The report
therefore includes unimported production files from `shared/src`, `server/src`,
`client/src`, and `electron/src`. A 50% floor on every repository-wide metric
protects the current baseline; per-package floors keep improvements in one
package from hiding regressions in another.

No build step needed: tests import package TypeScript sources directly, and
`@kubus/shared` is aliased to `shared/src`. Server/shared tests run in node,
client tests in jsdom (Testing Library is set up; `tests/setup/client.ts`
shims `matchMedia`/`ResizeObserver`).

Server tests fake the cluster at the `ClusterHandle` seam — pass
`{ clusters: { get: () => fakeHandle } }` as the `AppContext` and implement
only what the code under test touches (see `logs-socket.test.ts`,
`watcher.test.ts`).

Electron unit tests mock the native module and embedded server at the process
boundary. They exercise sender validation, coalesced on-disk state, deep-link
delivery, update-manifest validation, native accelerators, shutdown ordering,
and the exact preload API without opening a window.

## End-to-end tests

```bash
pnpm build             # client + server dist must exist
pnpm test:e2e          # from the repo root
```

Requirements: a kind cluster named `kubus-a` (`hack/dev-clusters.sh` creates
it; override with `KUBUS_E2E_KIND_CLUSTER`), `kubectl`, and either system
Chrome or `PLAYWRIGHT_CHANNEL=chromium` after `playwright install chromium`.

What a run does:

1. `start-server.mjs` writes `e2e/.state/kubeconfig` (the kind cluster plus an
   unreachable `kubus-ghost` context for error-state tests), wipes the
   isolated `XDG_CONFIG_HOME`, and boots `server/dist` on port 3399 with the
   token fixed to `dev` — your real kubeconfig and settings are never touched.
2. `global-setup.ts` applies `fixtures/e2e-workloads.yaml` into the
   `kubus-e2e` namespace (idempotent) and waits for rollout: an nginx
   deployment, a service, config/secret objects, a pod that logs a numbered
   line every 2s, and a crash-looping pod. Mutation specs restore fixture
   values in teardown so later tests see the original state.
3. Specs run serially (`workers: 1` — the server's settings/kubeconfig state
   is global) against `http://127.0.0.1:3399`.

Failures keep traces/screenshots under `e2e/.results/`; open a trace with
`pnpm exec playwright show-trace <trace.zip>`.

Cleanup (optional): `kubectl --context kind-kubus-a delete namespace kubus-e2e`.

Selector conventions: production builds strip `data-testid`, so locate by
role/text/placeholder. Grids virtualize rows — filter via the search box
instead of scrolling. With nested MUI dialogs, background elements go
aria-hidden; scope queries to the dialog by text.

## Electron end-to-end tests

```bash
pnpm build             # client, server, and Electron dist must exist
pnpm test:electron     # no cluster or display server required on Linux
```

Each spec launches the real Electron executable against a temporary user-data
directory, temporary `XDG_CONFIG_HOME`, and empty kubeconfig. The suite checks
the context-isolated preload surface, renderer-to-main state persistence,
native accelerator IPC, and cold-start `kubus://` routing. Linux uses Chromium's
headless Ozone platform; macOS and Windows launch through Electron normally.
All temporary desktop state is removed after each test.

## CI

The `build` matrix job runs the unit suites on every OS. Linux runs the
repository-wide coverage command, enforces its thresholds, and uploads the
HTML report; macOS and Windows run the faster unit command. The Linux `e2e` job
first launches the Electron suite, then creates a kind cluster named `kubus-a`
via `helm/kind-action` and runs the browser suite, uploading diagnostics on
failure.
