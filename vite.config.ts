import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { createProxyHandler } from './server/proxy.mjs';

/**
 * Mounts the same backend proxy the standalone server uses, so `vite dev`
 * follows the production request path (browser -> console backend -> target).
 */
function consoleBackend(): Plugin {
  const handler = createProxyHandler();
  return {
    name: 'glaux-console-backend',
    configureServer(server) {
      server.middlewares.use(handler as unknown as Connect.NextHandleFunction);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler as unknown as Connect.NextHandleFunction);
    },
  };
}

export default defineConfig({
  // Relative asset URLs so the same bundle works standalone and embedded
  // under an arbitrary mount path (glaux serves it at /console).
  base: './',
  plugins: [react(), consoleBackend()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.mjs'],
    css: false,
  },
});
