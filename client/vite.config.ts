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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/monaco-editor')) return 'monaco';
          if (
            id.includes('node_modules/@mui/material') ||
            id.includes('node_modules/@mui/icons-material') ||
            id.includes('node_modules/@mui/x-data-grid') ||
            id.includes('node_modules/@mui/x-charts')
          ) {
            return 'mui';
          }
        },
      },
    },
  },
});
