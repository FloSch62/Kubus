import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  esbuild: {
    target: 'esnext',
  },
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
        manualChunks: {
          monaco: ['monaco-editor'],
          mui: ['@mui/material', '@mui/icons-material', '@mui/x-data-grid', '@mui/x-charts'],
        },
      },
    },
  },
});
