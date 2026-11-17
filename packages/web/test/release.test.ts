import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, utf8ToBytes } from '@coded-ballot/core';
import { compareRelease } from '../pages/shared/release.ts';

const page = '<script type="module" src="../assets/vote-1.js"></script><link rel="stylesheet" href="../assets/style-1.css"><a href="../check/">x</a>';
const files: Record<string, string> = { 'vote/index.html': page, 'assets/vote-1.js': 'console.log(1)', 'assets/style-1.css': 'body{}' };
const manifest = { version: '0.1.0', files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256Hex(utf8ToBytes(v))])) };

function serve(over: Record<string, string> = {}) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname.slice(1);
    const body = over[path] ?? files[path];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  });
}

describe('compareRelease', () => {
  it('passes when every file matches', async () => {
    serve();
    const r = await compareRelease('https://ballot.example.org/vote/', manifest);
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.path).sort()).toEqual(['assets/style-1.css', 'assets/vote-1.js', 'vote/index.html']);
  });

  it('fails when a script is changed', async () => {
    serve({ 'assets/vote-1.js': 'steal()' });
    expect((await compareRelease('https://ballot.example.org', manifest)).ok).toBe(false);
  });

  it('fails when the page loads a script that is not in the release', async () => {
    serve({ 'vote/index.html': page + '<script src="../assets/extra.js"></script>', 'assets/extra.js': '' });
    const r = await compareRelease('https://ballot.example.org', manifest);
    expect(r.ok).toBe(false);
    expect(r.files.find((f) => f.path === 'assets/extra.js')?.ok).toBe(false);
  });
});
