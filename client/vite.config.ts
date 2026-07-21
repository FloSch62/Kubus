import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Earlier groups win. The preload-helper and react groups exist so
          // later groups' recursive dependency inclusion can never swallow
          // them — the helper landing inside the monaco chunk used to drag
          // all 4 MB of monaco into the first paint via the entry's static
          // import of the helper.
          groups: [
            { name: 'preload-helper', test: /vite[\\/]preload-helper/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // Self-contained; recursion off so it can only ever contain
            // monaco-editor modules.
            {
              name: 'monaco',
              test: /node_modules[\\/]monaco-editor[\\/]/,
              includeDependenciesRecursively: false,
            },
            // x-charts, x-data-grid and icons-material stay out of this eager
            // group: the former two are only reachable from lazy chunks, and
            // icons ride with whichever chunk uses them — icons used only by
            // lazy routes then stay off the first paint instead of being
            // packed into the eager mui chunk. Dependencies (emotion,
            // @mui/system, …) ride along — they are needed at first paint
            // anyway, and leaving them ungrouped lets the bundler pack them
            // into arbitrary lazy chunks, which then become eagerly loaded
            // through the shared-module edge.
            { name: 'mui', test: /node_modules[\\/]@mui[\\/]material[\\/]/ },
          ],
        },
      },
    },
  },
});
