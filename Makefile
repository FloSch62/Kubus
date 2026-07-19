.PHONY: all deb win dmg clean helm-engine

helm-engine:
	node helm-engine/build.mjs

all: helm-engine
	pnpm build && pnpm --filter @kubus/electron dist

deb: helm-engine
	pnpm build && pnpm --filter @kubus/electron exec electron-builder --linux deb --x64

win: helm-engine
	pnpm build && pnpm --filter @kubus/electron exec electron-builder --win --x64

dmg: helm-engine
	pnpm build && pnpm --filter @kubus/electron exec electron-builder --mac dmg

clean:
	rm -rf electron/release
