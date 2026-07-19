import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The shared workspace package compiles to CommonJS and is symlinked outside
    // node_modules, so it must be explicitly included in the CJS transform for its
    // runtime exports (e.g. DEFAULT_SNAPSHOT_CATEGORY) to resolve.
    commonjsOptions: {
      include: [/packages[\\/]shared/, /node_modules/],
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3003',
        ws: true,
      },
    },
  },
});
