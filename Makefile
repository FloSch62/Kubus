.PHONY: all desktop deb clean helm-engine

helm-engine:
	node helm-engine/build.mjs

all: desktop

desktop:
	pnpm dist

deb: desktop
	pnpm --filter @kubus/desktop deb

clean:
	node -e "for (const p of ['desktop/build', 'desktop/artifacts']) require('node:fs').rmSync(p, { recursive: true, force: true })"
