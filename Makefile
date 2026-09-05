.PHONY: all desktop deb win clean helm-engine

helm-engine:
	node helm-engine/build.mjs

all: desktop

desktop:
	pnpm dist

deb: desktop
	pnpm --filter @kubus/desktop deb

win:
	node -e "if (process.platform !== 'win32') { console.error('make win requires Windows. Electrobun does not support cross-compilation; use a Windows host or the Windows CI runner.'); process.exit(1) }"
	pnpm dist

clean:
	node -e "for (const p of ['desktop/build', 'desktop/artifacts']) require('node:fs').rmSync(p, { recursive: true, force: true })"
