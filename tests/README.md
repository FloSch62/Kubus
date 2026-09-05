# Kubus test suite

All automated tests live in this workspace package (`@kubus/tests`): Vitest
unit suites for shared, server, client, and Electrobun code; a browser Playwright
suite against a real kind cluster; and a desktop Playwright suite that launches
the actual Electrobun main, preload, and renderer processes. Coverage scans all
TypeScript production packages, including Electrobun, so untested files are
counted instead of disappearing from the report.

## Layout

```
tests/
  unit/
    shared/   # shared/src — jsonpath, resource metadata, ws protocol schemas
    server/   # server/src — kube logic, helm, watch/delta engine, ws handlers
    client/   # client/src — smart filter, display helpers, stores, hooks (jsdom)
    desktop/  # desktop/src — main-process IPC/lifecycle and preload bridge
  e2e/
    specs/        # Playwright specs
    fixtures/     # workloads applied to the cluster (namespace kubus-e2e)
    helpers/      # kubeconfig/cluster plumbing shared by setup + webServer
    global-setup.ts
    start-server.mjs  # webServer entry: seeds isolated state, boots server/dist
  desktop/
    specs/        # real Electrobun process-boundary tests
    helpers/      # isolated user data/kubeconfig and desktop launcher
  setup/client.ts     # jsdom shims + jest-dom for the client project
  vitest.config.ts    # four projects: shared, server, Electrobun, client
  playwright.config.ts
  playwright.desktop.config.ts
```

## Unit tests

```bash
pnpm test              # from the repo root (or `pnpm test` inside tests/)
pnpm test:watch
pnpm test:coverage     # writes tests/coverage/
```

Coverage is rooted at the repository rather than this package. The report
therefore includes unimported production files from `shared/src`, `server/src`,
`client/src`, and `desktop/src`. A 50% floor on every repository-wide metric
protects the current baseline; per-package floors keep improvements in one
package from hiding regressions in another.

After `pnpm --filter @kubus/desktop run prepare:sdk`, no app build step is needed: tests import package TypeScript sources directly, and
`@kubus/shared` is aliased to `shared/src`. Server/shared tests run in node,
client tests in jsdom (Testing Library is set up; `tests/setup/client.ts`
shims `matchMedia`/`ResizeObserver`).

Server tests fake the cluster at the `ClusterHandle` seam — pass
`{ clusters: { get: () => fakeHandle } }` as the `AppContext` and implement
only what the code under test touches (see `logs-socket.test.ts`,
`watcher.test.ts`).

Electrobun unit tests mock the native module and embedded server at the process
boundary. They exercise sender validation, coalesced on-disk state, deep-link
delivery, update-manifest validation, native accelerators, shutdown ordering,
and the exact preload API without opening a window.

## End-to-end tests

```bash
pnpm build             # client + server dist must exist
pnpm test:e2e          # Node server
KUBUS_E2E_RUNTIME=bun pnpm test:e2e # bundled Bun server (requires desktop pack)
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

Cleanup (optional):
`kubectl --context "kind-${KUBUS_E2E_KIND_CLUSTER:-kubus-a}" delete namespace kubus-e2e`.

Selector conventions: production builds strip `data-testid`, so locate by
role/text/placeholder. Grids virtualize rows — filter via the search box
instead of scrolling. With nested MUI dialogs, background elements go
aria-hidden; scope queries to the dialog by text.

## Electrobun end-to-end tests

```bash
pnpm build && pnpm build:helm-engine
pnpm --filter @kubus/desktop run pack
pnpm test:desktop     # Linux: install webkit2gtk-driver; use Xvfb when headless
```

Each spec launches the real Electrobun executable against a temporary user-data
directory, temporary `XDG_CONFIG_HOME`, and empty kubeconfig. The suite checks
the typed preload bridge, renderer-to-main state persistence,
desktop keyboard shortcuts, cold-start `kubus://` routing, and physical pointer
interaction with controls inside the draggable title bar. The title-bar test
uses a local Kubernetes API fixture; the Electrobun main,
preload, renderer, CSS hit regions, and pointer input remain real. Linux requires WebKitGTK 4.1, `webkit2gtk-driver`, and a display with a window manager; CI runs Openbox under Xvfb. Set `WEBKIT_WEBDRIVER` to use a driver outside PATH. `KUBUS_DESKTOP_LAUNCHER` can point to an extracted release for the same checks. All temporary desktop
state is removed after each test.

## CI

The `build` matrix job builds and runs unit and runtime smoke tests on Ubuntu, macOS,
and Windows. Native WebKitGTK automation runs on Linux. Linux runs the repository-wide coverage command, enforces its
thresholds, and uploads the HTML report; macOS and Windows run the faster unit
command. The Linux `e2e` job creates a kind cluster named `kubus-a` via
`helm/kind-action` and runs the browser suite, uploading diagnostics on failure.

`pnpm smoke:helm` verifies invalid-chart recovery and repeated Helm rendering under both Node and the bundled Bun runtime. CI runs the Kubernetes end-to-end suite under that bundled Bun.

CI runs the Kubernetes browser suite in WebKit. Locally: `pnpm --filter @kubus/tests exec playwright install webkit`, then `PLAYWRIGHT_BROWSER=webkit KUBUS_E2E_RUNTIME=bun pnpm test:e2e`.

## Native performance on an existing cluster

After building and packing the desktop app:

```bash
KUBUS_PERF_CONTEXT=myairframe3-k8s-vms pnpm test:desktop
```

This opt-in spec extracts only that context into a private temporary kubeconfig.
It reads resources, metrics, and logs; it does not apply fixtures or mutate the
cluster. It measures the actual WebKitGTK desktop with native wheel input and
frame-by-frame scrolling, checks selection, keyboard focus, filters, large scroll
jumps, horizontal scrolling, tooltips, and drawer resizing, and visits several
resource tables. Frame-time budgets guard sustained scrolling and cold detail
opening. The report includes a plain overflow control so driver/display pacing
is visible. Timing reports and screenshots are saved in `desktop/.results/`.
Run it without concurrent builds or test suites that would distort timings.

On a Linux X11/XWayland display, add `KUBUS_PERF_CAPTURE=1` to check the actual
drawer animation and native wheel scrolling with `ffmpeg`, `xprop`, and
`xwininfo`. It captures strips of the native window at 60 Hz and verifies
intermediate drawer positions, frame holds, and continuous scrolling without
blank rows. It also checks the native window icon. This distinguishes compositor motion from JavaScript frame
callbacks delayed by table layout. Both real-cluster specs are skipped unless
explicitly enabled. `KUBUS_DESKTOP_LAUNCHER` can target the launcher inside an
extracted `.deb` to verify the exact release payload.
