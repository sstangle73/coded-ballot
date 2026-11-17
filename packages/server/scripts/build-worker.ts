// Bundle the Workers target to dist/worker.js (what the tests load into Miniflare; wrangler bundles its own on deploy).
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../src/targets/worker.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: new URL('../dist/worker.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'warning',
});
console.log('built dist/worker.js');
