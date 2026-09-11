.PHONY: all deb win dmg clean helm-engine

helm-engine:
	node helm-engine/build.mjs

all: helm-engine
	pnpm build && pnpm --filter @kubus/electron dist

deb: helm-engine
	pnpm build && pnpm --filter @kubus/electron dist --linux deb

win: helm-engine
	pnpm build && pnpm --filter @kubus/electron dist --win

dmg: helm-engine
	pnpm build && pnpm --filter @kubus/electron dist --mac

clean:
	rm -rf electron/release
