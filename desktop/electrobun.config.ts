import type { ElectrobunConfig } from 'electrobun';
import metadata from './package.json';
const version = metadata.version;

if (process.platform === 'darwin' && process.arch !== 'arm64') {
  throw new Error('Kubus supports Apple Silicon Macs only. Build on macOS arm64.');
}

const renderer = { bundleCEF: false, defaultRenderer: 'native' as const };
export default {
  app: { name: 'Kubus', identifier: 'io.github.flosch62.kubus', version, urlSchemes: ['kubus'] },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'dist/main.js', external: ['bufferutil', 'utf-8-validate'], define: { 'process.env.NODE_ENV': '"production"' } },
    copy: {
      '../client/dist': 'client',
      '../server/assets/helm-engine.wasm.gz': 'helm-engine.wasm.gz',
      'dist/preload.js': 'preload.js',
    },
    mac: { ...renderer, icons: 'assets/icon.iconset', codesign: false, notarize: false },
    linux: { ...renderer, icon: 'assets/icon.png' },
    // Windows ICO generation accepts PNGs up to 256x256.
    win: { ...renderer, icon: 'assets/icon.iconset/icon_256x256.png' },
  },
  scripts: { postBuild: 'scripts/finalize.ts' },
  runtime: { exitOnLastWindowClosed: false },
  release: { baseUrl: 'https://github.com/FloSch62/Kubus/releases/latest/download', generatePatch: true },
} satisfies ElectrobunConfig;
