import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'pages');
export default defineConfig({
  root,
  base: './',
  // pages/public is the public results page, not Vite's static folder
  publicDir: resolve(import.meta.dirname, 'static'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        vote: resolve(root, 'vote/index.html'),
        teller: resolve(root, 'teller/index.html'),
        public: resolve(root, 'public/index.html'),
        check: resolve(root, 'check/index.html'),
      },
    },
  },
  test: { root: import.meta.dirname, include: ['test/**/*.test.ts'] },
});
