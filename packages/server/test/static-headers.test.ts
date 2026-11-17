import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHeadersFile } from '../src/static-headers.ts';

describe('the release _headers file', () => {
  it('gives the Node target the same page headers Cloudflare uses', () => {
    const h = parseHeadersFile(readFileSync(new URL('../../web/static/_headers', import.meta.url), 'utf8'));
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h['Content-Security-Policy']).toMatch(/script-src 'self' 'wasm-unsafe-eval';/);
    expect(h['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/);
    expect(Object.keys(h)).toHaveLength(6);
  });
});
