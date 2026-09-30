import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import path from 'node:path';

const alias = {
  '@': path.resolve(__dirname, 'src'),
  '@shared': path.resolve(__dirname, 'src/shared'),
};

export default defineConfig({
  resolve: { alias },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron', 'ssh2', 'electron-store', 'cpu-features', /^node:/],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload/index.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron', /^node:/],
            },
          },
        },
      },
      renderer: {},
    }),
    renderer(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5178,
    strictPort: true,
  },
});
